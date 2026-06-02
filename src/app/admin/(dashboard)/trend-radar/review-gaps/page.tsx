import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

// supabase/trends_review_gaps.sql 적용 후 generated 타입 미반영 — `as any` 캐스팅
interface GapRow {
  id: string
  product_id: string | null
  search_keyword: string
  source_product_name: string | null
  complaint_tag: string
  complaint_label: string | null
  freq: number
  severity: number
  evidence_count: number
  sample_quotes: string[]
  sourcing_query: string | null
  computed_at: string
}

async function fetchGaps() {
  const sb = createAdminClient()
  const { data, error } = await (sb as any)
    .from('jimscanner_trends_review_gaps')
    .select('*')
    .order('computed_at', { ascending: false })
    .limit(1000)
  if (error) return { groups: [], error: error.message as string }

  const rows = (data ?? []) as GapRow[]
  // 키워드별 그룹화 — 같은 키워드의 최신 computed_at batch 만 keep
  const byKw = new Map<string, GapRow[]>()
  for (const r of rows) {
    const arr = byKw.get(r.search_keyword) ?? []
    arr.push(r)
    byKw.set(r.search_keyword, arr)
  }
  const groups = [...byKw.entries()].map(([keyword, gaps]) => {
    const latestBatch = gaps[0]?.computed_at?.slice(0, 10)
    const cur = gaps.filter((g) => g.computed_at.slice(0, 10) === latestBatch)
    // severity × evidence 가중 정렬
    cur.sort((a, b) => b.severity * (b.evidence_count || 1) - a.severity * (a.evidence_count || 1))
    return {
      keyword,
      computedAt: gaps[0]?.computed_at ?? '',
      repName: cur.find((g) => g.source_product_name)?.source_product_name ?? null,
      gaps: cur,
    }
  })
  // 가장 심각한 갭 보유 키워드 우선
  groups.sort((a, b) => {
    const sa = a.gaps[0] ? a.gaps[0].severity * (a.gaps[0].evidence_count || 1) : 0
    const sb2 = b.gaps[0] ? b.gaps[0].severity * (b.gaps[0].evidence_count || 1) : 0
    return sb2 - sa
  })
  return { groups, error: null as string | null }
}

function sevColor(sev: number): string {
  if (sev >= 4) return 'bg-red-100 text-red-700'
  if (sev === 3) return 'bg-amber-100 text-amber-700'
  return 'bg-gray-100 text-gray-600'
}

