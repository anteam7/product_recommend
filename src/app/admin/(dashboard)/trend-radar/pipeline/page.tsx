import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import PipelineBoard from './PipelineBoard'
import { STAGES, type StageKey, type PipelineCard } from './stages'

export const dynamic = 'force-dynamic'

interface PipelineRow {
  product_id: string
  stage: StageKey
  stage_changed_at: string
  dropped_reason: string | null
  note: string | null
  assigned_at: string
}
interface HistoryRow {
  product_id: string
  from_stage: string | null
  to_stage: string
  dropped_reason: string | null
  changed_at: string
}
interface ScoreRow {
  product_id: string
  final_score: number
  computed_at: string
}

const ACTIVE_STAGES: StageKey[] = ['discovered', 'reviewing', 'sourcing', 'listed', 'selling']
// 퍼널 전환 순서 (dropped 제외) — 전환율 계산용
const FUNNEL_ORDER: StageKey[] = ['discovered', 'reviewing', 'sourcing', 'listed', 'selling']

function pctl(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))
  return sorted[idx]
}

async function fetchData() {
  const sb = createAdminClient()

  // 파이프라인 현재 단계 (테이블 미적용 시 빈 배열로 graceful)
  const pipeRes = await sb
    .from('jimscanner_trends_pipeline' as never)
    .select('product_id, stage, stage_changed_at, dropped_reason, note, assigned_at')
    .order('stage_changed_at', { ascending: false })
    .limit(2000)
  const pipeline = ((pipeRes.data ?? []) as unknown as PipelineRow[])
  const pipelineMissing = !!pipeRes.error

  const histRes = await sb
    .from('jimscanner_trends_pipeline_history' as never)
    .select('product_id, from_stage, to_stage, dropped_reason, changed_at')
    .order('changed_at', { ascending: true })
    .limit(5000)
  const history = ((histRes.data ?? []) as unknown as HistoryRow[])

  // 최신 score (product 별) — score 구간별 판매 도달률 분석에 사용
  const { data: scoreData } = await sb
    .from('jimscanner_trends_scores')
    .select('product_id, final_score, computed_at')
    .order('computed_at', { ascending: false })
    .limit(3000)
  const seenScore = new Set<string>()
  const latestScore = new Map<string, number>()
  for (const s of (scoreData ?? []) as ScoreRow[]) {
    if (seenScore.has(s.product_id)) continue
    seenScore.add(s.product_id)
    latestScore.set(s.product_id, Number(s.final_score))
  }

  // 후보 풀: 아직 파이프라인에 없는 high-score 상품도 'discovered' 로 노출하면
  //   운영자가 끌어다 검토 시작 가능. 여기선 파이프라인에 들어온 상품만 + 점수만 join.
  const pipeProductIds = pipeline.map((p) => p.product_id)
  // 파이프라인 미진입 상위 후보(점수순) 일부를 discovered 가상 카드로 노출
  const topUnpiped: string[] = []
  for (const [pid] of latestScore) {
    if (!pipeProductIds.includes(pid)) topUnpiped.push(pid)
    if (topUnpiped.length >= 60) break
  }

  const allIds = Array.from(new Set([...pipeProductIds, ...topUnpiped]))
  const nameById = new Map<string, { name: string; category: string }>()
  if (allIds.length > 0) {
    const { data: prods } = await sb
      .from('jimscanner_trends_products')
      .select('id, canonical_name, category_top')
      .in('id', allIds)
    for (const p of (prods ?? []) as { id: string; canonical_name: string; category_top: string }[]) {
      nameById.set(p.id, { name: p.canonical_name, category: p.category_top })
    }
  }

  // 카드 구성
  const cards: PipelineCard[] = []
  const pipedSet = new Set(pipeProductIds)
  for (const p of pipeline) {
    const meta = nameById.get(p.product_id)
    cards.push({
      product_id: p.product_id,
      name: meta?.name ?? '(이름 없음)',
      category: meta?.category ?? '—',
      stage: p.stage,
      stage_changed_at: p.stage_changed_at,
      dropped_reason: p.dropped_reason,
      note: p.note,
      final_score: latestScore.get(p.product_id) ?? null,
    })
  }
  // 미진입 상위 후보 → discovered 가상 카드 (파이프라인 행 없음)
  for (const pid of topUnpiped) {
    if (pipedSet.has(pid)) continue
    const meta = nameById.get(pid)
    cards.push({
      product_id: pid,
      name: meta?.name ?? '(이름 없음)',
      category: meta?.category ?? '—',
      stage: 'discovered',
      stage_changed_at: null,
      dropped_reason: null,
      note: null,
      final_score: latestScore.get(pid) ?? null,
      virtual: true,
    })
  }

  // ── 퍼널 분석 ──────────────────────────────────────────────
  // 단계별 카운트 (가상 discovered 포함)
  const stageCounts: Record<string, number> = {}
  for (const k of STAGES) stageCounts[k.key] = 0
  for (const c of cards) stageCounts[c.stage] = (stageCounts[c.stage] ?? 0) + 1

  // "단계 도달" 카운트: 이력 기준 — 한 상품이 to_stage 에 도달한 적 있으면 1
  const reachedStage: Record<string, Set<string>> = {}
  for (const k of FUNNEL_ORDER) reachedStage[k] = new Set()
  for (const h of history) {
    if (reachedStage[h.to_stage]) reachedStage[h.to_stage].add(h.product_id)
  }
  // discovered 는 파이프라인 진입 전체 + 이력 (최초 진입 to_stage=discovered or 직접 reviewing)
  for (const p of pipeline) reachedStage['discovered']?.add(p.product_id)

  const funnel = FUNNEL_ORDER.map((k, i) => {
    const reached = reachedStage[k]?.size ?? 0
    const prev = i > 0 ? reachedStage[FUNNEL_ORDER[i - 1]]?.size ?? 0 : reached
    const conv = i === 0 ? 1 : prev > 0 ? reached / prev : 0
    return { stage: k, reached, conversionFromPrev: conv }
  })

  // 단계별 체류일 (dwell-time): 같은 product 의 연속 이력 간 일수, to_stage 기준 그룹.
  const byProductHist = new Map<string, HistoryRow[]>()
  for (const h of history) {
    if (!byProductHist.has(h.product_id)) byProductHist.set(h.product_id, [])
    byProductHist.get(h.product_id)!.push(h)
  }
  const dwellByStage: Record<string, number[]> = {}
  for (const k of FUNNEL_ORDER) dwellByStage[k] = []
  for (const [, hs] of byProductHist) {
    for (let i = 0; i < hs.length - 1; i++) {
      const stageEntered = hs[i].to_stage
      const days =
        (new Date(hs[i + 1].changed_at).getTime() - new Date(hs[i].changed_at).getTime()) /
        86400000
      if (dwellByStage[stageEntered] && days >= 0) dwellByStage[stageEntered].push(days)
    }
  }
  const dwell = FUNNEL_ORDER.map((k) => {
    const arr = dwellByStage[k].slice().sort((a, b) => a - b)
    return { stage: k, p50: pctl(arr, 50), p90: pctl(arr, 90), n: arr.length }
  })

  // 이탈사유 분포 (히트맵용) + 어느 단계에서 죽었는지
  const dropByReason: Record<string, number> = {}
  const dropByFromStage: Record<string, number> = {}
  for (const h of history) {
    if (h.to_stage !== 'dropped') continue
    const r = h.dropped_reason ?? '기타'
    dropByReason[r] = (dropByReason[r] ?? 0) + 1
    const fs = h.from_stage ?? 'discovered'
    dropByFromStage[fs] = (dropByFromStage[fs] ?? 0) + 1
  }

  // 시그널(score 구간)별 최종 판매 도달률
  const sellingIds = new Set(
    cards.filter((c) => c.stage === 'selling').map((c) => c.product_id),
  )
  const buckets = [
    { label: '0–40', lo: 0, hi: 40 },
    { label: '40–60', lo: 40, hi: 60 },
    { label: '60–80', lo: 60, hi: 80 },
    { label: '80–100', lo: 80, hi: 101 },
  ]
  const scoreReach = buckets.map((b) => {
    let total = 0
    let sold = 0
    for (const c of cards) {
      if (c.final_score == null) continue
      if (c.final_score >= b.lo && c.final_score < b.hi) {
        total++
        if (sellingIds.has(c.product_id)) sold++
      }
    }
    return { label: b.label, total, sold, rate: total > 0 ? sold / total : 0 }
  })

  return {
    cards,
    pipelineMissing,
    analytics: { stageCounts, funnel, dwell, dropByReason, dropByFromStage, scoreReach },
  }
}

