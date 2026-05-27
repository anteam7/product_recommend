import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

interface BurnRow {
  goods_no: string
  title: string
  cate_label: string | null
  price_krw: number | null
  image_url: string | null
  detail_url: string | null
  is_imminent: boolean
  is_published: boolean
  stock_today: number | null
  stock_yesterday: number | null
  burn_today: number | null
  burn_ma7: number | null
  burn_mean90: number | null
  burn_std90: number | null
  z90: number | null
  dos_days: number | null
  snapshot_count: number
  last_snapshot_at: string | null
  bucket: 'hot' | 'resupply' | 'dead' | 'normal'
}

interface LastRun {
  started_at: string | null
  fetched_count: number | null
  inserted_count: number | null
  status: string | null
  error_message: string | null
}

async function fetchBurn(zThreshold: number): Promise<BurnRow[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sb = createAdminClient() as any
  const { data, error } = await sb.rpc('jimscanner_ggsan_stock_burn', {
    days_window: 90,
    z_threshold: zThreshold,
  })
  if (error) {
    console.error('[stock-burn] rpc error', error)
    return []
  }
  return (data ?? []) as BurnRow[]
}

async function fetchLastRun(): Promise<LastRun | null> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sb = createAdminClient() as any
  const { data } = await sb
    .from('jimscanner_trends_runs')
    .select('started_at, fetched_count, inserted_count, status, error_message')
    .eq('source', 'ggsan_stock_snapshot')
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  return (data ?? null) as LastRun | null
}

function fmtNum(n: number | null | undefined, digits = 2): string {
  if (n == null || Number.isNaN(n)) return '—'
  return n.toFixed(digits)
}

function fmtPct(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return '—'
  return `${(n * 100).toFixed(1)}%`
}

export default async function StockBurnPage({
  searchParams,
}: {
  searchParams: Promise<{ z?: string }>
}) {
  const sp = await searchParams
  const z = Math.max(0.5, Math.min(5, parseFloat(sp.z ?? '2') || 2))

  const [rows, lastRun] = await Promise.all([fetchBurn(z), fetchLastRun()])

  const hot = rows.filter((r) => r.bucket === 'hot')
  const resupply = rows.filter((r) => r.bucket === 'resupply')
  const dead = rows
    .filter((r) => r.bucket === 'dead')
    .sort((a, b) => (a.burn_ma7 ?? 0) - (b.burn_ma7 ?? 0))
    .slice(0, 50)

  const snapshotsTotal = rows.reduce((acc, r) => acc + (r.snapshot_count ?? 0), 0)
  const skuTracked = rows.length

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold">도매 재고 Burn-Rate 보드</h1>
          <p className="text-sm text-gray-500 mt-1">
            ggsan SKU 일일 재고 소진속도 · pre-trend leading indicator · z-score &gt; {z} 기준
          </p>
        </div>
        <div className="flex items-center gap-2 text-xs">
          <span className="text-gray-500">z 임계값:</span>
          {[1.5, 2, 2.5, 3].map((v) => (
            <Link
              key={v}
              href={`/admin/trend-radar/stock-burn?z=${v}`}
              className={`px-2 py-1 rounded ${
                Math.abs(z - v) < 0.01
                  ? 'bg-black text-white font-semibold'
                  : 'border border-gray-200 text-gray-600 hover:bg-gray-50'
              }`}
            >
              {v}
            </Link>
          ))}
        </div>
      </header>

      {/* 메타 — 마지막 cron */}
      <div className="rounded border border-gray-200 px-4 py-2 text-xs text-gray-600 flex justify-between flex-wrap gap-2">
        {lastRun ? (
          <span>
            마지막 스냅샷:{' '}
            <strong>{lastRun.started_at?.slice(0, 16)?.replace('T', ' ')}</strong>
            {' · '}status={lastRun.status}
            {' · '}fetched={lastRun.fetched_count} inserted={lastRun.inserted_count}
            {lastRun.error_message && (
              <span className="ml-2 text-red-600">err: {lastRun.error_message}</span>
            )}
          </span>
        ) : (
          <span className="text-gray-400">
            아직 ggsan-stock-snapshot cron 실행 이력 없음. 매일 KST 02:30 1회 실행 권장.
          </span>
        )}
        <span className="text-gray-400">
          tracked SKUs: <strong>{skuTracked.toLocaleString()}</strong> · snapshots:{' '}
          <strong>{snapshotsTotal.toLocaleString()}</strong>
        </span>
      </div>

      {/* KPI 3종 */}
      <section className="grid grid-cols-3 gap-4">
        <KpiCard
          label="🔥 핫 큐 (미발행 + z>2)"
          value={hot.length}
          hint="즉시 발행 — 다른 셀러가 사재기 시작"
          tone="hot"
        />
        <KpiCard
          label="📦 선매입 알람 (발행+z>2)"
          value={resupply.length}
          hint="재고 고갈 직전 — 우리도 확보"
          tone="resupply"
        />
        <KpiCard
          label="💤 손절 큐 (정체)"
          value={dead.length}
          hint="14일+ 변동 없음 — 정리"
          tone="dead"
        />
      </section>

      {/* 핫 큐 */}
      <BurnTable
        title="🔥 핫 큐 — 미발행 + burn z-score > 임계값"
        emptyHint="아직 z-score 가 임계값을 넘은 미발행 SKU 가 없습니다. 데이터가 14일 이상 누적되어야 z-score 가 의미를 가집니다."
        rows={hot}
        tone="hot"
      />

      {/* 선매입 알람 */}
      <BurnTable
        title="📦 선매입 알람 — 발행 중 + burn z-score > 임계값"
        emptyHint="발행 중 SKU 중 재고 고갈 가속 신호 없음."
        rows={resupply}
        tone="resupply"
      />

      {/* 손절 큐 */}
      <BurnTable
        title="💤 손절 큐 — 14일+ 누적, burn_ma7 ≤ 0, 시장 식음"
        emptyHint="정체 SKU 없음."
        rows={dead}
        tone="dead"
      />

      <div className="text-xs text-gray-500 pt-4 border-t border-gray-200">
        <p>
          <strong>burn_rate</strong> = (전일재고 − 오늘재고) / 전일재고. 0/1 binary 매핑에서는
          <code className="px-1 bg-gray-100 rounded mx-1">1→0</code> 일 때 burn=1.0 (완전 소진).
        </p>
        <p>
          <strong>z90</strong> = (오늘 burn − 90일 평균) / 90일 표준편차. 같은 SKU 의 자체 분포 대비
          이상치를 본다.
        </p>
        <p>
          <strong>DoS</strong> (days-of-supply) = 잔여재고 ÷ 일평균 소진수량(7d).
        </p>
        <p>
          데이터 누적: <code>POST /api/cron/ggsan-stock-snapshot</code> · run-crons.mjs 에 포함되어
          매일 호출.
        </p>
      </div>
    </div>
  )
}

