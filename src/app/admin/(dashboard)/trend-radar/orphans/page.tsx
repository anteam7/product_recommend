import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import { PromoteButton } from './_components/PromoteButton'

export const dynamic = 'force-dynamic'

type SparkPoint = { d: string; c: number }

interface OrphanRow {
  keyword: string
  occurrences: number
  source_count: number
  sources: string[] | null
  velocity: number
  top_intent: string | null
  promotion_score: number
  spark: SparkPoint[] | null
  last_seen_at: string | null
}

const DAYS = 30

const SOURCE_LABEL: Record<string, string> = {
  naver_tvtime: '📺 TV홈쇼핑',
  naver_shopping_insight: '🛍 쇼핑인사이트',
  naver_shopping_hot: '🛍 쇼핑hot',
  naver_search_trend: '🔍 검색트렌드',
  naver_datalab: '📊 데이터랩',
  google_trends_kr: 'Ⓖ 구글',
  aliex_best: '🅰 알리',
  musinsa_best: '🅼 무신사',
}

function Sparkline({ data }: { data: SparkPoint[] }) {
  if (!data || data.length === 0) {
    return <span className="text-xs text-gray-300">—</span>
  }
  const w = 96
  const h = 24
  const vals = data.map((p) => Number(p.c) || 0)
  const max = Math.max(...vals, 1)
  const n = vals.length
  const pts = vals
    .map((v, i) => {
      const x = n === 1 ? w : (i / (n - 1)) * w
      const y = h - (v / max) * (h - 2) - 1
      return `${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')
  return (
    <svg width={w} height={h} className="text-emerald-500 overflow-visible">
      {n === 1 ? (
        <circle cx={w} cy={h - (vals[0] / max) * (h - 2) - 1} r="2" fill="currentColor" />
      ) : (
        <polyline points={pts} fill="none" stroke="currentColor" strokeWidth="1.5" />
      )}
    </svg>
  )
}

function whyMissed(row: OrphanRow): string {
  if (Number(row.source_count) <= 1) {
    return '단일 소스 수집 — 교차 검증 부족으로 canonicalization 미실행'
  }
  if (Number(row.velocity) > 0) {
    return '최근 급상승 — 매핑 룰/LLM 분류가 아직 못 따라잡음'
  }
  return '별칭(alias) 미생성 — product 집합에 한 번도 편입되지 않음'
}

export default async function OrphansPage() {
  const sb = createAdminClient()
  const { data, error } = await sb.rpc('jimscanner_orphan_keywords' as never, {
    days: DAYS,
    lim: 50,
  } as never)

  const rows = ((data ?? []) as OrphanRow[]) ?? []
  const err = error?.message ?? null

  const risingCount = rows.filter((r) => Number(r.velocity) > 0).length
  const crossSourceCount = rows.filter((r) => Number(r.source_count) > 1).length

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold">🕳 미발굴 키워드 승격 보드</h1>
          <p className="text-sm text-gray-500 mt-1">
            canonical product 로 한 번도 매핑되지 않은 고수요 키워드 (최근 {DAYS}일 ·
            commercial/transactional). 승격하면 다음 recompute부터 4점수·기회 사분면에 편입.
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      {/* 안내 */}
      <div className="rounded border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-900">
        <strong>왜 이 보드인가</strong> · 기존 발굴 도구는 모두 <em>이미 존재하는 product 집합</em>을
        재랭킹·필터링한다. 이 보드만이 canonicalization 누수를 메워 <strong>product 집합 자체를 확장</strong>하는
        surface다. 키워드 수집량은 product 수의 수십 배라 매핑 누락 수요가 구조적으로 쌓인다.
      </div>

      {/* KPI */}
      <section className="grid grid-cols-2 md:grid-cols-3 gap-3">
        <Kpi label="미발굴 키워드 (Top 50)" value={rows.length} highlight={rows.length > 0} />
        <Kpi label="상승세 (velocity > 0)" value={risingCount} />
        <Kpi label="다중 소스 교차" value={crossSourceCount} />
      </section>

      {err && (
        <div className="rounded border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800">
          RPC 에러: <code className="font-mono text-xs">{err}</code>
          <p className="text-xs mt-2 text-red-700">
            RPC <code>jimscanner_orphan_keywords</code> 미적용 가능성. supabase/trends_v5_orphan_keywords.sql 적용 필요.
          </p>
        </div>
      )}

      {/* 결과 테이블 */}
      {!err && rows.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500 space-y-2">
          <div className="text-base font-medium">미발굴 키워드가 없습니다</div>
          <div className="text-xs text-gray-400">
            모든 고수요(commercial/transactional) 키워드가 canonical product 로 매핑됨.
            <br />
            또는 trends_keywords 누적이 아직 부족 (WSL 수집 상태는 수집 상태 페이지 확인).
          </div>
        </div>
      ) : (
        <div className="overflow-x-auto rounded border border-gray-200">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-left text-xs text-gray-500">
              <tr>
                <th className="px-4 py-2">키워드</th>
                <th className="px-4 py-2">추세 ({DAYS}일)</th>
                <th className="px-4 py-2">소스</th>
                <th className="px-4 py-2 text-right">등장</th>
                <th className="px-4 py-2 text-right">속도</th>
                <th className="px-4 py-2 text-right">승격점수</th>
                <th className="px-4 py-2">왜 누락됐나</th>
                <th className="px-4 py-2 text-right">액션</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.keyword} className="border-t border-gray-100 align-top hover:bg-gray-50">
                  <td className="px-4 py-3 font-medium">
                    {r.keyword}
                    {r.top_intent && (
                      <span className="ml-2 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-600">
                        {r.top_intent}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <Sparkline data={r.spark ?? []} />
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap gap-1">
                      {(r.sources ?? []).map((s) => (
                        <span
                          key={s}
                          className="rounded-full bg-indigo-50 px-2 py-0.5 text-[10px] font-medium text-indigo-700"
                        >
                          {SOURCE_LABEL[s] ?? s}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-right font-mono tabular-nums">{r.occurrences}</td>
                  <td
                    className={
                      'px-4 py-3 text-right font-mono tabular-nums ' +
                      (Number(r.velocity) > 0 ? 'text-emerald-600' : 'text-gray-400')
                    }
                  >
                    {Number(r.velocity) > 0 ? '+' : ''}
                    {Number(r.velocity).toFixed(2)}
                  </td>
                  <td className="px-4 py-3 text-right font-mono font-bold tabular-nums text-amber-700">
                    {Number(r.promotion_score).toFixed(1)}
                  </td>
                  <td className="px-4 py-3 text-xs text-gray-500 max-w-xs">{whyMissed(r)}</td>
                  <td className="px-4 py-3 text-right">
                    <PromoteButton keyword={r.keyword} category={null} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* 공식 설명 */}
      <section className="text-xs text-gray-500 border-t border-gray-200 pt-4 space-y-1">
        <div className="font-semibold text-gray-700">📐 promotion_score 공식</div>
        <code className="block bg-gray-50 px-3 py-2 rounded font-mono text-[11px] leading-relaxed">
          promotion_score = occurrences × max(0.1, 1 + velocity) × (1 + 0.5 × (source_count − 1))
          <br />
          velocity = regr_slope(일별 등장수, 일)  ·  ANTI-JOIN: lower(btrim(keyword)) ∉ aliases
        </code>
        <div className="pt-2">
          승격 시 <code>jimscanner_trends_products</code>(canonical) +{' '}
          <code>jimscanner_trends_aliases</code>(confidence=1, source=manual) 를 생성한다.
        </div>
      </section>
    </div>
  )
}

function Kpi({ label, value, highlight = false }: { label: string; value: number; highlight?: boolean }) {
  return (
    <div className={`rounded border p-4 ${highlight ? 'border-rose-300 bg-rose-50' : 'border-gray-200'}`}>
      <div className="text-xs text-gray-500">{label}</div>
      <div className={`text-3xl font-bold mt-1 ${highlight ? 'text-rose-700' : ''}`}>
        {value.toLocaleString()}
      </div>
    </div>
  )
}
