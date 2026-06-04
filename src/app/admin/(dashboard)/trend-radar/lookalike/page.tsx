import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

// ─────────────────────────────────────────────────────────────
// 위너 지문 닮은꼴(Lookalike) 발굴 보드
//   실제로 팔린 상품(is_winner)의 '시그널 지문'을 centroid 로 학습하고,
//   각 미판매 후보의 가중 코사인 유사도를 계산해 '닮은꼴 × final_score' 로
//   재랭킹한다. opportunity 보드와 동일하게 read-only 서버 컴포넌트.
//   (winner 라벨은 supabase/trends_lookalike.sql 참고)
// ─────────────────────────────────────────────────────────────

interface ScoreRow {
  product_id: string
  trend_score: number
  commerce_score: number
  supplier_score: number
  competition_score: number
  final_score: number
  computed_at: string
  score_components: Record<string, unknown> | null
}
interface ProductRow {
  id: string
  canonical_name: string
  category_top: string | null
  category_mid: string | null
  is_winner: boolean | null
  units_sold: number | null
  winner_note: string | null
}

// 사람이 읽을 수 있는 축 이름 (없으면 raw key 사용)
const AXIS_LABEL: Record<string, string> = {
  trend: '트렌드 강도',
  commerce: '커머스 수요',
  supplier: '도매 소싱',
  competition: '경쟁 약함',
}

function prettyAxis(key: string): string {
  if (AXIS_LABEL[key]) return AXIS_LABEL[key]
  // score_components 의 leaf 경로 (예: "commerce.tv_push") → 마지막 토큰 정리
  const last = key.split('.').pop() ?? key
  return last.replace(/_/g, ' ')
}

// score_components(jsonb) 의 숫자 leaf 를 "a.b.c" → number 로 평탄화
function flattenNumeric(obj: unknown, prefix = '', out: Record<string, number> = {}): Record<string, number> {
  if (!obj || typeof obj !== 'object') return out
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const key = prefix ? `${prefix}.${k}` : k
    if (typeof v === 'number' && Number.isFinite(v)) out[key] = v
    else if (v && typeof v === 'object') flattenNumeric(v, key, out)
  }
  return out
}

interface Candidate {
  id: string
  name: string
  category: string
  finalScore: number
  lookalike: number          // 0~100 (centroid 코사인 유사도)
  combined: number           // lookalike/100 × final_score
  topAxes: { key: string; label: string; pct: number }[]   // 닮은 기여도 상위 축
  nearest: { name: string; sim: number }[]                 // 가장 닮은 위너 1~2개
}

