import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

interface MarginRow {
  goods_no: string
  title: string
  cate_cd: string | null
  cate_label: string | null
  wholesale_krw: number | null
  image_url: string | null
  detail_url: string | null
  is_imminent: boolean
  status: string | null
  retail_min_krw: number | null
  retail_med_krw: number | null
  retail_max_krw: number | null
  listing_count: number | null
  probed_at: string | null
  margin_pct: number | null
  gross_profit_krw: number | null
}

const SORT_OPTIONS = [
  { v: 'margin', label: '마진율 ▾' },
  { v: 'profit', label: '단위수익 ▾' },
  { v: 'competition', label: '경쟁 적은순 ▴' },
] as const
type SortKey = (typeof SORT_OPTIONS)[number]['v']

const CATEGORIES: { code: string; label: string }[] = [
  { code: '001', label: '장건강' },
  { code: '002', label: '눈건강' },
  { code: '003', label: '간건강' },
  { code: '005', label: '혈행건강' },
  { code: '006', label: '관절건강' },
  { code: '007', label: '면역건강' },
  { code: '008', label: '체지방' },
  { code: '009', label: '건기식기타' },
  { code: '010', label: '전통건강식품' },
  { code: '011', label: '전립선' },
  { code: '012', label: '식품분말' },
  { code: '013', label: '가공식품기타' },
  { code: '014', label: '신선식품' },
  { code: '020', label: '임박특가' },
]

async function fetchMargin() {
  const sb = createAdminClient()
  // jimscanner_margin_candidates 는 generated 타입 미반영 — `npm run gen:types` 시 캐스팅 제거
  const { data, error } = await (sb as unknown as {
    from: (t: string) => {
      select: (s: string) => { limit: (n: number) => Promise<{ data: MarginRow[] | null; error: { message: string } | null }> }
    }
  })
    .from('jimscanner_margin_candidates')
    .select(
      'goods_no,title,cate_cd,cate_label,wholesale_krw,image_url,detail_url,is_imminent,status,retail_min_krw,retail_med_krw,retail_max_krw,listing_count,probed_at,margin_pct,gross_profit_krw',
    )
    .limit(500)
  if (error) return { rows: [] as MarginRow[], error: error.message }
  return { rows: (data ?? []) as MarginRow[], error: null as string | null }
}

function buildHref(current: Record<string, string>, override: Record<string, string | null>): string {
  const params = new URLSearchParams()
  for (const [k, v] of Object.entries(current)) if (v) params.set(k, v)
  for (const [k, v] of Object.entries(override)) {
    if (v == null || v === '') params.delete(k)
    else params.set(k, v)
  }
  const qs = params.toString()
  return '/admin/trend-radar/margin' + (qs ? `?${qs}` : '')
}

function fmtKrw(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—'
  return `${n.toLocaleString()}원`
}

function fmtPct(p: number | null | undefined): string {
  if (p == null || !Number.isFinite(p)) return '—'
  return `${(p * 100).toFixed(1)}%`
}

function probedAgo(iso: string | null): string {
  if (!iso) return '미수집'
  const ms = Date.now() - new Date(iso).getTime()
  const days = Math.floor(ms / 86400000)
  if (days >= 1) return `${days}일 전`
  const hrs = Math.floor(ms / 3600000)
  if (hrs >= 1) return `${hrs}시간 전`
  return '방금'
}

