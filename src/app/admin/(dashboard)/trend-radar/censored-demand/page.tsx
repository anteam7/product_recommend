import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

interface CorrectionRow {
  product_id: string
  raw_final_score: number
  correction_factor: number
  censored_fraction: number
  goods_no: string | null
  method: string | null
  updated_at: string | null
  corrected_final_score: number
}

interface ProductRow {
  id: string
  canonical_name: string
  category_top: string
}

interface StockoutIntervalRow {
  goods_no: string
  status: string
  started_at: string
  ended_at: string
  duration_days: number
  is_ongoing: boolean
}

interface GgsanRow {
  goods_no: string
  title: string
}

async function fetchData() {
  const sb = createAdminClient()

  // 보정 데이터 (view 가 아직 적용 안 됐다면 빈 배열로 fallback)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: corrections, error: corrErr } = await (sb as any)
    .from('jimscanner_censored_corrections')
    .select('*')
    .order('corrected_final_score', { ascending: false })
    .limit(500)

  if (corrErr) {
    return {
      rows: [] as Array<CorrectionRow & ProductRow & { stockout_intervals: StockoutIntervalRow[]; ggsan_title: string | null }>,
      migrationApplied: false,
      kpis: { total: 0, corrected: 0, avgLift: 0, maxLift: 0 },
    }
  }

  const correctionRows: CorrectionRow[] = (corrections ?? []).map((c: any) => ({
    product_id: c.product_id,
    raw_final_score: Number(c.raw_final_score ?? 0),
    correction_factor: Number(c.correction_factor ?? 1),
    censored_fraction: Number(c.censored_fraction ?? 0),
    goods_no: c.goods_no ?? null,
    method: c.method ?? null,
    updated_at: c.updated_at ?? null,
    corrected_final_score: Number(c.corrected_final_score ?? c.raw_final_score ?? 0),
  }))

  const productIds = correctionRows.map((r) => r.product_id)
  const goodsNos = correctionRows.map((r) => r.goods_no).filter((g): g is string => !!g)

  const [{ data: products }, { data: intervals }, { data: ggsanProducts }] = await Promise.all([
    productIds.length === 0
      ? Promise.resolve({ data: [] })
      : sb
          .from('jimscanner_trends_products')
          .select('id, canonical_name, category_top')
          .in('id', productIds),
    goodsNos.length === 0
      ? Promise.resolve({ data: [] })
      : // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (sb as any)
          .from('jimscanner_stockout_intervals')
          .select('goods_no, status, started_at, ended_at, duration_days, is_ongoing')
          .in('goods_no', goodsNos)
          .order('started_at', { ascending: false }),
    goodsNos.length === 0
      ? Promise.resolve({ data: [] })
      : sb.from('jimscanner_ggsan_products').select('goods_no, title').in('goods_no', goodsNos),
  ])

  const prodById = new Map(((products ?? []) as ProductRow[]).map((p) => [p.id, p]))
  const ggsanById = new Map(((ggsanProducts ?? []) as GgsanRow[]).map((g) => [g.goods_no, g]))

  const intervalsByGoodsNo = new Map<string, StockoutIntervalRow[]>()
  for (const i of (intervals ?? []) as StockoutIntervalRow[]) {
    if (!intervalsByGoodsNo.has(i.goods_no)) intervalsByGoodsNo.set(i.goods_no, [])
    intervalsByGoodsNo.get(i.goods_no)!.push(i)
  }

  const merged = correctionRows
    .map((c) => {
      const p = prodById.get(c.product_id)
      if (!p) return null
      return {
        ...c,
        ...p,
        ggsan_title: c.goods_no ? ggsanById.get(c.goods_no)?.title ?? null : null,
        stockout_intervals: c.goods_no ? intervalsByGoodsNo.get(c.goods_no) ?? [] : [],
      }
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)

  const correctedCount = merged.filter((r) => r.correction_factor > 1.01).length
  const lifts = merged.filter((r) => r.correction_factor > 1.01).map((r) => r.correction_factor)
  const avgLift = lifts.length === 0 ? 0 : lifts.reduce((a, b) => a + b, 0) / lifts.length
  const maxLift = lifts.length === 0 ? 0 : Math.max(...lifts)

  return {
    rows: merged,
    migrationApplied: true,
    kpis: { total: merged.length, corrected: correctedCount, avgLift, maxLift },
  }
}

function formatPct(x: number) {
  return `${(x * 100).toFixed(1)}%`
}

function formatLift(x: number) {
  if (!Number.isFinite(x) || x <= 0) return '—'
  return `×${x.toFixed(2)}`
}

function formatDate(iso: string | null) {
  if (!iso) return '—'
  return new Date(iso).toISOString().slice(0, 10)
}

// 간단한 갠트차트 (인라인 SVG, 30일 window)
function StockoutGantt({ intervals }: { intervals: StockoutIntervalRow[] }) {
  if (intervals.length === 0) {
    return <span className="text-xs text-gray-400">품절 이력 없음</span>
  }
  const now = Date.now()
  const windowMs = 30 * 86400_000
  const winStart = now - windowMs
  const width = 240
  const height = 14

  const bars = intervals
    .map((i) => {
      const s = Math.max(new Date(i.started_at).getTime(), winStart)
      const e = Math.min(new Date(i.ended_at).getTime(), now)
      if (e <= s) return null
      const x = ((s - winStart) / windowMs) * width
      const w = Math.max(((e - s) / windowMs) * width, 1)
      return { x, w, status: i.status, ongoing: i.is_ongoing }
    })
    .filter((b): b is NonNullable<typeof b> => b !== null)

  return (
    <svg width={width} height={height} className="inline-block align-middle">
      <rect x={0} y={0} width={width} height={height} fill="#f3f4f6" />
      {bars.map((b, idx) => (
        <rect
          key={idx}
          x={b.x}
          y={1}
          width={b.w}
          height={height - 2}
          fill={b.status === 'removed' ? '#9ca3af' : b.ongoing ? '#ef4444' : '#fb923c'}
        >
          <title>
            {b.status} · {b.w.toFixed(1)}px
          </title>
        </rect>
      ))}
    </svg>
  )
}

export default async function CensoredDemandPage() {
  const { rows, migrationApplied, kpis } = await fetchData()

  // lift Top-N (correction_factor 큰 순), 그리고 raw vs corrected 차이가 큰 SKU
  const topByLift = [...rows]
    .filter((r) => r.correction_factor > 1.01)
    .sort((a, b) => b.correction_factor - a.correction_factor)
    .slice(0, 30)
  const topByCorrectedScore = [...rows]
    .sort((a, b) => b.corrected_final_score - a.corrected_final_score)
    .slice(0, 30)

  return (
    <div className="space-y-6 p-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-bold">품절 보정 수요 복원</h1>
        <p className="text-sm text-gray-500">
          ggsan 도매가 품절·차단된 구간 동안 억눌린 수요를 Kaplan-Meier 스타일로 보정합니다.{' '}
          <code className="text-xs">corrected = raw × factor</code>,{' '}
          <code className="text-xs">factor = 1 / max(1 − censored_fraction, 0.1)</code>
        </p>
      </header>

      {!migrationApplied && (
        <div className="rounded border border-amber-300 bg-amber-50 p-4 text-sm text-amber-800">
          마이그레이션 <code>supabase/censored_demand.sql</code> 아직 미적용. DDL 적용 후{' '}
          <code>node --env-file=.env.local scripts/recompute-censored-scores.mjs</code> 실행이 필요합니다.
        </div>
      )}

      <section className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <KpiCard label="보정 대상 SKU" value={kpis.total} hint="최근 점수 기준" />
        <KpiCard
          label="실보정 (factor>1)"
          value={kpis.corrected}
          hint={`${kpis.total > 0 ? Math.round((kpis.corrected / kpis.total) * 100) : 0}%`}
        />
        <KpiCard label="평균 lift" value={kpis.avgLift > 0 ? `×${kpis.avgLift.toFixed(2)}` : '—'} hint="보정된 SKU 중" />
        <KpiCard label="최대 lift" value={kpis.maxLift > 0 ? `×${kpis.maxLift.toFixed(2)}` : '—'} hint="가려졌던 핫템 후보" />
      </section>

      {/* 진짜 핫템 후보 — lift 큰 순 */}
      <section className="space-y-2">
        <h2 className="text-lg font-semibold">🔥 가려진 핫템 후보 (lift Top 30)</h2>
        <p className="text-xs text-gray-500">
          품절 때문에 raw score 가 식어 보였지만 보정 후 튀어오르는 상품. 핀 디스카드/재핀 의사결정의 1차 신호.
        </p>
        <div className="overflow-x-auto rounded border border-gray-200">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-left text-xs uppercase text-gray-500">
              <tr>
                <th className="px-3 py-2">상품</th>
                <th className="px-3 py-2">카테고리</th>
                <th className="px-3 py-2 text-right">raw</th>
                <th className="px-3 py-2 text-right">factor</th>
                <th className="px-3 py-2 text-right">corrected</th>
                <th className="px-3 py-2 text-right">품절 비율</th>
                <th className="px-3 py-2">품절 갠트 (30d)</th>
                <th className="px-3 py-2">ggsan</th>
              </tr>
            </thead>
            <tbody>
              {topByLift.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-3 py-6 text-center text-gray-400">
                    아직 보정된 SKU 가 없습니다. 야간 cron 실행 후 다시 확인하세요.
                  </td>
                </tr>
              )}
              {topByLift.map((r) => (
                <tr key={r.product_id} className="border-t border-gray-100">
                  <td className="px-3 py-2">
                    <Link href={`/admin/trend-radar/products/${r.product_id}`} className="text-blue-600 hover:underline">
                      {r.canonical_name}
                    </Link>
                  </td>
                  <td className="px-3 py-2 text-gray-600">{r.category_top}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{r.raw_final_score.toFixed(1)}</td>
                  <td className="px-3 py-2 text-right tabular-nums font-semibold text-red-600">
                    {formatLift(r.correction_factor)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums font-semibold">
                    {r.corrected_final_score.toFixed(1)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatPct(r.censored_fraction)}</td>
                  <td className="px-3 py-2">
                    <StockoutGantt intervals={r.stockout_intervals} />
                  </td>
                  <td className="px-3 py-2 text-xs text-gray-500">
                    {r.goods_no ? (
                      <a
                        href={`https://www.ggsan.com/goods/goods_view.php?goodsNo=${r.goods_no}`}
                        target="_blank"
                        rel="noreferrer"
                        className="hover:underline"
                      >
                        {r.goods_no}
                      </a>
                    ) : (
                      '—'
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* 전체 ranking — corrected score 기준 */}
      <section className="space-y-2">
        <h2 className="text-lg font-semibold">📊 보정 score Top 30</h2>
        <p className="text-xs text-gray-500">
          보정 적용 후 최종 점수 기준 ranking. factor=1.00 인 SKU 는 품절 보정 영향 없음(=원본 점수).
        </p>
        <div className="overflow-x-auto rounded border border-gray-200">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-left text-xs uppercase text-gray-500">
              <tr>
                <th className="px-3 py-2">#</th>
                <th className="px-3 py-2">상품</th>
                <th className="px-3 py-2 text-right">raw</th>
                <th className="px-3 py-2 text-right">factor</th>
                <th className="px-3 py-2 text-right">corrected</th>
                <th className="px-3 py-2 text-right">Δ</th>
                <th className="px-3 py-2">갱신</th>
              </tr>
            </thead>
            <tbody>
              {topByCorrectedScore.map((r, idx) => (
                <tr key={r.product_id} className="border-t border-gray-100">
                  <td className="px-3 py-2 text-gray-400 tabular-nums">{idx + 1}</td>
                  <td className="px-3 py-2">
                    <Link href={`/admin/trend-radar/products/${r.product_id}`} className="text-blue-600 hover:underline">
                      {r.canonical_name}
                    </Link>
                    <span className="ml-2 text-xs text-gray-400">{r.category_top}</span>
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-gray-500">{r.raw_final_score.toFixed(1)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatLift(r.correction_factor)}</td>
                  <td className="px-3 py-2 text-right tabular-nums font-semibold">
                    {r.corrected_final_score.toFixed(1)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-emerald-600">
                    {r.corrected_final_score > r.raw_final_score
                      ? `+${(r.corrected_final_score - r.raw_final_score).toFixed(1)}`
                      : '—'}
                  </td>
                  <td className="px-3 py-2 text-xs text-gray-500">{formatDate(r.updated_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  )
}

function KpiCard({ label, value, hint }: { label: string; value: number | string; hint?: string }) {
  return (
    <div className="rounded border border-gray-200 bg-white p-4">
      <div className="text-xs uppercase tracking-wide text-gray-500">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
      {hint && <div className="mt-1 text-xs text-gray-400">{hint}</div>}
    </div>
  )
}