async function fetchBoard() {
  const sb = createAdminClient()

  // 최신 score (product_id 별 가장 최근 row)
  const { data: scoreData } = await sb
    .from('jimscanner_trends_scores')
    .select('product_id, trend_score, commerce_score, supplier_score, competition_score, final_score, computed_at, score_components')
    .order('computed_at', { ascending: false })
    .limit(3000)

  const seen = new Set<string>()
  const latest: ScoreRow[] = []
  for (const s of (scoreData ?? []) as ScoreRow[]) {
    if (seen.has(s.product_id)) continue
    seen.add(s.product_id)
    latest.push(s)
  }
  if (latest.length === 0) return { winners: [], candidates: [] as Candidate[], featureCount: 0 }

  const ids = latest.map((s) => s.product_id)
  // is_winner/units_sold 는 마이그레이션(trends_lookalike.sql) 후 컬럼 → as any 캐스팅
  const { data: prodData } = await (sb as any)
    .from('jimscanner_trends_products')
    .select('id, canonical_name, category_top, category_mid, is_winner, units_sold, winner_note')
    .in('id', ids)
  const byId = new Map<string, ProductRow>(((prodData ?? []) as ProductRow[]).map((p) => [p.id, p]))

  // ── 피처 벡터 구성 ──────────────────────────────────────────
  // base 4축(weight 1.0) + score_components 숫자 leaf(weight 0.6)
  const BASE = ['trend', 'commerce', 'supplier', 'competition'] as const
  const baseVal = (s: ScoreRow): Record<string, number> => ({
    trend: s.trend_score,
    commerce: s.commerce_score,
    supplier: s.supplier_score,
    competition: s.competition_score,
  })

  // 전체 후보의 raw 피처 모음 + feature key union
  const rawByProduct = new Map<string, Record<string, number>>()
  const featureKeys = new Set<string>()
  const weight = new Map<string, number>()
  for (const s of latest) {
    const raw: Record<string, number> = { ...baseVal(s) }
    for (const k of BASE) { featureKeys.add(k); weight.set(k, 1.0) }
    const comp = flattenNumeric(s.score_components)
    for (const [k, v] of Object.entries(comp)) {
      // base 4축과 이름 충돌 방지 위해 그대로 경로 사용
      raw[k] = v
      featureKeys.add(k)
      if (!weight.has(k)) weight.set(k, 0.6)
    }
    rawByProduct.set(s.product_id, raw)
  }

  const keys = [...featureKeys]
  // feature 별 정규화 상한 (max abs)
  const maxAbs = new Map<string, number>()
  for (const k of keys) {
    let m = 0
    for (const raw of rawByProduct.values()) m = Math.max(m, Math.abs(raw[k] ?? 0))
    maxAbs.set(k, m || 1)
  }

  // 정규화 + weight 적용 벡터
  function vectorOf(pid: string): number[] {
    const raw = rawByProduct.get(pid) ?? {}
    return keys.map((k) => ((raw[k] ?? 0) / (maxAbs.get(k) || 1)) * (weight.get(k) ?? 0))
  }
  function cosine(a: number[], b: number[]): number {
    let dot = 0, na = 0, nb = 0
    for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i] }
    if (na === 0 || nb === 0) return 0
    return dot / (Math.sqrt(na) * Math.sqrt(nb))
  }

  // ── 위너 집합 + centroid ────────────────────────────────────
  const winnerScores = latest.filter((s) => byId.get(s.product_id)?.is_winner)
  const winners = winnerScores.map((s) => ({
    id: s.product_id,
    name: byId.get(s.product_id)?.canonical_name ?? '?',
    units: byId.get(s.product_id)?.units_sold ?? 0,
    vec: vectorOf(s.product_id),
  }))

  if (winners.length === 0) return { winners: [], candidates: [] as Candidate[], featureCount: keys.length }

  const centroid = keys.map((_, i) => winners.reduce((acc, w) => acc + w.vec[i], 0) / winners.length)
  const cNorm = Math.sqrt(centroid.reduce((a, x) => a + x * x, 0)) || 1

  // ── 미판매 후보 랭킹 ────────────────────────────────────────
  const winnerIds = new Set(winners.map((w) => w.id))
  const candidates: Candidate[] = []
  for (const s of latest) {
    if (winnerIds.has(s.product_id)) continue
    const p = byId.get(s.product_id)
    if (!p) continue
    const vec = vectorOf(s.product_id)
    const sim = cosine(vec, centroid)
    if (sim <= 0) continue
    const lookalike = Math.round(sim * 1000) / 10  // 0~100, 소수1

    // 축별 기여도 = (vec_i × centroid_i) / (‖vec‖·‖centroid‖) → 코사인 분해
    const vNorm = Math.sqrt(vec.reduce((a, x) => a + x * x, 0)) || 1
    const contrib = keys
      .map((k, i) => ({ key: k, label: prettyAxis(k), term: (vec[i] * centroid[i]) / (vNorm * cNorm) }))
      .filter((c) => c.term > 0)
      .sort((a, b) => b.term - a.term)
    const totalTerm = contrib.reduce((a, c) => a + c.term, 0) || 1
    const topAxes = contrib.slice(0, 3).map((c) => ({ key: c.key, label: c.label, pct: Math.round((c.term / totalTerm) * 100) }))

    // 가장 닮은 위너 1~2개
    const nearest = winners
      .map((w) => ({ name: w.name, sim: cosine(vec, w.vec) }))
      .sort((a, b) => b.sim - a.sim)
      .slice(0, 2)
      .map((n) => ({ name: n.name, sim: Math.round(n.sim * 1000) / 10 }))

    candidates.push({
      id: s.product_id,
      name: p.canonical_name,
      category: p.category_top ?? 'all',
      finalScore: s.final_score,
      lookalike,
      combined: Math.round((lookalike / 100) * s.final_score * 10) / 10,
      topAxes,
      nearest,
    })
  }

  candidates.sort((a, b) => b.combined - a.combined)

  return {
    winners: winners.map((w) => ({ name: w.name, units: w.units })).sort((a, b) => b.units - a.units),
    candidates: candidates.slice(0, 50),
    featureCount: keys.length,
  }
}

