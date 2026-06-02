import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

interface Sample {
  snippet: string
  url: string | null
  source: string
  terms: string[]
  gap: number
  at: string
}

interface RankRow {
  keyword: string
  product_id: string | null
  mention_count: number
  supply_gap_score: number
  avg_gap: number
  last_mentioned_at: string
  sources: string[]
  samples: Sample[]
}

async function fetchRanking() {
  const sb = createAdminClient()
  // view 는 generated 타입 미반영 — restock_demand_radar.sql 적용 후 동작. 캐스팅 필요.
  const { data, error } = await sb
    .from('jimscanner_supply_gap_ranking' as never)
    .select('*')
    .order('supply_gap_score', { ascending: false })
    .limit(200)
  if (error) return { rows: [] as RankRow[], error: error.message }
  return { rows: (data ?? []) as unknown as RankRow[], error: null as string | null }
}

function sourceBadge(s: string): string {
  switch (s) {
    case 'naver_news':
      return '📰 뉴스'
    case 'naver_blog':
      return '✍ 블로그'
    case 'clien_park':
      return '🅒 클리앙'
    case 'quasarzone_sale':
      return '🅠 퀘이사핫딜'
    case 'google_suggest':
      return '🔎 구글자동완성'
    case 'kca_press':
      return '🏛 소비자원'
    case 'trends_keyword':
      return '📈 트렌드'
    default:
      return s
  }
}

function ago(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const h = Math.floor(diff / 3600_000)
  if (h < 1) return '방금'
  if (h < 24) return `${h}시간 전`
  return `${Math.floor(h / 24)}일 전`
}

