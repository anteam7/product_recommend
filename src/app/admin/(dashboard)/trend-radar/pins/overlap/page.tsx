import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import OverlapGraph, { type OverlapNode, type OverlapPair } from './OverlapGraph'

export const dynamic = 'force-dynamic'

interface PinProductRow {
  keyword: string
  source: string
  pinned_at: string
  product_id: string | null
  canonical_name: string | null
  category_top: string | null
  category_mid: string | null
  intent_label: string | null
}

interface PairRow {
  product_a: string
  product_b: string
  name_a: string
  name_b: string
  category_top_a: string | null
  category_top_b: string | null
  category_mid_a: string | null
  category_mid_b: string | null
  intent_a: string | null
  intent_b: string | null
  embedding_sim: number
  intent_match: number
  category_match: number
  supplier_overlap: number
  cannibalization_score: number
  computed_at: string
}

interface HistoryRow {
  product_a: string
  product_b: string
  cannibalization_score: number
  computed_at: string
}

async function fetchOverlap() {
  const sb = createAdminClient()

  // 1) 핀된 product 목록 (alias 매핑 해석 뷰)
  const { data: pinProducts } = await (sb as any)
    .from('jimscanner_pin_products_v')
    .select('keyword, source, pinned_at, product_id, canonical_name, category_top, category_mid, intent_label')

  // 2) 최신 잠식 페어
  const { data: pairs } = await (sb as any)
    .from('jimscanner_pin_cannibalization_pairs')
    .select('*')

  // 3) 시계열 (최근 60일)
  const since = new Date()
  since.setDate(since.getDate() - 60)
  const { data: history } = await (sb as any)
    .from('jimscanner_pin_cannibalization_history')
    .select('product_a, product_b, cannibalization_score, computed_at')
    .gte('computed_at', since.toISOString())
    .order('computed_at', { ascending: true })
    .limit(2000)

  return {
    pinProducts: ((pinProducts as PinProductRow[] | null) ?? []),
    pairs: ((pairs as PairRow[] | null) ?? []),
    history: ((history as HistoryRow[] | null) ?? []),
  }
}

const RISK_THRESHOLD = 0.6

function recommendAction(pair: PairRow): { tag: string; label: string; color: string } {
  // 가장 두드러진 신호로 추천 액션 결정.
  if (pair.supplier_overlap >= 0.5) {
    return { tag: 'unpin_one', label: '한쪽 unpin 권장 — 동일 ggsan 공급원', color: 'text-red-700' }
  }
  if (pair.embedding_sim >= 0.85 && pair.intent_match >= 1) {
    return { tag: 'unpin_one', label: '한쪽 unpin 권장 — 동일 의도 + 의미 중복', color: 'text-red-700' }
  }
  if (pair.intent_match >= 1 && pair.category_match >= 0.5) {
    return { tag: 'differentiate', label: '한쪽 키워드 차별화 (의도 분리 필요)', color: 'text-orange-700' }
  }
  if (pair.category_match >= 1) {
    return { tag: 'channel_split', label: '둘 다 유지하되 채널 분리 (동일 카테고리 슬롯)', color: 'text-amber-700' }
  }
  return { tag: 'monitor', label: '경계 영역 — 모니터링', color: 'text-gray-600' }
}