export default async function ReviewGapsPage() {
  const { groups, error } = await fetchGaps()

  const totalKw = groups.length
  const totalGaps = groups.reduce((s, g) => s + g.gaps.length, 0)
  const criticalKw = groups.filter((g) => g.gaps.some((x) => x.severity >= 4)).length

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold">🔍 경쟁 리뷰 불만 갭</h1>
          <p className="text-sm text-gray-500 mt-1">
            쿠팡 SERP 상위 리스팅의 저별점 리뷰에서 추출한 미충족 불만 — 시장 1위가 못 고친 약점을 변형 소싱으로 공략
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      <div className="rounded border border-blue-200 bg-blue-50 px-4 py-3 text-xs text-blue-900">
        <strong>차별화 레버</strong> · 위탁 1인셀러는 가격·물류로 못 이긴다. 유일한 무기는 <strong>&apos;같은 상품을 더 잘 고른 변형&apos;</strong>.
        경쟁사 리뷰의 반복 불만 = ggsan 에서 찾을 변형의 스펙. 각 불만의 <strong>소싱 검색어</strong>로 바로 발굴하라.
        <br />
        수집: <code className="font-mono">node scripts/coupang-review-gap.mjs --kw=&quot;무선청소기,저소음 가습기&quot;</code>
      </div>

      <section className="grid grid-cols-3 gap-3">
        <Kpi label="분석된 키워드" value={totalKw} />
        <Kpi label="불만 군집" value={totalGaps} />
        <Kpi label="🔴 심각(sev≥4) 보유" value={criticalKw} highlight={criticalKw > 0} />
      </section>

      {error && (
        <div className="rounded border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800">
          조회 에러: <code className="font-mono text-xs">{error}</code>
          <p className="text-xs mt-2 text-red-700">
            테이블 <code>jimscanner_trends_review_gaps</code> 미적용 가능성. <code>supabase/trends_review_gaps.sql</code> 적용 필요.
          </p>
        </div>
      )}

      {!error && groups.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500 space-y-2">
          <div className="text-base font-medium">수집된 리뷰 갭 없음</div>
          <div className="text-xs text-gray-400">
            먼저 후보 키워드로 수집을 돌려라:
            <br />
            <code className="px-1 bg-gray-100 rounded">node scripts/coupang-review-gap.mjs --kw=&quot;무선청소기&quot;</code>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          {groups.map((g) => {
            const top3 = g.gaps.slice(0, 3)
            return (
              <section key={g.keyword} className="rounded border border-gray-200 overflow-hidden">
                <div className="flex items-baseline justify-between flex-wrap gap-2 bg-gray-50 px-4 py-2 border-b border-gray-200">
                  <div>
                    <span className="text-sm font-semibold">{g.keyword}</span>
                    {g.repName && (
                      <span className="text-xs text-gray-500 ml-2 truncate" title={g.repName}>
                        대표 리스팅: {g.repName.slice(0, 40)}
                      </span>
                    )}
                  </div>
                  <span className="text-[10px] text-gray-400 font-mono">{g.computedAt.slice(0, 16).replace('T', ' ')}</span>
                </div>

                {/* 못 고친 불만 Top3 → 변형 소싱 카드 */}
                <div className="grid md:grid-cols-3 divide-y md:divide-y-0 md:divide-x divide-gray-100">
                  {top3.map((gap, i) => (
                    <div key={gap.id} className="p-3 space-y-2">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-xs font-semibold text-gray-700">
                          #{i + 1} {gap.complaint_label ?? gap.complaint_tag}
                        </span>
                        <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${sevColor(gap.severity)}`}>
                          sev {gap.severity} · {gap.evidence_count}건
                        </span>
                      </div>
                      {gap.sample_quotes?.length > 0 && (
                        <ul className="space-y-1">
                          {gap.sample_quotes.slice(0, 2).map((q, qi) => (
                            <li key={qi} className="text-[11px] text-gray-500 leading-snug border-l-2 border-gray-200 pl-2">
                              &ldquo;{q}&rdquo;
                            </li>
                          ))}
                        </ul>
                      )}
                      {gap.sourcing_query && (
                        <a
                          href={`/admin/trend-radar/ggsan?q=${encodeURIComponent(gap.sourcing_query)}`}
                          className="inline-flex items-center gap-1 text-[11px] font-medium text-blue-700 hover:text-blue-900 hover:underline"
                        >
                          🛒 변형 소싱: &ldquo;{gap.sourcing_query}&rdquo; →
                        </a>
                      )}
                    </div>
                  ))}
                </div>

                {/* 나머지 군집 (간단) */}
                {g.gaps.length > 3 && (
                  <div className="px-4 py-2 border-t border-gray-100 flex flex-wrap gap-2">
                    {g.gaps.slice(3).map((gap) => (
                      <span key={gap.id} className="text-[10px] px-2 py-0.5 rounded bg-gray-100 text-gray-500">
                        {gap.complaint_label ?? gap.complaint_tag} ({gap.evidence_count})
                      </span>
                    ))}
                  </div>
                )}
              </section>
            )
          })}
        </div>
      )}
    </div>
  )
}

function Kpi({ label, value, highlight = false }: { label: string; value: number; highlight?: boolean }) {
  return (
    <div className={`rounded border p-3 ${highlight ? 'border-red-300 bg-red-50' : 'border-gray-200'}`}>
      <div className="text-xs text-gray-500">{label}</div>
      <div className={`text-2xl font-bold mt-1 ${highlight ? 'text-red-700' : ''}`}>{value.toLocaleString()}</div>
    </div>
  )
}