function KpiCard({
  label,
  value,
  hint,
  tone,
}: {
  label: string
  value: number
  hint: string
  tone: 'hot' | 'resupply' | 'dead'
}) {
  const border =
    tone === 'hot'
      ? 'border-red-300 bg-red-50/40'
      : tone === 'resupply'
        ? 'border-amber-300 bg-amber-50/40'
        : 'border-gray-300 bg-gray-50/40'
  return (
    <div className={`rounded border ${border} p-4`}>
      <div className="text-xs text-gray-600">{label}</div>
      <div className="text-3xl font-bold mt-1">{value.toLocaleString()}</div>
      <div className="text-xs text-gray-500 mt-1">{hint}</div>
    </div>
  )
}

function BurnTable({
  title,
  emptyHint,
  rows,
  tone,
}: {
  title: string
  emptyHint: string
  rows: BurnRow[]
  tone: 'hot' | 'resupply' | 'dead'
}) {
  const accent =
    tone === 'hot'
      ? 'border-red-200'
      : tone === 'resupply'
        ? 'border-amber-200'
        : 'border-gray-200'

  return (
    <section className={`rounded border ${accent}`}>
      <h2 className="px-4 py-2 text-sm font-semibold border-b border-gray-100 bg-white">
        {title}
        <span className="ml-2 text-xs text-gray-500 font-normal">{rows.length}건</span>
      </h2>
      {rows.length === 0 ? (
        <div className="px-4 py-8 text-center text-sm text-gray-500">{emptyHint}</div>
      ) : (
        <div className="divide-y divide-gray-100">
          <div className="grid grid-cols-12 px-4 py-2 text-xs text-gray-500 bg-gray-50">
            <div className="col-span-5">상품</div>
            <div className="col-span-1 text-right">오늘</div>
            <div className="col-span-1 text-right">전일</div>
            <div className="col-span-1 text-right">burn</div>
            <div className="col-span-1 text-right">MA7</div>
            <div className="col-span-1 text-right">z90</div>
            <div className="col-span-1 text-right">DoS</div>
            <div className="col-span-1 text-right">snap</div>
          </div>
          {rows.slice(0, 100).map((r) => (
            <a
              key={r.goods_no}
              href={r.detail_url ?? `https://www.ggsan.com/goods/goods_view.php?goodsNo=${r.goods_no}`}
              target="_blank"
              rel="noopener"
              className="grid grid-cols-12 px-4 py-2 text-sm hover:bg-gray-50"
            >
              <div className="col-span-5 flex items-center gap-2 min-w-0">
                {r.image_url && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={r.image_url}
                    alt=""
                    loading="lazy"
                    className="w-10 h-10 object-cover rounded bg-gray-100 flex-shrink-0"
                  />
                )}
                <div className="min-w-0">
                  <div className="truncate font-medium" title={r.title}>
                    {r.title}
                  </div>
                  <div className="text-xs text-gray-500 truncate">
                    {r.cate_label ?? '-'}
                    {r.price_krw ? ` · ${r.price_krw.toLocaleString()}원` : ''}
                    {r.is_imminent ? ' · 임박' : ''}
                    {r.is_published ? ' · 발행중' : ' · 미발행'}
                  </div>
                </div>
              </div>
              <div className="col-span-1 text-right font-mono">{r.stock_today ?? '—'}</div>
              <div className="col-span-1 text-right font-mono text-gray-500">
                {r.stock_yesterday ?? '—'}
              </div>
              <div className="col-span-1 text-right font-mono">{fmtPct(r.burn_today)}</div>
              <div className="col-span-1 text-right font-mono text-gray-600">
                {fmtPct(r.burn_ma7)}
              </div>
              <div className="col-span-1 text-right font-mono font-semibold">
                {fmtNum(r.z90)}
              </div>
              <div className="col-span-1 text-right font-mono text-gray-600">
                {fmtNum(r.dos_days, 1)}
              </div>
              <div className="col-span-1 text-right font-mono text-gray-400">
                {r.snapshot_count}
              </div>
            </a>
          ))}
        </div>
      )}
    </section>
  )
}
