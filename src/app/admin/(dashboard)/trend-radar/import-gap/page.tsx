import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

// supabase/trends_v5_import_gap.sql VIEW 의 행 (generated 타입 미반영 → `as any` 캐스팅)
interface GapRow {
  product_id: string
  canonical_name: string
  category_top: string | null
  category_mid: string | null
  brand: string | null
  last_seen_at: string
  alias_count: number

  has_demand: boolean
  has_foreign: boolean
  has_domestic: boolean
  demand_sources: string[]
  foreign_sources: string[]
  domestic_sources: string[]
  alias_total: number

  presence_gap: boolean

  trend_score: number | null
  commerce_score: number | null
  supplier_score: number | null
  competition_score: number | null
  final_score: number
  computed_at: string | null

  has_ggsan: boolean
  ggsan_goods_no: string | null
  ggsan_title: string | null
  ggsan_price_krw: number | null
  ggsan_detail_url: string | null
  ggsan_sim: number | null

  aliexpress_kr_direct: boolean
  aliexpress_min_krw: number | null
}

const SOURCE_LABEL: Record<string, string> = {
  '82cook_talk': '82쿡',
  natepan_ranking: '네판',
  dcinside_realtime: 'DC',
  ppomppu_main: '뽐뿌',
  daum_news: '다음뉴스',
  naver_news: '네이버뉴스',
  naver_tvtime: 'TV타임',
  aliex_best: '알리',
  musinsa_best: '무신사',
  '1688': '1688',
  naver_shopping_hot: '쇼핑hot',
  naver_shopping_insight: '쇼핑인사이트',
  domeggook_main: '도매꾹',
  coupang: '쿠팡',
}

function srcLabel(s: string): string {
  return SOURCE_LABEL[s] ?? s
}

async function fetchData() {
  const sb = createAdminClient()
  // VIEW 는 generated 타입에 없음 — `as any` 로 우회 (적용 후 gen:types 시 캐스팅 제거)
  const { data, error } = await (sb as any)
    .from('jimscanner_trends_v5_import_gap')
    .select('*')
    .limit(1000)

  if (error) return { rows: [] as GapRow[], error: error.message as string }
  return { rows: (data ?? []) as GapRow[], error: null as string | null }
}

// 국내 쇼핑 검색어 자동생성 — 네이버쇼핑에서 직접 국내 리테일 부재 재확인
function naverShoppingSearchUrl(name: string): string {
  return `https://search.shopping.naver.com/search/all?query=${encodeURIComponent(name)}`
}
function coupangSearchUrl(name: string): string {
  return `https://www.coupang.com/np/search?q=${encodeURIComponent(name)}`
}