export default async function RestockDemandPage() {
  const { rows, error } = await fetchRanking()

  const matched = rows.filter((r) => r.product_id)
  const unmatched = rows.filter((r) => !r.product_id)
  const totalMentions = rows.reduce((s, r) => s + Number(r.mention_count), 0)
  const topScore = rows.length ? Number(rows[0].supply_gap_score) : 0

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold">🔥 재입고 대란 레이더</h1>
          <p className="text-sm text-gray-500 mt-1">
            품절·오픈런·재입고문의 발화로 <strong>수요{'>'}공급</strong>이 드러난 순간을 포착 — 위탁 진입의 빈자리
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      <div className="rounded border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-900">
        <strong>읽는 법</strong> · supply_gap = Σ(공급실패 렉시콘 가중치). 단순 인기(velocity)·구매의도와 달리
        기존 공급의 <strong>실패</strong>가 곧 빈자리이므로 전환 확률이 높습니다. 발화 원문을 직접 확인하고 ggsan 소싱으로 연결하세요.
        <br />
        스캐너: <code className="font-mono">scripts/scan-supply-gap.mjs</code> (룰 기반, LLM 불필요)
      </div>

      <section className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Kpi label="공급갭 키워드" value={rows.length} />
        <Kpi label="🎯 상품 매칭" value={matched.length} highlight={matched.length > 0} />
        <Kpi label="총 발화" value={totalMentions} />
        <Kpi label="최고 강도" value={topScore.toFixed(1)} />
      </section>

      {error && (
        <div className="rounded border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800">
          뷰 에러: <code className="font-mono text-xs">{error}</code>
          <p className="text-xs mt-2 text-red-700">
            <code>jimscanner_supply_gap_ranking</code> 뷰 미적용 가능성. supabase/restock_demand_radar.sql 적용 후
            scripts/scan-supply-gap.mjs 1회 실행.
          </p>
        </div>
      )}

      {!error && rows.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500 space-y-2">
          <div className="text-base font-medium">아직 공급갭 시그널 없음</div>
          <div className="text-xs text-gray-400">
            마이그레이션 적용 후 <code>node --env-file=.env.local scripts/scan-supply-gap.mjs</code> 실행 →
            market_raw 누적분에서 자동 추출됩니다.
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          {[...matched, ...unmatched].map((r, i) => (
            <div
              key={`${r.keyword}-${r.product_id ?? 'none'}`}
              className={`rounded border overflow-hidden ${
                r.product_id ? 'border-emerald-200 bg-emerald-50/30' : 'border-gray-200'
              }`}
            >
              <div className="flex items-start gap-3 p-3">
                <div className="w-8 text-center text-sm font-mono text-gray-400 pt-1">{i + 1}</div>

                <div className="flex-1 min-w-0 space-y-2">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-base font-semibold">{r.keyword}</span>
                    {r.product_id ? (
                      <Link
                        href={`/admin/trend-radar/products/${r.product_id}`}
                        className="text-[11px] bg-emerald-100 text-emerald-800 px-2 py-0.5 rounded hover:bg-emerald-200"
                      >
                        canonical 매칭 ↗
                      </Link>
                    ) : (
                      <span className="text-[11px] bg-gray-100 text-gray-500 px-2 py-0.5 rounded">미매칭 발화</span>
                    )}
                    <span className="text-xs text-gray-400">{ago(r.last_mentioned_at)}</span>
                  </div>

                  {/* 발화 인용 스니펫 */}
                  <div className="space-y-1">
                    {(r.samples ?? []).map((s, j) => (
                      <div key={j} className="text-xs text-gray-600 flex items-start gap-2">
                        <span className="text-[10px] text-gray-400 whitespace-nowrap pt-0.5">{sourceBadge(s.source)}</span>
                        {s.url ? (
                          <a
                            href={s.url}
                            target="_blank"
                            rel="noopener"
                            className="hover:underline hover:text-black leading-snug"
                            title={s.snippet}
                          >
                            “{s.snippet}”
                          </a>
                        ) : (
                          <span className="leading-snug" title={s.snippet}>
                            “{s.snippet}”
                          </span>
                        )}
                      </div>
                    ))}
                  </div>

                  <div className="flex flex-wrap gap-2 text-[11px] text-gray-500">
                    <span>{(r.sources ?? []).map(sourceBadge).join(' · ')}</span>
                  </div>
                </div>

                {/* 점수 + 액션 */}
                <div className="text-right flex-shrink-0 space-y-1 w-28">
                  <div className="text-2xl font-bold font-mono text-red-600">{Number(r.supply_gap_score).toFixed(1)}</div>
                  <div className="text-[10px] text-gray-500">
                    {r.mention_count}건 · 평균 {Number(r.avg_gap).toFixed(1)}
                  </div>
                  <Link
                    href={`/admin/trend-radar/ggsan?q=${encodeURIComponent(r.keyword === '(미매칭)' ? '' : r.keyword)}`}
                    className="inline-block mt-1 text-[11px] bg-black text-white px-2 py-1 rounded hover:bg-gray-800"
                  >
                    ggsan 소싱 검색
                  </Link>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      <section className="text-xs text-gray-500 border-t border-gray-200 pt-4 space-y-1">
        <div className="font-semibold text-gray-700">📐 supply_gap 공식</div>
        <code className="block bg-gray-50 px-3 py-2 rounded font-mono text-[11px] leading-relaxed">
          supply_gap(발화) = Σ 렉시콘가중치 (오픈런·품귀·없어서못 ×3 / 재입고문의 ×2.5 / 품절·매진 ×1.5 …)
          <br />
          supply_gap_score(키워드) = Σ supply_gap (최근 30일)
        </code>
        <div className="pt-2">
          매칭된 canonical product 는 <code>jimscanner_trends_scores.score_components.supply_gap</code> 에 적재되어
          Opportunity·추천 점수 보강에 활용됩니다.
        </div>
      </section>
    </div>
  )
}

function Kpi({ label, value, highlight = false }: { label: string; value: number | string; highlight?: boolean }) {
  return (
    <div className={`rounded border p-3 ${highlight ? 'border-emerald-300 bg-emerald-50' : 'border-gray-200'}`}>
      <div className="text-xs text-gray-500">{label}</div>
      <div className={`text-2xl font-bold mt-1 ${highlight ? 'text-emerald-700' : ''}`}>
        {typeof value === 'number' ? value.toLocaleString() : value}
      </div>
    </div>
  )
}
