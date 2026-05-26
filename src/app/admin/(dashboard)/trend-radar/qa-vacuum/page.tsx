import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

// 게이트 임계값 — supabase/trends_v4_qa_vacuum.sql 의 is_vacuum_gate 정의와 동일.
const ANSWER_RATE_GATE = 0.4
const UNANSWERED_GATE = 10

type RawRow = {
  id: string
  keyword: string
  source: string
  product_url: string
  question: string
  intent_label: string | null
  seller_responded: boolean
  response_lag_hours: number | null
  collected_at: string
}

type ClusterRow = {
  id: string
  keyword: string
  cluster_label: string
  total_count: number
  answered_count: number
  unanswered_count: number
  answer_rate: number | null
  avg_response_lag_hours: number | null
  sample_questions: unknown
  is_vacuum_gate: boolean
  faq_draft: string | null
  computed_at: string
}

type KeywordAgg = {
  keyword: string
  totalQ: number
  answeredQ: number
  unansweredQ: number
  answerRate: number
  avgLagHours: number | null
  clusters: ClusterRow[]
  topUnansweredCluster: ClusterRow | null
  isVacuumGate: boolean
  hasGgsanMatch: boolean
}

async function fetchData(opts: { onlyGate: boolean; onlyGgsan: boolean }) {
  const sb = createAdminClient()

  // 클러스터 우선 — 사전 집계 결과가 있으면 표시
  const clustersResp = await (sb as any)
    .from('jimscanner_trends_qa_clusters')
    .select(
      'id, keyword, cluster_label, total_count, answered_count, unanswered_count, answer_rate, avg_response_lag_hours, sample_questions, is_vacuum_gate, faq_draft, computed_at',
    )
    .order('computed_at', { ascending: false })
    .limit(2000)
  const clusters = (clustersResp.data ?? []) as ClusterRow[]

  // 최근 raw 샘플 (cluster 미집계 키워드용 fallback + KPI)
  const rawResp = await (sb as any)
    .from('jimscanner_trends_qa_raw')
    .select(
      'id, keyword, source, product_url, question, intent_label, seller_responded, response_lag_hours, collected_at',
    )
    .order('collected_at', { ascending: false })
    .limit(5000)
  const raw = (rawResp.data ?? []) as RawRow[]

  // ggsan 매칭 — 키워드 후보가 ggsan 카탈로그에 존재하는지 (간이: 제목 substring)
  const allKws = new Set<string>([
    ...clusters.map((c) => c.keyword),
    ...raw.map((r) => r.keyword),
  ])
  const ggsanResp = await (sb as any)
    .from('jimscanner_ggsan_products')
    .select('title')
    .limit(2000)
  const ggsanTitles = ((ggsanResp.data ?? []) as { title: string }[]).map((r) => r.title ?? '')
  const ggsanMatchSet = new Set<string>()
  for (const kw of allKws) {
    if (!kw) continue
    if (ggsanTitles.some((t) => t.includes(kw))) ggsanMatchSet.add(kw)
  }

  // keyword 단위 집계 — cluster 우선, raw fallback
  const byKw = new Map<string, KeywordAgg>()
  for (const kw of allKws) {
    const cs = clusters.filter((c) => c.keyword === kw)
    let total = 0
    let answered = 0
    let unanswered = 0
    let lagSum = 0
    let lagN = 0
    if (cs.length > 0) {
      for (const c of cs) {
        total += c.total_count
        answered += c.answered_count
        unanswered += c.unanswered_count
        if (typeof c.avg_response_lag_hours === 'number' && c.answered_count > 0) {
          lagSum += c.avg_response_lag_hours * c.answered_count
          lagN += c.answered_count
        }
      }
    } else {
      const rs = raw.filter((r) => r.keyword === kw)
      total = rs.length
      answered = rs.filter((r) => r.seller_responded).length
      unanswered = total - answered
      for (const r of rs) {
        if (typeof r.response_lag_hours === 'number' && r.seller_responded) {
          lagSum += r.response_lag_hours
          lagN++
        }
      }
    }
    const answerRate = total > 0 ? answered / total : 0
    const avgLag = lagN > 0 ? lagSum / lagN : null
    const topUnanswered =
      cs
        .slice()
        .sort((a, b) => b.unanswered_count - a.unanswered_count)[0] ?? null
    const isGate =
      cs.some((c) => c.is_vacuum_gate) ||
      (answerRate < ANSWER_RATE_GATE && unanswered >= UNANSWERED_GATE)
    byKw.set(kw, {
      keyword: kw,
      totalQ: total,
      answeredQ: answered,
      unansweredQ: unanswered,
      answerRate,
      avgLagHours: avgLag,
      clusters: cs.sort((a, b) => b.unanswered_count - a.unanswered_count),
      topUnansweredCluster: topUnanswered,
      isVacuumGate: isGate,
      hasGgsanMatch: ggsanMatchSet.has(kw),
    })
  }

  let rows = [...byKw.values()].filter((r) => r.totalQ > 0)
  if (opts.onlyGate) rows = rows.filter((r) => r.isVacuumGate)
  if (opts.onlyGgsan) rows = rows.filter((r) => r.hasGgsanMatch)
  rows.sort((a, b) => {
    if (a.isVacuumGate !== b.isVacuumGate) return a.isVacuumGate ? -1 : 1
    return b.unansweredQ - a.unansweredQ
  })

  const kpis = {
    keywords: byKw.size,
    rawQ: raw.length,
    gateKw: [...byKw.values()].filter((r) => r.isVacuumGate).length,
    ggsanKw: [...byKw.values()].filter((r) => r.hasGgsanMatch).length,
    clusters: clusters.length,
  }

  return { rows, kpis }
}

