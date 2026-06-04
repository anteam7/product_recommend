import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

interface AskRow {
  id: string
  ask_text: string
  category: string | null
  ask_count: number
  source_mix: Record<string, number> | null
  example_title: string | null
  example_url: string | null
  last_seen: string
}

interface RecoRow {
  id: string
  ask_id: string
  recommended_name: string
  mention_count: number
  sentiment: string | null
  matched_goods_no: string | null
}

async function fetchAsks(): Promise<AskRow[]> {
  const sb = createAdminClient()
  // 신규 테이블 — generated 타입 미반영. demand_asks.sql 적용 후 `npm run gen:types` 시 캐스팅 제거.
  const { data } = await sb
    .from('jimscanner_trends_demand_asks' as never)
    .select('id, ask_text, category, ask_count, source_mix, example_title, example_url, last_seen')
    .order('ask_count', { ascending: false })
    .order('last_seen', { ascending: false })
    .limit(100)
  return (data ?? []) as unknown as AskRow[]
}

async function fetchRecos(askId: string): Promise<RecoRow[]> {
  const sb = createAdminClient()
  const { data } = await sb
    .from('jimscanner_ask_recommendations' as never)
    .select('id, ask_id, recommended_name, mention_count, sentiment, matched_goods_no')
    .eq('ask_id', askId)
    .order('mention_count', { ascending: false })
    .limit(50)
  return (data ?? []) as unknown as RecoRow[]
}

function sentimentBadge(s: string | null): { label: string; cls: string } {
  switch (s) {
    case 'positive':
      return { label: '👍 호평', cls: 'bg-green-100 text-green-800' }
    case 'mixed':
      return { label: '🤔 호불호', cls: 'bg-amber-100 text-amber-800' }
    case 'negative':
      return { label: '👎 비추', cls: 'bg-red-100 text-red-800' }
    default:
      return { label: '· 중립', cls: 'bg-gray-100 text-gray-600' }
  }
}