function BucketBadge({ on, label }: { on: boolean; label: string }) {
  return (
    <span
      className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-mono ${
        on ? 'bg-emerald-100 text-emerald-700 font-semibold' : 'bg-gray-100 text-gray-300'
      }`}
      title={on ? `${label} ON` : `${label} OFF`}
    >
      {on ? '●' : '○'} {label}
    </span>
  )
}

export default async function ImportGapPage({
  searchParams,
}: {
  searchParams: Promise<{ gap?: string }>
}) {
  const sp = await searchParams
  const gapOnly = sp.gap !== '0' // 기본: 선점 후보만

  const { rows, error } = await fetchData()

  const visible = gapOnly ? rows.filter((r) => r.presence_gap) : rows

  // KPI
  const gapCount = rows.filter((r) => r.presence_gap).length
  const gapWithGgsan = rows.filter((r) => r.presence_gap && r.has_ggsan).length
  const dumpingCount = rows.filter((r) => r.presence_gap && r.aliexpress_kr_direct).length
  const total = rows.length

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold">🛂 수입 선점 갭 레이더</h1>
          <p className="text-sm text-gray-500 mt-1">
            수요 ON ∧ 해외공급 ON ∧ <strong>국내리테일 OFF</strong> = 국내 셀러 부재 = 위탁 1인 셀러 선점 후보
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      {/* 버킷 정의 */}
      <div className="rounded border border-gray-200 bg-gray-50 px-4 py-3 text-xs text-gray-600 space-y-1">
        <div>
          <strong>① 수요</strong> 82쿡·네판·DC·뽐뿌·다음/네이버뉴스·TV타임 ·{' '}
          <strong>② 해외공급</strong> 알리·무신사·1688 ·{' '}
          <strong>③ 국내리테일</strong> 쇼핑hot·쇼핑인사이트·도매꾹·쿠팡
        </div>
        <div className="text-gray-400">
          alias.source 분포로 버킷 등장 여부를 집계 (supabase/trends_v5_import_gap.sql).
          회색 강등 = 알리/테무 KR 직배 저가 존재(직구덤핑 리스크).
        </div>
      </div>

      {error && (
        <div className="rounded border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800">
          VIEW 에러: <code className="font-mono text-xs">{error}</code>
          <p className="text-xs mt-2 text-red-700">
            VIEW <code>jimscanner_trends_v5_import_gap</code> 미적용 가능성 —
            supabase/trends_v5_import_gap.sql 적용 필요.
          </p>
        </div>
      )}

      {/* KPI */}
      <section className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Kpi label="🎯 선점 후보" value={gapCount} highlight={gapCount > 0} />
        <Kpi label="ggsan 소싱 가능" value={gapWithGgsan} />
        <Kpi label="⚠ 직구덤핑 리스크" value={dumpingCount} />
        <Kpi label="전체 상품" value={total} />
      </section>

      {/* 필터 */}
      <div className="flex items-center gap-2">
        <Link
          href="/admin/trend-radar/import-gap"
          className={`px-3 py-1 text-xs rounded ${gapOnly ? 'bg-emerald-100 text-emerald-700 font-semibold' : 'text-gray-500 hover:text-black'}`}
        >
          🎯 선점 후보만
        </Link>
        <Link
          href="/admin/trend-radar/import-gap?gap=0"
          className={`px-3 py-1 text-xs rounded ${!gapOnly ? 'bg-black text-white font-semibold' : 'text-gray-500 hover:text-black'}`}
        >
          전체 매트릭스
        </Link>
      </div>

      {/* 테이블 */}
      {visible.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500 space-y-2">
          <div className="text-base font-medium">
            {gapOnly ? '선점 후보 없음' : '데이터 없음'}
          </div>
          <div className="text-xs text-gray-400">
            alias.source 가 3개 버킷에 충분히 누적되어야 갭이 드러남. cron 누적 후 재방문.
          </div>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="border-b border-gray-300 text-left text-xs text-gray-500">
                <th className="py-2 pr-2 w-8">#</th>
                <th className="py-2 pr-2">상품</th>
                <th className="py-2 px-2">버킷 매트릭스</th>
                <th className="py-2 px-2 text-right">final</th>
                <th className="py-2 px-2">ggsan</th>
                <th className="py-2 px-2">국내 재확인</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((r, i) => {
                const dumped = r.aliexpress_kr_direct
                return (
                  <tr
                    key={r.product_id}
                    className={`border-b border-gray-100 align-top ${
                      dumped
                        ? 'bg-gray-50 text-gray-400'
                        : r.presence_gap
                          ? 'bg-emerald-50/40'
                          : ''
                    }`}
                  >
                    <td className="py-2 pr-2 font-mono text-xs text-gray-400">{i + 1}</td>
                    <td className="py-2 pr-2">
                      <div className={`font-medium leading-snug ${dumped ? 'line-through' : ''}`}>
                        {r.canonical_name}
                      </div>
                      <div className="text-[11px] text-gray-400">
                        {r.category_top}
                        {r.category_mid ? ` · ${r.category_mid}` : ''}
                        {r.brand ? ` · ${r.brand}` : ''}
                        {' · '}alias {r.alias_total}
                      </div>
                      {dumped && (
                        <div className="text-[10px] text-amber-600 mt-0.5">
                          ⚠ 알리/테무 KR 직배 저가
                          {r.aliexpress_min_krw ? ` ~${r.aliexpress_min_krw.toLocaleString()}원` : ''} — 강등
                        </div>
                      )}
                    </td>
                    <td className="py-2 px-2">
                      <div className="flex flex-wrap gap-1 mb-1">
                        <BucketBadge on={r.has_demand} label="수요" />
                        <BucketBadge on={r.has_foreign} label="해외" />
                        <BucketBadge on={r.has_domestic} label="국내" />
                      </div>
                      <div className="text-[10px] text-gray-400 leading-tight">
                        {[...(r.demand_sources ?? []), ...(r.foreign_sources ?? []), ...(r.domestic_sources ?? [])]
                          .map(srcLabel)
                          .join(' · ')}
                      </div>
                    </td>
                    <td className="py-2 px-2 text-right">
                      <span className="font-mono font-bold text-base">
                        {Number(r.final_score).toFixed(1)}
                      </span>
                    </td>
                    <td className="py-2 px-2">
                      {r.has_ggsan ? (
                        <a
                          href={r.ggsan_detail_url ?? '#'}
                          target="_blank"
                          rel="noopener"
                          className="text-xs text-emerald-700 hover:underline"
                          title={r.ggsan_title ?? ''}
                        >
                          ✓ {r.ggsan_goods_no}
                          {r.ggsan_price_krw ? ` · ${r.ggsan_price_krw.toLocaleString()}원` : ''}
                          <span className="text-gray-400">
                            {' '}
                            (sim {r.ggsan_sim != null ? Number(r.ggsan_sim).toFixed(2) : '?'})
                          </span>
                        </a>
                      ) : (
                        <span className="text-xs text-gray-300">소싱 미발견</span>
                      )}
                    </td>
                    <td className="py-2 px-2">
                      <div className="flex flex-col gap-0.5 text-xs">
                        <a
                          href={naverShoppingSearchUrl(r.canonical_name)}
                          target="_blank"
                          rel="noopener"
                          className="text-blue-600 hover:underline"
                        >
                          🛍 네이버쇼핑
                        </a>
                        <a
                          href={coupangSearchUrl(r.canonical_name)}
                          target="_blank"
                          rel="noopener"
                          className="text-blue-600 hover:underline"
                        >
                          🟦 쿠팡 검색
                        </a>
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* 설명 */}
      <section className="text-xs text-gray-500 border-t border-gray-200 pt-4 space-y-1">
        <div className="font-semibold text-gray-700">📐 선점 판정 로직</div>
        <code className="block bg-gray-50 px-3 py-2 rounded font-mono text-[11px] leading-relaxed">
          presence_gap = has_demand ∧ has_foreign ∧ ¬has_domestic
          <br />
          정렬 = presence_gap DESC, final_score DESC
          <br />
          회색 강등 = aliexpress_kr_direct (알리/테무 KR 직배 lead_time ≤ 14d)
        </code>
        <div className="pt-1 text-gray-400">
          국내리테일 OFF 는 수집 소스(쇼핑hot/도매꾹/쿠팡 alias) 부재일 뿐 절대 부재 보장 아님 —
          행마다 네이버쇼핑·쿠팡 검색으로 1차 재확인 필수.
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