const STAGE_LABEL: Record<string, string> = Object.fromEntries(STAGES.map((s) => [s.key, s.label]))

export default async function PipelinePage() {
  const { cards, pipelineMissing, analytics } = await fetchData()
  const { stageCounts, funnel, dwell, dropByReason, dropByFromStage, scoreReach } = analytics

  const totalDropped = Object.values(dropByReason).reduce((a, b) => a + b, 0)
  const maxDropFrom = Object.entries(dropByFromStage).sort((a, b) => b[1] - a[1])[0]

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold">🪜 발굴 후보 파이프라인</h1>
          <p className="text-sm text-gray-500 mt-1">
            검토 → 소싱확정 → 등록 → 판매. 카드를 단계로 이동하면 전환율·체류일·이탈사유가 누적됩니다.
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      {pipelineMissing && (
        <div className="rounded border border-amber-300 bg-amber-50 px-4 py-3 text-xs text-amber-900">
          <strong>마이그레이션 대기</strong> · <code>supabase/trends_pipeline.sql</code> 적용 전입니다.
          상위 후보가 <em>discovered</em> 가상 카드로만 보입니다. SQL 적용 후 단계 이동이 저장됩니다.
        </div>
      )}

      {/* ── 퍼널 전환율 ── */}
      <section>
        <h2 className="text-sm font-semibold mb-2">📉 단계 전환 퍼널</h2>
        <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
          {funnel.map((f, i) => (
            <div key={f.stage} className="rounded border border-gray-200 p-3 text-center">
              <div className="text-[11px] text-gray-500">{STAGE_LABEL[f.stage]}</div>
              <div className="text-2xl font-bold mt-1">{f.reached}</div>
              {i > 0 && (
                <div
                  className={`text-xs mt-1 font-mono ${
                    f.conversionFromPrev < 0.5 ? 'text-rose-600' : 'text-gray-500'
                  }`}
                >
                  {(f.conversionFromPrev * 100).toFixed(0)}% ↘
                </div>
              )}
            </div>
          ))}
        </div>
      </section>

      {/* ── 체류일 + 병목 ── */}
      <section className="grid md:grid-cols-2 gap-4">
        <div>
          <h2 className="text-sm font-semibold mb-2">⏱ 단계별 체류일 (dwell-time)</h2>
          <div className="rounded border border-gray-200 overflow-hidden">
            <table className="w-full text-xs">
              <thead className="bg-gray-50 text-gray-500">
                <tr>
                  <th className="px-3 py-2 text-left">단계</th>
                  <th className="px-3 py-2 text-right">p50</th>
                  <th className="px-3 py-2 text-right">p90</th>
                  <th className="px-3 py-2 text-right">표본</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {dwell.map((d) => (
                  <tr key={d.stage}>
                    <td className="px-3 py-1.5">{STAGE_LABEL[d.stage]}</td>
                    <td className="px-3 py-1.5 text-right font-mono">
                      {d.n > 0 ? `${d.p50.toFixed(1)}일` : '—'}
                    </td>
                    <td className="px-3 py-1.5 text-right font-mono text-gray-500">
                      {d.n > 0 ? `${d.p90.toFixed(1)}일` : '—'}
                    </td>
                    <td className="px-3 py-1.5 text-right text-gray-400">{d.n}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div>
          <h2 className="text-sm font-semibold mb-2">
            💀 이탈사유 분포{' '}
            {maxDropFrom && (
              <span className="text-xs font-normal text-rose-600">
                · 최다 이탈 단계: {STAGE_LABEL[maxDropFrom[0]] ?? maxDropFrom[0]} ({maxDropFrom[1]})
              </span>
            )}
          </h2>
          {totalDropped === 0 ? (
            <div className="rounded border border-dashed border-gray-300 p-6 text-center text-xs text-gray-400">
              아직 이탈(dropped) 기록 없음
            </div>
          ) : (
            <div className="space-y-1.5">
              {Object.entries(dropByReason)
                .sort((a, b) => b[1] - a[1])
                .map(([reason, n]) => (
                  <div key={reason} className="flex items-center gap-2 text-xs">
                    <span className="w-16 text-gray-600">{reason}</span>
                    <div className="flex-1 bg-gray-100 rounded h-4 overflow-hidden">
                      <div
                        className="h-full bg-rose-400"
                        style={{ width: `${(n / totalDropped) * 100}%` }}
                      />
                    </div>
                    <span className="w-10 text-right font-mono text-gray-500">{n}</span>
                  </div>
                ))}
            </div>
          )}
        </div>
      </section>

      {/* ── score 구간별 판매 도달률 ── */}
      <section>
        <h2 className="text-sm font-semibold mb-2">🎯 final_score 구간별 판매 도달률</h2>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
          {scoreReach.map((b) => (
            <div key={b.label} className="rounded border border-gray-200 p-3 text-center">
              <div className="text-[11px] text-gray-500 font-mono">{b.label}</div>
              <div className="text-xl font-bold mt-1">
                {b.total > 0 ? `${(b.rate * 100).toFixed(0)}%` : '—'}
              </div>
              <div className="text-[10px] text-gray-400 mt-0.5">
                {b.sold}/{b.total} 판매도달
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* ── 칸반 보드 ── */}
      <PipelineBoard initialCards={cards} stageCounts={stageCounts} />
    </div>
  )
}