function pct(v: number | null | undefined) {
  if (typeof v !== 'number' || Number.isNaN(v)) return '–'
  return `${Math.round(v * 100)}%`
}
function hrs(v: number | null | undefined) {
  if (typeof v !== 'number' || Number.isNaN(v)) return '–'
  if (v < 1) return `${Math.round(v * 60)}분`
  if (v < 48) return `${v.toFixed(1)}h`
  return `${Math.round(v / 24)}d`
}
function sampleQs(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  return v
    .map((x) => (typeof x === 'string' ? x : typeof x === 'object' && x && 'question' in (x as any) ? String((x as any).question) : ''))
    .filter(Boolean)
    .slice(0, 3)
}

export default async function QaVacuumPage({
  searchParams,
}: {
  searchParams: Promise<{ gate?: string; ggsan?: string }>
}) {
  const sp = await searchParams
  const onlyGate = sp.gate === '1'
  const onlyGgsan = sp.ggsan === '1'

  const { rows, kpis } = await fetchData({ onlyGate, onlyGgsan })

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-2xl font-bold">Q&amp;A Vacuum Mining</h1>
          <p className="text-sm text-gray-500 mt-1">
            SERP 상위 상품의 답변율·미답변 클러스터 — 위탁 진입 차별화 게이트
          </p>
        </div>
        <div className="flex gap-3 items-center text-sm">
          <Link
            href={`/admin/trend-radar/qa-vacuum?gate=${onlyGate ? '0' : '1'}${onlyGgsan ? '&ggsan=1' : ''}`}
            className={`px-3 py-1.5 rounded border ${
              onlyGate
                ? 'border-red-300 bg-red-50 text-red-700 font-semibold'
                : 'border-gray-200 text-gray-600 hover:bg-gray-50'
            }`}
          >
            🔥 Vacuum gate 만
          </Link>
          <Link
            href={`/admin/trend-radar/qa-vacuum?ggsan=${onlyGgsan ? '0' : '1'}${onlyGate ? '&gate=1' : ''}`}
            className={`px-3 py-1.5 rounded border ${
              onlyGgsan
                ? 'border-amber-300 bg-amber-50 text-amber-700 font-semibold'
                : 'border-gray-200 text-gray-600 hover:bg-gray-50'
            }`}
          >
            ggsan 매칭 SKU 만
          </Link>
          <Link
            href="/admin/trend-radar"
            className="text-gray-600 hover:text-black underline"
          >
            ← 대시보드
          </Link>
        </div>
      </header>

      <section className="grid grid-cols-2 md:grid-cols-5 gap-4">
        <Kpi label="키워드" value={kpis.keywords} hint="Q&A 수집된" />
        <Kpi label="누적 Q&A" value={kpis.rawQ} hint="raw row" />
        <Kpi label="🔥 Vacuum gate" value={kpis.gateKw} hint={`답변율 <${ANSWER_RATE_GATE * 100}%, 미답변 ≥${UNANSWERED_GATE}`} />
        <Kpi label="ggsan 매칭" value={kpis.ggsanKw} hint="도매 매칭 후보" />
        <Kpi label="클러스터" value={kpis.clusters} hint="LLM 분류 완료" />
      </section>

      <section className="rounded border border-amber-200 bg-amber-50/40 p-4 text-sm text-gray-700">
        <div className="font-semibold mb-1">게이트 정의</div>
        답변율 &lt; <span className="font-mono">{ANSWER_RATE_GATE * 100}%</span> AND 미답변 질문 ≥{' '}
        <span className="font-mono">{UNANSWERED_GATE}건</span> → 위탁 셀러가 FAQ 선제 완비로
        CVR 차별화를 만들 수 있는 키워드. 자동 FAQ 초안은 <code className="px-1 bg-amber-100 rounded">classify-qa-llm.mjs</code> 가 채움.
      </section>

      {rows.length === 0 ? (
        <EmptyState onlyGate={onlyGate} onlyGgsan={onlyGgsan} />
      ) : (
        <div className="space-y-3">
          <div className="grid grid-cols-12 px-3 py-1 text-xs text-gray-500">
            <div className="col-span-3">키워드</div>
            <div className="col-span-1 text-right">Q 총수</div>
            <div className="col-span-1 text-right">답변율</div>
            <div className="col-span-1 text-right">미답변</div>
            <div className="col-span-1 text-right">평균응답</div>
            <div className="col-span-3">Top 미답변 클러스터</div>
            <div className="col-span-1 text-center">ggsan</div>
            <div className="col-span-1 text-right">게이트</div>
          </div>
          {rows.slice(0, 100).map((r) => (
            <details
              key={r.keyword}
              className={`rounded border ${
                r.isVacuumGate ? 'border-red-300 bg-red-50/40' : 'border-gray-200'
              }`}
            >
              <summary className="grid grid-cols-12 px-3 py-2 cursor-pointer items-center text-sm">
                <div className="col-span-3 font-medium truncate">{r.keyword}</div>
                <div className="col-span-1 text-right font-mono">{r.totalQ}</div>
                <div
                  className={`col-span-1 text-right font-mono font-semibold ${
                    r.answerRate < ANSWER_RATE_GATE ? 'text-red-700' : 'text-gray-700'
                  }`}
                >
                  {pct(r.answerRate)}
                </div>
                <div className="col-span-1 text-right font-mono">{r.unansweredQ}</div>
                <div className="col-span-1 text-right font-mono text-gray-600">{hrs(r.avgLagHours)}</div>
                <div className="col-span-3 truncate text-xs text-gray-600">
                  {r.topUnansweredCluster
                    ? `${r.topUnansweredCluster.cluster_label} (미답 ${r.topUnansweredCluster.unanswered_count})`
                    : '클러스터 미집계'}
                </div>
                <div className="col-span-1 text-center">
                  {r.hasGgsanMatch ? <span className="text-amber-700">●</span> : <span className="text-gray-300">·</span>}
                </div>
                <div className="col-span-1 text-right">
                  {r.isVacuumGate ? (
                    <span className="inline-block px-2 py-0.5 rounded text-xs bg-red-600 text-white font-semibold">
                      🔥
                    </span>
                  ) : (
                    <span className="text-gray-300 text-xs">–</span>
                  )}
                </div>
              </summary>

              <div className="px-4 py-3 border-t border-gray-100 space-y-3 text-sm">
                {r.clusters.length === 0 ? (
                  <div className="text-gray-500">
                    클러스터 미집계. <code className="px-1 bg-gray-100 rounded">recompute-qa-clusters.mjs</code>{' '}
                    실행 후 LLM 분류 결과 표시.
                  </div>
                ) : (
                  <div className="space-y-2">
                    {r.clusters.map((c) => {
                      const samples = sampleQs(c.sample_questions)
                      return (
                        <div
                          key={c.id}
                          className={`rounded border px-3 py-2 ${
                            c.is_vacuum_gate ? 'border-red-200 bg-white' : 'border-gray-200 bg-white/60'
                          }`}
                        >
                          <div className="flex items-baseline justify-between flex-wrap gap-2">
                            <div className="font-semibold">
                              {c.cluster_label}
                              {c.is_vacuum_gate && (
                                <span className="ml-2 inline-block px-1.5 py-0.5 rounded text-xs bg-red-100 text-red-700 font-medium">
                                  vacuum
                                </span>
                              )}
                            </div>
                            <div className="text-xs text-gray-500 font-mono">
                              총 {c.total_count} · 답변 {c.answered_count} · 미답 {c.unanswered_count} · 응답율 {pct(c.answer_rate)} · 평균 {hrs(c.avg_response_lag_hours)}
                            </div>
                          </div>
                          {samples.length > 0 && (
                            <ul className="mt-2 list-disc list-inside text-xs text-gray-700 space-y-0.5">
                              {samples.map((q, i) => (
                                <li key={i} className="truncate">{q}</li>
                              ))}
                            </ul>
                          )}
                          {c.faq_draft && (
                            <div className="mt-2 p-2 rounded bg-amber-50 border border-amber-200 text-xs whitespace-pre-wrap">
                              <div className="font-semibold text-amber-800 mb-1">자동 FAQ 초안</div>
                              {c.faq_draft}
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            </details>
          ))}
        </div>
      )}
    </div>
  )
}

function Kpi({ label, value, hint }: { label: string; value: number; hint: string }) {
  return (
    <div className="rounded border border-gray-200 p-4">
      <div className="text-xs text-gray-500">{label}</div>
      <div className="text-3xl font-bold mt-1">{value.toLocaleString()}</div>
      <div className="text-xs text-gray-400 mt-1">{hint}</div>
    </div>
  )
}

function EmptyState({ onlyGate, onlyGgsan }: { onlyGate: boolean; onlyGgsan: boolean }) {
  return (
    <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500">
      <p className="text-base font-medium">표시할 키워드 없음</p>
      <p className="text-sm mt-2">
        {onlyGate || onlyGgsan
          ? '필터 해제 후 다시 시도.'
          : 'Q&A 수집기 미실행. WSL 에서:'}
      </p>
      {!(onlyGate || onlyGgsan) && (
        <code className="inline-block mt-3 px-2 py-1 bg-gray-100 rounded text-xs">
          node --env-file=.env.local scripts/collect-qa.mjs --keyword="오메가3" --source=coupang
        </code>
      )}
    </div>
  )
}