function sourceMixLabel(mix: Record<string, number> | null): string {
  if (!mix) return ''
  return Object.entries(mix)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k.replace(/_/g, ' ')}×${v}`)
    .join(' · ')
}

export default async function DemandAsksPage({
  searchParams,
}: {
  searchParams: Promise<{ ask?: string }>
}) {
  const sp = await searchParams
  const asks = await fetchAsks()
  const selectedId = sp.ask && asks.some((a) => a.id === sp.ask) ? sp.ask : asks[0]?.id
  const recos = selectedId ? await fetchRecos(selectedId) : []
  const selected = asks.find((a) => a.id === selectedId)

  const totalAsks = asks.length
  const totalDemand = asks.reduce((s, a) => s + a.ask_count, 0)

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold">🙋 군중추천 위너 발굴 (추천요청 마이닝)</h1>
          <p className="text-sm text-gray-500 mt-1">
            커뮤니티 &apos;추천 좀&apos; 글 = 가장 순수한 능동 구매수요. 그 댓글 = 군중이 검증한 정답.
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      <div className="rounded border border-indigo-200 bg-indigo-50 px-4 py-3 text-xs text-indigo-900">
        <strong>파이프라인</strong> · collect-* 크론이 추천요청 글 적재 →{' '}
        <code className="font-mono">extract-demand-asks</code> 크론이 본문·댓글 fetch + Gemini 추출 → 좌측 반복요청 랭킹 + 우측 추천 리더보드.
        추천 위너는 ggsan/도매 매칭으로 소싱 후보 큐잉.
      </div>

      <section className="grid grid-cols-3 gap-3">
        <Kpi label="반복 추천요청" value={totalAsks} />
        <Kpi label="누적 능동수요" value={totalDemand} hint="ask_count 합" />
        <Kpi label="선택 요청 추천상품" value={recos.length} />
      </section>

      {totalAsks === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500 space-y-2">
          <div className="text-base font-medium">아직 추출된 추천요청이 없습니다</div>
          <div className="text-xs text-gray-400">
            1) <code>supabase/demand_asks.sql</code> 적용 · 2) collect-clien-park 크론이 추천요청 글 누적 ·
            3) <code>extract-demand-asks</code> 크론 실행 후 자동 채워짐.
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* 좌: 반복 추천요청 랭킹 */}
          <section className="space-y-2">
            <h2 className="text-sm font-semibold text-gray-700">📊 반복 추천요청 랭킹 (=미해결 능동수요)</h2>
            <div className="space-y-1">
              {asks.map((a, i) => (
                <Link
                  key={a.id}
                  href={`/admin/trend-radar/demand-asks?ask=${a.id}`}
                  scroll={false}
                  className={`block rounded border px-3 py-2 transition-colors ${
                    a.id === selectedId
                      ? 'border-indigo-400 bg-indigo-50'
                      : 'border-gray-200 hover:bg-gray-50'
                  }`}
                >
                  <div className="flex items-start gap-3">
                    <div className="w-6 text-center font-mono text-gray-400 pt-0.5">{i + 1}</div>
                    <div className="flex-1 min-w-0">
                      <div className="font-medium text-sm leading-snug">{a.ask_text}</div>
                      <div className="text-xs text-gray-500 mt-0.5 flex flex-wrap gap-2">
                        {a.category && (
                          <span className="bg-gray-100 px-1.5 rounded">{a.category}</span>
                        )}
                        <span className="text-gray-400">{sourceMixLabel(a.source_mix)}</span>
                      </div>
                    </div>
                    <div className="text-right flex-shrink-0">
                      <div className="text-lg font-bold font-mono text-indigo-700">{a.ask_count}</div>
                      <div className="text-[10px] text-gray-400">요청</div>
                    </div>
                  </div>
                </Link>
              ))}
            </div>
          </section>

          {/* 우: 추천 리더보드 */}
          <section className="space-y-2">
            <h2 className="text-sm font-semibold text-gray-700">🏆 군중 추천 리더보드 (=검증된 위너)</h2>
            {selected && (
              <div className="rounded border border-gray-200 bg-gray-50 px-3 py-2 text-xs text-gray-600">
                선택: <strong className="text-gray-800">{selected.ask_text}</strong>
                {selected.example_url && (
                  <>
                    {' · '}
                    <a
                      href={selected.example_url}
                      target="_blank"
                      rel="noopener"
                      className="text-indigo-600 underline"
                    >
                      원문 글 ↗
                    </a>
                  </>
                )}
              </div>
            )}
            {recos.length === 0 ? (
              <div className="rounded border border-dashed border-gray-300 p-8 text-center text-sm text-gray-500">
                이 요청의 댓글에서 추출된 추천 상품이 아직 없습니다.
                <br />
                <span className="text-xs text-gray-400">extract 크론이 댓글을 처리하면 채워집니다.</span>
              </div>
            ) : (
              <div className="space-y-1">
                {recos.map((r, i) => {
                  const sent = sentimentBadge(r.sentiment)
                  return (
                    <div
                      key={r.id}
                      className="flex items-center gap-3 rounded border border-gray-200 px-3 py-2"
                    >
                      <div className="w-6 text-center font-mono text-gray-400">{i + 1}</div>
                      <div className="flex-1 min-w-0">
                        <div className="font-medium text-sm">{r.recommended_name}</div>
                        <div className="flex gap-2 mt-0.5">
                          <span className={`text-[10px] px-1.5 rounded ${sent.cls}`}>{sent.label}</span>
                          {r.matched_goods_no && (
                            <span className="text-[10px] px-1.5 rounded bg-emerald-100 text-emerald-800">
                              ggsan {r.matched_goods_no}
                            </span>
                          )}
                        </div>
                      </div>
                      <div className="text-right flex-shrink-0">
                        <div className="text-base font-bold font-mono">{r.mention_count}</div>
                        <div className="text-[10px] text-gray-400">언급</div>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
            <p className="text-[11px] text-gray-400 pt-2 border-t border-gray-100">
              추천 위너 → ggsan/도매 매칭 시 <code>matched_goods_no</code> 표시. 매칭된 위너는 소싱 후보로 큐잉.
            </p>
          </section>
        </div>
      )}
    </div>
  )
}

function Kpi({ label, value, hint }: { label: string; value: number; hint?: string }) {
  return (
    <div className="rounded border border-gray-200 p-3">
      <div className="text-xs text-gray-500">{label}</div>
      <div className="text-2xl font-bold mt-1">{value.toLocaleString()}</div>
      {hint && <div className="text-[10px] text-gray-400 mt-0.5">{hint}</div>}
    </div>
  )
}
