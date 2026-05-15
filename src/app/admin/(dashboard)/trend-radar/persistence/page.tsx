import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

type SortMode = 'reproducibility' | 'stable_rising' | 'noise_spike'

const SORT_LABEL: Record<SortMode, string> = {
  reproducibility: '진성도순 (Persistence × Streak)',
  stable_rising: '안정 + 상승 (streak ≥ 7 AND Δ>0)',
  noise_spike: '노이즈 스파이크 (1-day-only)',
}

interface PersistenceRow {
  product_id: string
  days_seen: number
  persistence_days: number
  streak_days: number
  mean_score: number | null
  std_score: number | null
  cv: number | null
  max_score: number | null
  min_score: number | null
  direction_net: number
  last_at: string
  reproducibility_score: number | null
}

interface ProductRow {
  id: string
  canonical_name: string
  category_top: string
  alias_count: number
}

async function fetchData(sort: SortMode) {
  const sb = createAdminClient()

  // view 는 마이그레이션 후 생성됨 — supabase-js 의 typed builder 가 모르는 테이블이라 `as any`.
  const { data: rowsRaw } = await (sb as any)
    .from('jimscanner_trends_persistence_v')
    .select('*')
    .limit(2000)

  const rows = (rowsRaw ?? []) as PersistenceRow[]
  if (rows.length === 0) {
    return { rows: [] as Array<PersistenceRow & { product: ProductRow | null }>, kpis: emptyKpis() }
  }

  const productIds = rows.map((r) => r.product_id)
  const { data: products } = await sb
    .from('jimscanner_trends_products')
    .select('id, canonical_name, category_top, alias_count')
    .in('id', productIds)

  const prodMap = new Map<string, ProductRow>()
  for (const p of (products ?? []) as ProductRow[]) prodMap.set(p.id, p)

  const merged = rows.map((r) => ({ ...r, product: prodMap.get(r.product_id) ?? null }))

  const sorted = (() => {
    if (sort === 'stable_rising') {
      return merged
        .filter((r) => r.streak_days >= 7 && r.direction_net > 0)
        .sort((a, b) => (b.reproducibility_score ?? 0) - (a.reproducibility_score ?? 0))
    }
    if (sort === 'noise_spike') {
      // 1-day-only: days_seen <=2 (실제로 1일만 노출되었거나 짧은 등장)
      // AND persistence_days <= 1 (1번만 Top-K 진입)
      return merged
        .filter((r) => r.days_seen <= 2 && r.persistence_days <= 1)
        .sort((a, b) => (b.max_score ?? 0) - (a.max_score ?? 0))
    }
    return merged.sort(
      (a, b) => (b.reproducibility_score ?? 0) - (a.reproducibility_score ?? 0),
    )
  })()

  const kpis = {
    total: merged.length,
    stableRising: merged.filter((r) => r.streak_days >= 7 && r.direction_net > 0).length,
    noiseSpike: merged.filter((r) => r.days_seen <= 2 && r.persistence_days <= 1).length,
    high: merged.filter((r) => (r.reproducibility_score ?? 0) >= 60).length,
  }

  return { rows: sorted, kpis }
}

function emptyKpis() {
  return { total: 0, stableRising: 0, noiseSpike: 0, high: 0 }
}

