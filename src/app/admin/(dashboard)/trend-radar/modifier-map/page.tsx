import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import {
  summarizeSeeds,
  INTENT_META,
  type IntentStage,
  type SeedIntentSummary,
} from '@/lib/query-modifier'
import { IntentChips, IntentStageBar } from '@/components/intent-chips'

export const dynamic = 'force-dynamic'

async function fetchSummaries(): Promise<{
  summaries: SeedIntentSummary[]
  rawCount: number
}> {
  const sb = createAdminClient()
  // 최근 30일 적재된 google_suggest raw (raw 는 30일 후 폐기되므로 사실상 전량)
  const { data, error } = await sb
    .from('jimscanner_market_raw')
    .select('query, title')
    .eq('source', 'google_suggest')
    .limit(5000)

  if (error || !data) return { summaries: [], rawCount: 0 }
  const rows = data as unknown as { query: string | null; title: string | null }[]
  return { summaries: summarizeSeeds(rows), rawCount: rows.length }
}

const STAGE_ORDER: IntentStage[] = ['transaction', 'compare', 'spec', 'info', 'risk', 'other']

export default async function ModifierMapPage() {
  const { summaries, rawCount } = await fetchSummaries()

  // 전체 단계 합산 (상단 요약)
  const totals = summaries.reduce(
    (acc, s) => {
      STAGE_ORDER.forEach((st) => (acc[st] += s.byStage[st]))
      return acc
    },
    { info: 0, compare: 0, transaction: 0, spec: 0, risk: 0, other: 0 } as Record<
      IntentStage,
      number
    >,
  )
  const grandTotal = STAGE_ORDER.reduce((n, st) => n + totals[st], 0)
  const seedsWithRisk = summaries.filter((s) => s.riskModifiers.length > 0)

  return (
    <div className="space-y-6">
      <div>
        <div className="flex items-baseline justify-between">
          <h1 className="text-2xl font-bold text-gray-900">🌳 검색 수식어 인텐트 트리</h1>
          <Link
            href="/admin/market-signals"
            className="text-sm text-gray-500 hover:text-black"
          >
            시장 시그널 →
          </Link>
        </div>
        <p className="text-sm text-gray-500 mt-1 max-w-3xl">
          Google 자동완성 완성어에서 시드를 차감해 앞/뒤 수식어를 추출하고, 규칙 렉시콘으로
          인텐트 단계(거래·비교·사양·정보탐색·우려)로 분해합니다. 자동완성은 구매자가 실제로 친
          &lsquo;수요의 언어&rsquo; 입니다. (raw {rawCount.toLocaleString()}건 · 시드{' '}
          {summaries.length}개)
        </p>
      </div>

      {summaries.length === 0 ? (
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 text-sm text-amber-900">
          분석할 google_suggest 데이터가 없습니다. collect-google-suggest 크론이 적재한 뒤 다시
          확인해 주세요.
        </div>
      ) : (
        <>
          {/* 전체 인텐트 구성 */}
          <section className="rounded-lg border border-gray-200 p-4">
            <h2 className="text-sm font-semibold mb-3">전체 인텐트 구성 ({grandTotal} 수식어)</h2>
            <IntentStageBar byStage={totals} total={grandTotal} />
            <div className="mt-3 flex flex-wrap gap-3">
              {STAGE_ORDER.map((st) => {
                const meta = INTENT_META[st]
                const n = totals[st]
                const pct = grandTotal > 0 ? ((n / grandTotal) * 100).toFixed(0) : '0'
                return (
                  <div key={st} className="flex items-center gap-1.5 text-xs">
                    <span className={`inline-block w-3 h-3 rounded ${meta.color.split(' ')[0]}`} />
                    <span className="text-gray-700">
                      {meta.emoji} {meta.label}
                    </span>
                    <span className="font-mono text-gray-500">
                      {n} ({pct}%)
                    </span>
                  </div>
                )
              })}
            </div>
          </section>

          {/* 우려/리스크 조기경보 */}
          {seedsWithRisk.length > 0 && (
            <section className="rounded-lg border border-rose-200 bg-rose-50 p-4">
              <h2 className="text-sm font-semibold mb-2 text-rose-800">
                ⚠️ 위탁 리스크 조기경보 — 우려 수식어가 잡힌 시드 ({seedsWithRisk.length})
              </h2>
              <div className="flex flex-col gap-1.5">
                {seedsWithRisk.map((s) => (
                  <div key={s.seed} className="flex items-center gap-2 text-sm">
                    <span className="font-medium text-gray-900 min-w-[8rem]">{s.seed}</span>
                    <div className="flex flex-wrap gap-1">
                      {s.riskModifiers.map((m) => (
                        <span
                          key={m}
                          className="text-[11px] px-1.5 py-0.5 rounded bg-rose-100 text-rose-700 font-medium"
                        >
                          {m}
                        </span>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* 교차 시드 테이블 */}
          <section>
            <h2 className="text-sm font-semibold mb-2">
              시드별 인텐트 구성 (거래 비중 높은 순)
            </h2>
            <div className="rounded-lg border border-gray-200 overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 text-gray-500 text-xs">
                  <tr>
                    <th className="px-3 py-2 text-left">시드</th>
                    <th className="px-3 py-2 text-left w-40">인텐트 구성</th>
                    <th className="px-3 py-2 text-right">거래</th>
                    <th className="px-3 py-2 text-left">핵심 사양</th>
                    <th className="px-3 py-2 text-left">우려</th>
                    <th className="px-3 py-2 text-left">상위 수식어</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {summaries.map((s) => (
                    <tr key={s.seed} className="align-top">
                      <td className="px-3 py-2 font-medium text-gray-900 whitespace-nowrap">
                        {s.seed}
                        <div className="text-[10px] text-gray-400 font-normal">
                          완성어 {s.total} · 수식어 {s.modifierCount}
                        </div>
                      </td>
                      <td className="px-3 py-2">
                        <IntentStageBar byStage={s.byStage} total={s.modifierCount} />
                      </td>
                      <td className="px-3 py-2 text-right">
                        <span
                          className={`text-xs font-mono px-1.5 py-0.5 rounded ${
                            s.transactionRatio >= 0.3
                              ? 'bg-emerald-100 text-emerald-700 font-bold'
                              : 'text-gray-500'
                          }`}
                        >
                          {(s.transactionRatio * 100).toFixed(0)}%
                        </span>
                      </td>
                      <td className="px-3 py-2">
                        {s.specModifiers.length > 0 ? (
                          <div className="flex flex-wrap gap-1">
                            {s.specModifiers.map((m) => (
                              <span
                                key={m}
                                className="text-[11px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-700"
                              >
                                {m}
                              </span>
                            ))}
                          </div>
                        ) : (
                          <span className="text-xs text-gray-300">—</span>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        {s.riskModifiers.length > 0 ? (
                          <div className="flex flex-wrap gap-1">
                            {s.riskModifiers.map((m) => (
                              <span
                                key={m}
                                className="text-[11px] px-1.5 py-0.5 rounded bg-rose-100 text-rose-700"
                              >
                                {m}
                              </span>
                            ))}
                          </div>
                        ) : (
                          <span className="text-xs text-gray-300">—</span>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        <IntentChips
                          chips={s.topModifiers.map((m) => ({
                            modifier: m.modifier,
                            stage: m.stage,
                          }))}
                          max={10}
                        />
                      </td>
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