export default async function MarginPage({
  searchParams,
}: {
  searchParams: Promise<{ sort?: string; cate?: string; imminent?: string; min_margin?: string }>
}) {
  const sp = await searchParams
  const sort: SortKey = (SORT_OPTIONS.find((s) => s.v === sp.sort)?.v ?? 'margin') as SortKey
  const cate = sp.cate ?? ''
  const imminentOnly = sp.imminent === '1'
  const minMargin = parseFloat(sp.min_margin ?? '0')
  const validMin = Number.isFinite(minMargin) ? minMargin : 0

  const current: Record<string, string> = {
    sort,
    cate,
    imminent: imminentOnly ? '1' : '',
    min_margin: validMin > 0 ? String(validMin) : '',
  }

  const { rows: all, error } = await fetchMargin()

  // 필터 + 정렬
  let rows = all.filter((r) => r.retail_med_krw != null && r.wholesale_krw != null)
  if (cate) rows = rows.filter((r) => r.cate_cd === cate)
  if (imminentOnly) rows = rows.filter((r) => r.is_imminent)
  if (validMin > 0) rows = rows.filter((r) => (r.margin_pct ?? -1) >= validMin)

  if (sort === 'margin') {
    rows.sort((a, b) => (b.margin_pct ?? -1) - (a.margin_pct ?? -1))
  } else if (sort === 'profit') {
    rows.sort((a, b) => (b.gross_profit_krw ?? -1) - (a.gross_profit_krw ?? -1))
  } else if (sort === 'competition') {
    rows.sort(
      (a, b) =>
        (a.listing_count ?? Number.MAX_SAFE_INTEGER) - (b.listing_count ?? Number.MAX_SAFE_INTEGER),
    )
  }
  rows = rows.slice(0, 200)

  // KPI
  const probedCount = all.filter((r) => r.retail_med_krw != null).length
  const unprobedCount = all.length - probedCount
  const avgMargin =
    rows.length > 0
      ? rows.reduce((s, r) => s + (r.margin_pct ?? 0), 0) / rows.length
      : 0
  const totalProfit = rows.reduce((s, r) => s + (r.gross_profit_krw ?? 0), 0)
  const profitableCount = rows.filter((r) => (r.gross_profit_krw ?? 0) > 0).length

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold">💰 마진 후보 (V0)</h1>
          <p className="text-sm text-gray-500 mt-1">
            ggsan 도매가 × Naver Shopping 리테일 중앙가 — 단위 수익·마진율·경쟁 강도 3축 정렬
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      <div className="rounded border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-900">
        <strong>V0 안내</strong> · margin_pct = (retail_med − wholesale) / retail_med ·
        retail_med 는 Naver Shopping API 검색 결과 lprice 중앙값. listing_count 는 시장 등록상품수(경쟁).
        probe 미수집 상품은 목록에서 제외. 수집: <code>node --env-file=.env.local scripts/probe-retail-prices.mjs</code>
      </div>

      {/* 필터 */}
      <div className="rounded border border-gray-200 px-4 py-3 space-y-3">
        <div className="flex flex-wrap items-center gap-4">
          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-500">정렬</span>
            {SORT_OPTIONS.map((s) => (
              <Link
                key={s.v}
                href={buildHref(current, { sort: s.v })}
                className={`px-2 py-1 text-xs rounded ${
                  sort === s.v
                    ? 'bg-amber-100 text-amber-700 font-semibold'
                    : 'text-gray-500 hover:text-black'
                }`}
              >
                {s.label}
              </Link>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-500">마진율 ≥</span>
            {[0, 0.2, 0.4, 0.6].map((m) => (
              <Link
                key={m}
                href={buildHref(current, { min_margin: m > 0 ? String(m) : null })}
                className={`px-2 py-1 text-xs rounded ${
                  Math.abs(validMin - m) < 0.001
                    ? 'bg-amber-100 text-amber-700 font-semibold'
                    : 'text-gray-500 hover:text-black'
                }`}
              >
                {m === 0 ? '전체' : `${(m * 100).toFixed(0)}%`}
              </Link>
            ))}
          </div>
          <Link
            href={buildHref(current, { imminent: imminentOnly ? null : '1' })}
            className={`px-3 py-1 text-xs rounded ${
              imminentOnly
                ? 'bg-red-100 text-red-700 font-semibold'
                : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
            }`}
          >
            {imminentOnly ? '✓ ' : ''}임박특가만
          </Link>
        </div>
        <div className="flex flex-wrap gap-1 border-t border-gray-100 pt-2">
          <Link
            href={buildHref(current, { cate: null })}
            className={`px-2 py-1 text-xs rounded ${
              cate === '' ? 'bg-black text-white font-semibold' : 'text-gray-500 hover:text-black'
            }`}
          >
            전체
          </Link>
          {CATEGORIES.map((c) => (
            <Link
              key={c.code}
              href={buildHref(current, { cate: c.code })}
              className={`px-2 py-1 text-xs rounded ${
                cate === c.code
                  ? 'bg-black text-white font-semibold'
                  : 'text-gray-500 hover:text-black'
              }`}
            >
              {c.label}
            </Link>
          ))}
        </div>
      </div>

      {/* KPI */}
      <section className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <Kpi label="후보 (probe 적용)" value={rows.length} />
        <Kpi label="수익 +α" value={profitableCount} highlight={profitableCount > 0} />
        <Kpi label="평균 마진율" value={fmtPct(avgMargin)} />
        <Kpi label="단위수익 합" value={fmtKrw(totalProfit)} />
        <Kpi label="미수집 ggsan" value={unprobedCount} />
      </section>

      {error && (
        <div className="rounded border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800">
          DB 에러: <code className="font-mono text-xs">{error}</code>
          <p className="text-xs mt-2 text-red-700">
            view <code>jimscanner_margin_candidates</code> 미적용 가능성.{' '}
            <code>supabase/retail_price_probes.sql</code> 적용 필요.
          </p>
        </div>
      )}

      {!error && rows.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500 space-y-2">
          <div className="text-base font-medium">조건에 맞는 후보 없음</div>
          <div className="text-xs text-gray-400">
            아직 retail probe 가 적재되지 않았거나 필터가 너무 엄격합니다.
            <br />
            <code>node --env-file=.env.local scripts/probe-retail-prices.mjs 50</code> 실행 후 재시도.
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          {rows.map((r, i) => {
            const marginPct = r.margin_pct ?? 0
            const profit = r.gross_profit_krw ?? 0
            const profitable = profit > 0
            return (
              <a
                key={r.goods_no}
                href={r.detail_url ?? '#'}
                target="_blank"
                rel="noopener"
                className={`block rounded border overflow-hidden hover:shadow-sm transition-all ${
                  profitable
                    ? 'border-emerald-200 bg-emerald-50/40 hover:bg-emerald-50'
                    : 'border-gray-200 hover:bg-gray-50'
                }`}
              >
                <div className="flex items-start gap-3 p-3">
                  <div className="w-8 text-center text-sm font-mono text-gray-400 pt-1">{i + 1}</div>
                  <div className="w-20 h-20 bg-gray-100 rounded overflow-hidden flex-shrink-0 relative">
                    {r.image_url && (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={r.image_url} alt="" loading="lazy" className="w-full h-full object-cover" />
                    )}
                    {r.is_imminent && (
                      <span className="absolute top-0 left-0 bg-red-600 text-white text-[9px] px-1 leading-tight rounded-br">
                        임박
                      </span>
                    )}
                  </div>
                  <div className="flex-1 min-w-0 space-y-1">
                    <div className="text-sm font-medium leading-snug" title={r.title}>
                      {r.title}
                    </div>
                    <div className="text-xs text-gray-500">
                      {r.cate_label ?? r.cate_cd ?? '—'} · {r.goods_no}
                    </div>
                    <div className="flex flex-wrap gap-2 text-xs pt-1">
                      <span className="bg-gray-100 text-gray-700 px-2 py-0.5 rounded">
                        도매 {fmtKrw(r.wholesale_krw)}
                      </span>
                      <span className="bg-blue-100 text-blue-800 px-2 py-0.5 rounded">
                        리테일 중앙 {fmtKrw(r.retail_med_krw)}
                      </span>
                      <span className="text-gray-500">
                        ({fmtKrw(r.retail_min_krw)} ~ {fmtKrw(r.retail_max_krw)})
                      </span>
                      <span
                        className={`px-2 py-0.5 rounded ${
                          (r.listing_count ?? 0) > 1000
                            ? 'bg-red-100 text-red-700'
                            : (r.listing_count ?? 0) > 200
                              ? 'bg-amber-100 text-amber-700'
                              : 'bg-emerald-100 text-emerald-700'
                        }`}
                      >
                        경쟁 {r.listing_count?.toLocaleString() ?? '?'}건
                      </span>
                      <span className="text-gray-400">· {probedAgo(r.probed_at)}</span>
                    </div>
                  </div>
                  <div className="text-right flex-shrink-0 space-y-1">
                    <div
                      className={`text-2xl font-bold font-mono ${
                        marginPct >= 0.4
                          ? 'text-emerald-700'
                          : marginPct >= 0.2
                            ? 'text-amber-700'
                            : marginPct > 0
                              ? 'text-gray-700'
                              : 'text-red-700'
                      }`}
                    >
                      ▴{fmtPct(marginPct)}
                    </div>
                    <div className={`text-sm font-semibold ${profitable ? 'text-emerald-700' : 'text-red-700'}`}>
                      {profit >= 0 ? '+' : ''}
                      {fmtKrw(profit)}
                    </div>
                    <div className="text-[10px] text-gray-500 font-mono">/단위</div>
                  </div>
                </div>
              </a>
            )
          })}
        </div>
      )}

      <section className="text-xs text-gray-500 border-t border-gray-200 pt-4 space-y-1">
        <div className="font-semibold text-gray-700">📐 Margin 계산식</div>
        <code className="block bg-gray-50 px-3 py-2 rounded font-mono text-[11px] leading-relaxed">
          margin_pct = (retail_med − wholesale) / retail_med
          <br />
          gross_profit_krw = retail_med − wholesale
          <br />
          retail_med = median(lprice in Naver Shopping search items)
          <br />
          listing_count = API total (시장 등록상품수 → 경쟁 강도)
        </code>
        <div className="pt-2">
          <strong>V1 보강 예정:</strong> 배송비·수수료 차감 후 net_margin · 가격 추세
          (price_med 30일 변화율) · cate 별 정상 마진 베이스라인 비교
        </div>
      </section>
    </div>
  )
}

function Kpi({
  label,
  value,
  highlight = false,
}: {
  label: string
  value: number | string
  highlight?: boolean
}) {
  return (
    <div className={`rounded border p-3 ${highlight ? 'border-emerald-300 bg-emerald-50' : 'border-gray-200'}`}>
      <div className="text-xs text-gray-500">{label}</div>
      <div className={`text-2xl font-bold mt-1 ${highlight ? 'text-emerald-700' : ''}`}>
        {typeof value === 'number' ? value.toLocaleString() : value}
      </div>
    </div>
  )
}