function PersistenceBadge({ r }: { r: PersistenceRow }) {
  const days = r.persistence_days
  const streak = r.streak_days
  const color =
    streak >= 7 ? 'bg-green-100 text-green-800'
    : days >= 10 ? 'bg-blue-100 text-blue-800'
    : days <= 1 ? 'bg-red-100 text-red-700'
    : 'bg-gray-100 text-gray-700'
  const dot = streak >= 7 ? '🟢' : days >= 10 ? '🔵' : days <= 1 ? '🔴' : '⚪️'
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-mono ${color}`}>
      {dot} {days}/30일 · {streak}연속
    </span>
  )
}

function DirectionArrow({ net }: { net: number }) {
  if (net > 2) return <span className="text-green-600 font-mono">↑↑</span>
  if (net > 0) return <span className="text-green-600 font-mono">↑</span>
  if (net < -2) return <span className="text-red-600 font-mono">↓↓</span>
  if (net < 0) return <span className="text-red-600 font-mono">↓</span>
  return <span className="text-gray-400 font-mono">·</span>
}

export default async function PersistencePage({
  searchParams,
}: {
  searchParams: Promise<{ sort?: string }>
}) {
  const sp = await searchParams
  const sort: SortMode = (
    ['reproducibility', 'stable_rising', 'noise_spike'].includes(sp.sort ?? '')
      ? (sp.sort as SortMode)
      : 'reproducibility'
  )

  const { rows, kpis } = await fetchData(sort)

  return (
    <div className="space-y-6 p-6">
      <header>
        <h1 className="text-2xl font-bold">⏱ 시간축 Reproducibility</h1>
        <p className="text-sm text-gray-500 mt-1">
          최근 30일 final_score 시계열로 일회성 스파이크 vs 진성 트렌드 분리.{' '}
          <span className="text-gray-400">
            persistence = Top-K 진입 일수 · streak = 연속 등장 · CV = 변동성 · Δ부호합 = 방향성
          </span>
        </p>
      </header>

      <section className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <KpiCard label="대상 상품" value={kpis.total} hint="30일 내 1회 이상 측정" />
        <KpiCard label="안정+상승" value={kpis.stableRising} hint="streak≥7 ∧ Δ>0" />
        <KpiCard label="노이즈 스파이크" value={kpis.noiseSpike} hint="≤2일 ∧ 진입≤1" />
        <KpiCard label="고진성도 (≥60)" value={kpis.high} hint="reproducibility_score" />
      </section>

      <nav className="flex gap-2 border-b border-gray-200 flex-wrap">
        {(Object.keys(SORT_LABEL) as SortMode[]).map((s) => (
          <Link
            key={s}
            href={`/admin/trend-radar/persistence?sort=${s}`}
            className={`px-3 py-2 text-sm ${
              sort === s
                ? 'border-b-2 border-black font-semibold text-black'
                : 'text-gray-500 hover:text-black'
            }`}
          >
            {SORT_LABEL[s]}
          </Link>
        ))}
      </nav>

      {rows.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500">
          <p className="text-base font-medium">아직 시계열 데이터가 부족합니다</p>
          <p className="text-sm mt-2">
            최소 2~3일 누적 후에 reproducibility 가 의미를 가집니다.
            <br />
            jimscanner_trends_scores 가 매일 재계산되어야 합니다 (cron: KST 06:00).
          </p>
          <p className="text-xs mt-4 text-gray-400">
            View: <code className="px-1 bg-gray-100 rounded">jimscanner_trends_persistence_v</code>
          </p>
        </div>
      ) : (
        <section>
          <div className="grid gap-2">
            <div className="grid grid-cols-12 text-xs text-gray-500 px-3 py-1">
              <div className="col-span-1">#</div>
              <div className="col-span-4">상품명</div>
              <div className="col-span-2">진성도</div>
              <div className="col-span-1 text-right">repro</div>
              <div className="col-span-1 text-right">평균</div>
              <div className="col-span-1 text-right">CV</div>
              <div className="col-span-1 text-right">Δ방향</div>
              <div className="col-span-1 text-right">측정일</div>
            </div>
            {rows.slice(0, 100).map((r, i) => (
              <Link
                key={r.product_id}
                href={`/admin/trend-radar/products/${r.product_id}`}
                className="grid grid-cols-12 px-3 py-2 rounded border border-gray-200 hover:bg-gray-50 transition-colors"
              >
                <div className="col-span-1 text-gray-400 font-mono">{i + 1}</div>
                <div className="col-span-4">
                  <div className="font-medium truncate">
                    {r.product?.canonical_name ?? <span className="text-gray-400 italic">unknown</span>}
                  </div>
                  <div className="text-xs text-gray-500">{r.product?.category_top ?? '—'}</div>
                </div>
                <div className="col-span-2">
                  <PersistenceBadge r={r} />
                </div>
                <div className="col-span-1 text-right font-mono font-bold">
                  {r.reproducibility_score != null ? Number(r.reproducibility_score).toFixed(0) : '—'}
                </div>
                <div className="col-span-1 text-right font-mono text-gray-700">
                  {r.mean_score != null ? Number(r.mean_score).toFixed(0) : '—'}
                </div>
                <div className="col-span-1 text-right font-mono text-gray-600">
                  {r.cv != null ? Number(r.cv).toFixed(2) : '—'}
                </div>
                <div className="col-span-1 text-right">
                  <DirectionArrow net={r.direction_net} />
                </div>
                <div className="col-span-1 text-right text-xs text-gray-400 font-mono">
                  {r.days_seen}d
                </div>
              </Link>
            ))}
          </div>
          {rows.length > 100 && (
            <div className="text-xs text-gray-400 text-center mt-3">
              상위 100개만 표시 (총 {rows.length})
            </div>
          )}
        </section>
      )}

      <section className="rounded border border-gray-200 bg-gray-50 p-4 text-xs text-gray-600">
        <div className="font-semibold mb-1">📐 reproducibility_score 공식</div>
        <code className="block bg-white px-2 py-1 rounded border border-gray-200 text-gray-700">
          0.40·min(persistence/30,1) + 0.30·min(streak/14,1) + 0.20·max(0, 1−CV) + 0.10·(Δnet&gt;0 ? 1 : 0)
        </code>
        <div className="mt-2 text-gray-500">
          현 4점수(trend/commerce/supplier/competition)는 모두 <em>오늘 시점</em> 스냅샷이라
          어제 일회성 뉴스로 튀어오른 노이즈와 14일 누적 진성 시그널을 동일하게 표시한다. 시간축
          reproducibility 가 그 갭을 메운다.
        </div>
      </section>
    </div>
  )
}

function KpiCard({ label, value, hint }: { label: string; value: number; hint: string }) {
  return (
    <div className="rounded border border-gray-200 p-4">
      <div className="text-xs text-gray-500">{label}</div>
      <div className="text-3xl font-bold mt-1">{value.toLocaleString()}</div>
      <div className="text-xs text-gray-400 mt-1">{hint}</div>
    </div>
  )
}