export default async function PinOverlapPage() {
  const { pinProducts, pairs, history } = await fetchOverlap()

  // 노드: 핀된 product 단위 (중복 제거)
  const nodeMap = new Map<string, OverlapNode>()
  for (const p of pinProducts) {
    if (!p.product_id || !p.canonical_name) continue
    if (nodeMap.has(p.product_id)) continue
    nodeMap.set(p.product_id, {
      id: p.product_id,
      label: p.canonical_name,
      category: p.category_top ?? 'all',
    })
  }
  const nodes: OverlapNode[] = Array.from(nodeMap.values())

  // 잠식 위험 페어만 그래프 엣지로 (≥0.6)
  const riskPairs = pairs.filter((p) => p.cannibalization_score >= RISK_THRESHOLD)
  const graphPairs: OverlapPair[] = riskPairs.map((p) => ({
    a: p.product_a,
    b: p.product_b,
    score: Number(p.cannibalization_score),
  }))

  // 시계열: 페어별 추이 — UI 최대 8개 표시
  const seriesByPair = new Map<string, { t: string; v: number }[]>()
  for (const h of history) {
    const key = `${h.product_a}::${h.product_b}`
    const arr = seriesByPair.get(key) ?? []
    arr.push({ t: h.computed_at, v: Number(h.cannibalization_score) })
    seriesByPair.set(key, arr)
  }

  const unresolvedPins = pinProducts.filter((p) => !p.product_id).length

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold">핀 포트폴리오 자기잠식 진단</h1>
          <p className="text-sm text-gray-500 mt-1">
            핀한 상품들끼리 같은 수요/검색의도/카테고리 슬롯을 두고 잠식하는지 자동 진단.
            점수 ≥ {RISK_THRESHOLD.toFixed(2)} 는 빨간 엣지로 표시.
          </p>
        </div>
        <Link href="/admin/trend-radar/pins" className="text-sm text-gray-700 hover:text-black underline">
          ← 핀 목록
        </Link>
      </header>

      <section className="grid grid-cols-4 gap-3 text-sm">
        <div className="rounded border border-gray-200 p-3">
          <div className="text-xs text-gray-500">핀한 상품</div>
          <div className="text-2xl font-bold">{nodes.length}</div>
        </div>
        <div className="rounded border border-gray-200 p-3">
          <div className="text-xs text-gray-500">전체 페어</div>
          <div className="text-2xl font-bold">{pairs.length}</div>
        </div>
        <div className="rounded border border-red-200 bg-red-50 p-3">
          <div className="text-xs text-red-700">잠식 위험 페어</div>
          <div className="text-2xl font-bold text-red-700">{riskPairs.length}</div>
        </div>
        <div className="rounded border border-gray-200 p-3">
          <div className="text-xs text-gray-500">미해석 핀 (alias 누락)</div>
          <div className="text-2xl font-bold">{unresolvedPins}</div>
        </div>
      </section>

      {nodes.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500">
          <p className="text-base font-medium">분석할 핀이 없음</p>
          <p className="text-sm mt-2">
            먼저 /admin/trend-radar/pins 에서 상품을 핀하고,
            <code className="mx-1 px-1 bg-gray-100 rounded text-xs">SELECT jimscanner_pin_cannibalization_recompute();</code>
            를 호출해 페어 점수를 계산하세요.
          </p>
        </div>
      ) : (
        <>
          <section className="rounded border border-gray-200 p-4">
            <h2 className="text-sm font-semibold text-gray-800 mb-2">잠식 그래프 (force-directed)</h2>
            <OverlapGraph nodes={nodes} pairs={graphPairs} threshold={RISK_THRESHOLD} />
            <p className="text-xs text-gray-500 mt-2">
              빨강: ≥0.8 (긴급), 주황: 0.7~0.8, 노랑: 0.6~0.7. 회색 점은 핀했지만 안전한 상품.
            </p>
          </section>

          <section className="rounded border border-gray-200 p-4">
            <h2 className="text-sm font-semibold text-gray-800 mb-3">잠식 위험 카드</h2>
            {riskPairs.length === 0 ? (
              <p className="text-sm text-gray-500">위험 페어 없음 — 핀 포트폴리오가 잘 분산되어 있습니다.</p>
            ) : (
              <div className="grid gap-3 md:grid-cols-2">
                {riskPairs.map((p) => {
                  const action = recommendAction(p)
                  const key = `${p.product_a}::${p.product_b}`
                  const series = seriesByPair.get(key) ?? []
                  return (
                    <div key={key} className="rounded border border-red-200 bg-red-50/50 p-3">
                      <div className="flex items-baseline justify-between">
                        <div className="text-sm font-semibold text-gray-900">
                          {p.name_a} <span className="text-red-600 mx-1">↔</span> {p.name_b}
                        </div>
                        <div className="text-lg font-bold text-red-700 font-mono">
                          {Number(p.cannibalization_score).toFixed(2)}
                        </div>
                      </div>
                      <div className="grid grid-cols-4 gap-2 mt-2 text-[11px] text-gray-700">
                        <Metric label="의미 유사" v={p.embedding_sim} />
                        <Metric label="의도 일치" v={p.intent_match} />
                        <Metric label="카테고리" v={p.category_match} />
                        <Metric label="공급원 중복" v={p.supplier_overlap} />
                      </div>
                      <div className={`mt-2 text-xs font-medium ${action.color}`}>
                        → {action.label}
                      </div>
                      {series.length > 1 && (
                        <div className="mt-2">
                          <Sparkline points={series.map((s) => s.v)} />
                          <div className="text-[10px] text-gray-400 font-mono mt-0.5">
                            잠식 지수 추이 ({series.length}회)
                          </div>
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </section>

          <section className="rounded border border-gray-200">
            <h2 className="text-sm font-semibold text-gray-800 p-3 border-b border-gray-100">
              전체 페어 ({pairs.length})
            </h2>
            <div className="divide-y divide-gray-100">
              {pairs.slice(0, 50).map((p) => (
                <div key={`${p.product_a}::${p.product_b}`} className="grid grid-cols-12 px-3 py-2 text-xs items-center">
                  <div className="col-span-5 truncate">
                    {p.name_a} <span className="text-gray-400 mx-1">↔</span> {p.name_b}
                  </div>
                  <div className="col-span-1 text-gray-500 font-mono">{Number(p.embedding_sim).toFixed(2)}</div>
                  <div className="col-span-1 text-gray-500 font-mono">{Number(p.intent_match).toFixed(2)}</div>
                  <div className="col-span-1 text-gray-500 font-mono">{Number(p.category_match).toFixed(2)}</div>
                  <div className="col-span-1 text-gray-500 font-mono">{Number(p.supplier_overlap).toFixed(2)}</div>
                  <div className={`col-span-1 font-mono font-semibold text-right ${
                    p.cannibalization_score >= RISK_THRESHOLD ? 'text-red-700' : 'text-gray-700'
                  }`}>
                    {Number(p.cannibalization_score).toFixed(2)}
                  </div>
                  <div className="col-span-2 text-right text-[10px] text-gray-400 font-mono">
                    {p.computed_at?.slice(0, 16)}
                  </div>
                </div>
              ))}
              {pairs.length === 0 && (
                <div className="px-3 py-6 text-xs text-gray-500 text-center">
                  페어 점수 미계산. RPC <code className="px-1 bg-gray-100 rounded">jimscanner_pin_cannibalization_recompute()</code> 호출 필요.
                </div>
              )}
            </div>
          </section>
        </>
      )}
    </div>
  )
}

function Metric({ label, v }: { label: string; v: number }) {
  const pct = Math.round(Number(v) * 100)
  return (
    <div className="rounded bg-white border border-gray-200 px-2 py-1">
      <div className="text-[10px] text-gray-500">{label}</div>
      <div className="font-mono font-semibold">{pct}%</div>
    </div>
  )
}

function Sparkline({ points }: { points: number[] }) {
  if (points.length < 2) return null
  const W = 160
  const H = 24
  const max = Math.max(1, ...points)
  const min = Math.min(0, ...points)
  const range = max - min || 1
  const step = W / (points.length - 1)
  const d = points
    .map((v, i) => {
      const x = i * step
      const y = H - ((v - min) / range) * H
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')
  return (
    <svg width={W} height={H} className="block">
      <path d={d} fill="none" stroke="#dc2626" strokeWidth="1.5" />
    </svg>
  )
}
