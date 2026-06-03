import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

// ─────────────────────────────────────────────────────────────
// 재구매 사이클 × 소모성 LTV 발굴 보드
// '단발성 트렌드 가젯' 과 '매달 재주문되는 소모품' 을 분리해,
// 후자를 연간 반복주문 추정치(LTV proxy) 내림차순으로 랭킹한다.
// 데이터 출처: jimscanner_trends_products(consumption_type/replenish_cycle_days)
//             + jimscanner_trends_scores(latest)
// 컬럼 미분류(NULL)면 카테고리 휴리스틱으로 폴백.
// ─────────────────────────────────────────────────────────────

type ConsumptionType = 'consumable' | 'durable'

interface ScoreRow {
  product_id: string
  trend_score: number
  commerce_score: number
  supplier_score: number
  competition_score: number
  final_score: number
  score_components: any
  computed_at: string
}

interface Recurring {
  id: string
  name: string
  category: string
  categoryMid: string | null
  consumptionType: ConsumptionType
  cycleDays: number | null
  qty: number
  reorderFreq: number // 365 / cycle (durable = 1)
  persistence: number // 0..1
  supplierStability: number // 0..1
  annualRecurringOrders: number // LTV proxy
  source: 'classified' | 'heuristic'
  trend: number
  commerce: number
  supplier: number
  final: number
}

// 소모품 키워드 — living/etc 카테고리에서 소모성 판단 폴백용
const CONSUMABLE_HINTS = [
  '세제', '휴지', '물티슈', '면도', '칫솔', '치약', '필터', '심', '리필',
  '기저귀', '비누', '샴푸', '세정', '소독', '방향', '건전지', '배터리',
  '커피', '차', '간식', '사료', '영양', '비타민', '유산균', '콜라겐', '오메가',
]

const HEURISTIC_CYCLE: Record<string, number> = {
  health: 30, // 영양제·건기식 — 한 통 ≈ 한 달
  living: 90, // 생활소모품 평균
  digital: 0, // 내구재
}

function clamp01(n: number) {
  return Math.max(0, Math.min(1, n))
}

// product 분류값(없으면 카테고리 휴리스틱)으로 소비유형/주기 결정
function resolveConsumption(p: any): {
  type: ConsumptionType
  cycle: number | null
  qty: number
  source: 'classified' | 'heuristic'
} {
  const explicit = p?.consumption_type as ConsumptionType | null | undefined
  const qty = Number(p?.typical_purchase_qty) > 0 ? Number(p.typical_purchase_qty) : 1

  if (explicit === 'consumable' || explicit === 'durable') {
    const cycle =
      explicit === 'consumable'
        ? Number(p?.replenish_cycle_days) > 0
          ? Number(p.replenish_cycle_days)
          : HEURISTIC_CYCLE[p?.category_top] || 60
        : null
    return { type: explicit, cycle, qty, source: 'classified' }
  }

  // ── 폴백 휴리스틱 ──
  const cat = String(p?.category_top ?? '').toLowerCase()
  const haystack = `${p?.canonical_name ?? ''} ${p?.category_mid ?? ''}`
  const hinted = CONSUMABLE_HINTS.some((h) => haystack.includes(h))

  if (cat === 'health' || hinted) {
    return { type: 'consumable', cycle: HEURISTIC_CYCLE[cat] || 30, qty, source: 'heuristic' }
  }
  if (cat === 'living') {
    return { type: 'consumable', cycle: HEURISTIC_CYCLE.living, qty, source: 'heuristic' }
  }
  return { type: 'durable', cycle: null, qty, source: 'heuristic' }
}

function computeRecurring(s: ScoreRow, p: any): Recurring {
  const { type, cycle, qty, source } = resolveConsumption(p)

  // 재구매 빈도 = 365 / cycle (내구재 = 연 1회)
  const reorderFreq = type === 'consumable' && cycle && cycle > 0 ? 365 / cycle : 1
  // 수요 지속성: score_components.recurring.persistence 우선, 없으면 trend_score 기반
  const persistRaw = s.score_components?.recurring?.persistence
  const persistence =
    typeof persistRaw === 'number' ? clamp01(persistRaw) : clamp01(s.trend_score / 100)
  const supplierStability = clamp01(s.supplier_score / 100)

  // 연간 반복주문 추정치 = 빈도 × 지속성 × 공급안정성 × 1회수량
  const annualRecurringOrders = reorderFreq * persistence * supplierStability * qty

  return {
    id: s.product_id,
    name: p?.canonical_name ?? '?',
    category: p?.category_top ?? 'all',
    categoryMid: p?.category_mid ?? null,
    consumptionType: type,
    cycleDays: cycle,
    qty,
    reorderFreq,
    persistence,
    supplierStability,
    annualRecurringOrders,
    source,
    trend: s.trend_score,
    commerce: s.commerce_score,
    supplier: s.supplier_score,
    final: s.final_score,
  }
}

async function fetchData() {
  const sb = createAdminClient()

  const { data: scores } = await sb
    .from('jimscanner_trends_scores')
    .select(
      'product_id, trend_score, commerce_score, supplier_score, competition_score, final_score, score_components, computed_at',
    )
    .order('computed_at', { ascending: false })
    .limit(3000)

  const seen = new Set<string>()
  const latest: ScoreRow[] = []
  for (const s of (scores ?? []) as ScoreRow[]) {
    if (seen.has(s.product_id)) continue
    seen.add(s.product_id)
    latest.push(s)
  }

  const ids = latest.map((s) => s.product_id)
  if (ids.length === 0) return { recurring: [], oneoff: [] }

  // 마이그레이션 후 상태 가정 — 컬럼은 `*` 로 받아 누락 시에도 무탈
  const { data: prods } = await (sb as any)
    .from('jimscanner_trends_products')
    .select('*')
    .in('id', ids)
  const byId = new Map((prods ?? []).map((p: any) => [p.id, p]))

  const all = latest.map((s) => computeRecurring(s, byId.get(s.product_id) ?? {}))

  const recurring = all
    .filter((r) => r.consumptionType === 'consumable')
    .sort((a, b) => b.annualRecurringOrders - a.annualRecurringOrders)
  const oneoff = all
    .filter((r) => r.consumptionType === 'durable')
    .sort((a, b) => b.final - a.final)

  return { recurring, oneoff }
}