export default async function LookalikePage() {
  const { winners, candidates, featureCount } = await fetchBoard()

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold">위너 지문 닮은꼴 보드</h1>
          <p className="text-sm text-gray-500 mt-1">
            실판매 위너 {winners.length}종의 시그널 지문(centroid · {featureCount}축)과 닮은 미판매 후보를{' '}
            <span className="font-mono">닮은꼴 × final_score</span> 로 재랭킹 — 승자 클로닝 발굴
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      {winners.length === 0 ? (
        <div className="rounded border border-dashed border-amber-300 bg-amber-50/50 p-8 text-sm text-gray-700">
          <p className="font-medium text-base mb-2">아직 위너(양성 사례)가 없습니다</p>
          <p className="mb-2">
            닮은꼴 발굴은 <span className="font-mono">is_winner=true</span> 로 태깅된 '실제 팔린 상품'을 기준점으로 학습합니다.
          </p>
          <p className="text-gray-600">
            <span className="font-mono">supabase/trends_lookalike.sql</span> 마이그레이션 적용 후, coupang-orders 자동 매칭
            헬퍼를 1회 실행하거나 운영자가 수동으로 위너를 플래그하세요. 위너가 1종 이상 생기면 이 보드가 자동 채워집니다.
          </p>
        </div>
      ) : (
        <>
          {/* 위너 집합 요약 */}
          <section className="rounded border border-emerald-200 bg-emerald-50/40 p-4">
            <h2 className="text-sm font-semibold text-gray-700 mb-2">
              🏆 학습된 위너 지문 ({winners.length}종 · 판매량순)
            </h2>
            <div className="flex flex-wrap gap-2">
              {winners.slice(0, 30).map((w) => (
                <span key={w.name} className="inline-flex items-center gap-1 rounded-full bg-white border border-emerald-200 px-3 py-1 text-xs">
                  {w.name}
                  {w.units > 0 && <span className="font-mono text-emerald-700">{w.units}건</span>}
                </span>
              ))}
            </div>
          </section>

          {/* 닮은꼴 후보 카드 */}
          <section className="space-y-3">
            {candidates.length === 0 ? (
              <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500">
                닮은꼴 후보가 없습니다. score 누적 후 다시 방문.
              </div>
            ) : (
              candidates.map((c, i) => (
                <div key={c.id} className="rounded border border-gray-200 p-4 hover:bg-gray-50 transition-colors">
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-gray-400 text-sm">{i + 1}</span>
                        <Link href={`/admin/trend-radar/products/${c.id}`} className="font-semibold hover:underline truncate">
                          {c.name}
                        </Link>
                        <span className="text-xs text-gray-400">{c.category}</span>
                      </div>
                      {/* 기여도 막대: 어떤 축이 위너와 닮았나 */}
                      <div className="mt-2 space-y-1 max-w-md">
                        {c.topAxes.map((a) => (
                          <div key={a.key} className="flex items-center gap-2 text-xs">
                            <span className="w-24 shrink-0 text-gray-500 truncate" title={a.key}>{a.label}</span>
                            <div className="flex-1 h-2 rounded bg-gray-100 overflow-hidden">
                              <div className="h-full bg-indigo-400" style={{ width: `${Math.min(100, a.pct)}%` }} />
                            </div>
                            <span className="w-9 text-right font-mono text-gray-500">{a.pct}%</span>
                          </div>
                        ))}
                      </div>
                      {/* 가장 닮은 위너 */}
                      {c.nearest.length > 0 && (
                        <div className="mt-2 text-xs text-gray-500">
                          가장 닮은 위너:{' '}
                          {c.nearest.map((n, j) => (
                            <span key={n.name}>
                              {j > 0 && ' · '}
                              <span className="text-gray-700">{n.name}</span>{' '}
                              <span className="font-mono text-indigo-600">{n.sim}%</span>
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                    {/* 점수 */}
                    <div className="shrink-0 text-right">
                      <div className="text-2xl font-bold font-mono">{c.combined}</div>
                      <div className="text-xs text-gray-400">combined</div>
                      <div className="mt-1 text-xs text-gray-500">
                        닮은꼴 <span className="font-mono text-indigo-600">{c.lookalike}</span> ·{' '}
                        final <span className="font-mono">{c.finalScore}</span>
                      </div>
                    </div>
                  </div>
                </div>
              ))
            )}
          </section>
        </>
      )}
    </div>
  )
}