function CycleBadge({ days }: { days: number | null }) {
  if (!days) return <span className="text-gray-400">—</span>
  const label = days <= 35 ? '월간' : days <= 75 ? '격월' : days <= 120 ? '분기' : '반기+'
  const tone =
    days <= 35
      ? 'bg-emerald-100 text-emerald-800'
      : days <= 75
        ? 'bg-lime-100 text-lime-800'
        : 'bg-amber-100 text-amber-800'
  return (
    <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${tone}`}>
      {label} · {days}일
    </span>
  )
}

function bar(v: number, max: number) {
  return `${Math.min(100, max > 0 ? (v / max) * 100 : 0)}%`
}

export default async function RecurringLtvPage() {
  const { recurring, oneoff } = await fetchData()
  const maxLtv = recurring.length ? recurring[0].annualRecurringOrders : 1

  return (
    <div className="space-y-8 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold">🔁 반복매출 소모품 발굴</h1>
          <p className="mt-1 text-sm text-gray-500">
            재구매 빈도(365/주기) × 수요 지속성 × 공급 안정성 = <b>연간 반복주문 추정치</b> 내림차순.
            1회성 내구재는 아래 디스카운트 섹션으로 분리.
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 underline hover:text-black">
          ← 대시보드
        </Link>
      </header>

      {recurring.length === 0 && oneoff.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500">
          아직 데이터 없음. cron 누적 후 다시 방문.
        </div>
      ) : (
        <>
          <section className="space-y-3">
            <h2 className="text-sm font-semibold text-gray-700">
              반복매출 후보 · 소모품 ({recurring.length})
            </h2>
            <div className="overflow-x-auto rounded border border-gray-200">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 text-left text-xs text-gray-500">
                  <tr>
                    <th className="px-3 py-2">상품</th>
                    <th className="px-3 py-2">재구매 주기</th>
                    <th className="px-3 py-2 text-right">연 재주문</th>
                    <th className="px-3 py-2 text-right">지속성</th>
                    <th className="px-3 py-2 text-right">공급</th>
                    <th className="px-3 py-2">연간 반복주문 추정치 (LTV proxy)</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {recurring.slice(0, 100).map((r, i) => (
                    <tr key={r.id} className="hover:bg-gray-50">
                      <td className="px-3 py-2">
                        <Link
                          href={`/admin/trend-radar/products/${r.id}`}
                          className="font-medium text-gray-900 hover:underline"
                        >
                          {i + 1}. {r.name}
                        </Link>
                        <div className="text-xs text-gray-400">
                          {r.category}
                          {r.categoryMid ? ` · ${r.categoryMid}` : ''}
                          {r.source === 'heuristic' && (
                            <span className="ml-1 rounded bg-gray-100 px-1 text-gray-500">
                              추정
                            </span>
                          )}
                          {r.qty > 1 && <span className="ml-1 text-gray-500">×{r.qty}</span>}
                        </div>
                      </td>
                      <td className="px-3 py-2">
                        <CycleBadge days={r.cycleDays} />
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-gray-700">
                        {r.reorderFreq.toFixed(1)}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-gray-600">
                        {(r.persistence * 100).toFixed(0)}%
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-gray-600">
                        {(r.supplierStability * 100).toFixed(0)}%
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex items-center gap-2">
                          <div className="h-2 w-32 overflow-hidden rounded bg-gray-100">
                            <div
                              className="h-full rounded bg-emerald-500"
                              style={{ width: bar(r.annualRecurringOrders, maxLtv) }}
                            />
                          </div>
                          <span className="tabular-nums font-semibold text-emerald-700">
                            {r.annualRecurringOrders.toFixed(1)}
                          </span>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="space-y-3">
            <h2 className="text-sm font-semibold text-gray-700">
              단발성 트렌드 · 1회성 내구재 ({oneoff.length})
              <span className="ml-2 rounded bg-rose-100 px-1.5 py-0.5 text-xs font-medium text-rose-700">
                반복매출 디스카운트
              </span>
            </h2>
            <div className="overflow-x-auto rounded border border-gray-200">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 text-left text-xs text-gray-500">
                  <tr>
                    <th className="px-3 py-2">상품</th>
                    <th className="px-3 py-2 text-right">final</th>
                    <th className="px-3 py-2 text-right">trend</th>
                    <th className="px-3 py-2 text-right">supplier</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {oneoff.slice(0, 50).map((r) => (
                    <tr key={r.id} className="text-gray-500 hover:bg-gray-50">
                      <td className="px-3 py-2">
                        <Link
                          href={`/admin/trend-radar/products/${r.id}`}
                          className="hover:underline"
                        >
                          {r.name}
                        </Link>
                        <span className="ml-2 rounded bg-rose-50 px-1 text-xs text-rose-600">
                          1회성
                        </span>
                        <span className="ml-1 text-xs text-gray-400">
                          {r.category}
                          {r.source === 'heuristic' ? ' · 추정' : ''}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">{r.final.toFixed(0)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{r.trend.toFixed(0)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{r.supplier.toFixed(0)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </div>
  )
}
