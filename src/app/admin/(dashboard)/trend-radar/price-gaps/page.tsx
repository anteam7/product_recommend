import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

interface BucketRow {
  cate_cd: string
  cate_label: string | null
  bucket_floor: number
  supply_count: number
  demand_count: number
  demand_keywords_sample: string[]
}

interface NearestRow {
  goods_no: string
  title: string
  price_krw: number
  image_url: string | null
  detail_url: string | null
  side: 'below' | 'above'
}

interface UnmatchedRow {
  keyword: string
  occurrences: number
  sources: string[]
}

const DAYS_OPTIONS = [
  { v: 7, label: '7일' },
  { v: 14, label: '14일' },
  { v: 30, label: '30일 (기본)' },
  { v: 60, label: '60일' },
] as const

const BUCKET_OPTIONS = [
  { v: 3000, label: '3,000원' },
  { v: 5000, label: '5,000원 (기본)' },
  { v: 10000, label: '10,000원' },
] as const

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

function buildHref(current: Record<string, string>, override: Record<string, string | null>): string {
  const params = new URLSearchParams()
  for (const [k, v] of Object.entries(current)) if (v) params.set(k, v)
  for (const [k, v] of Object.entries(override)) {
    if (v == null || v === '') params.delete(k)
    else params.set(k, v)
  }
  const qs = params.toString()
  return '/admin/trend-radar/price-gaps' + (qs ? `?${qs}` : '')
}

async function fetchBuckets(days: number, bucket: number): Promise<{ rows: BucketRow[]; error: string | null }> {
  const sb = createAdminClient()
  const { data, error } = await sb.rpc('jimscanner_price_gap_buckets' as never, {
    days_window: days,
    bucket_size: bucket,
    min_sim: 0.2,
  } as never)
  if (error) return { rows: [], error: error.message }
  return { rows: (data ?? []) as BucketRow[], error: null }
}

async function fetchNearest(cate: string, bucketFloor: number, bucketSize: number) {
  const sb = createAdminClient()
  const { data, error } = await sb.rpc('jimscanner_price_gap_nearest' as never, {
    p_cate_cd: cate,
    p_bucket_floor: bucketFloor,
    p_bucket_size: bucketSize,
    p_limit: 5,
  } as never)
  if (error) return { rows: [] as NearestRow[], error: error.message }
  return { rows: (data ?? []) as NearestRow[], error: null as string | null }
}

async function fetchUnmatched(cate: string, days: number) {
  const sb = createAdminClient()
  const { data, error } = await sb.rpc('jimscanner_price_gap_unmatched_keywords' as never, {
    p_cate_cd: cate,
    days_window: days,
    min_sim: 0.2,
    p_limit: 10,
  } as never)
  if (error) return { rows: [] as UnmatchedRow[], error: error.message }
  return { rows: (data ?? []) as UnmatchedRow[], error: null as string | null }
}

function formatKrw(n: number): string {
  if (n >= 10000) return `${(n / 10000).toLocaleString(undefined, { maximumFractionDigits: 1 })}만`
  return n.toLocaleString()
}

function bucketLabel(floor: number, size: number): string {
  return `${formatKrw(floor)}~${formatKrw(floor + size)}`
}

export default async function PriceGapsPage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string; bucket?: string; cate?: string; floor?: string }>
}) {
  const sp = await searchParams
  const days = parseInt(sp.days ?? '30', 10)
  const validDays = DAYS_OPTIONS.some((d) => d.v === days) ? days : 30
  const bucket = parseInt(sp.bucket ?? '5000', 10)
  const validBucket = BUCKET_OPTIONS.some((b) => b.v === bucket) ? bucket : 5000
  const cate = sp.cate ?? ''
  const floorParam = sp.floor ? parseInt(sp.floor, 10) : null

  const current: Record<string, string> = {
    days: String(validDays),
    bucket: String(validBucket),
    cate,
    floor: floorParam != null ? String(floorParam) : '',
  }

  const { rows, error } = await fetchBuckets(validDays, validBucket)

  // 카테고리별 그룹화
  const byCate = new Map<string, BucketRow[]>()
  for (const r of rows) {
    if (!byCate.has(r.cate_cd)) byCate.set(r.cate_cd, [])
    byCate.get(r.cate_cd)!.push(r)
  }

  // 정렬: 각 카테고리 안에서 bucket_floor asc
  for (const arr of byCate.values()) arr.sort((a, b) => a.bucket_floor - b.bucket_floor)

  // 필터: cate 지정 시 해당 cate만 노출
  const cateCodes = cate
    ? [cate].filter((c) => byCate.has(c))
    : [...byCate.keys()].sort()

  // 클릭한 버킷 디테일
  let detail: { nearest: NearestRow[]; unmatched: UnmatchedRow[]; cateLabel: string; floor: number } | null = null
  if (cate && floorParam != null && byCate.has(cate)) {
    const [n, u] = await Promise.all([
      fetchNearest(cate, floorParam, validBucket),
      fetchUnmatched(cate, validDays),
    ])
    const cateLabel = CATEGORIES.find((c) => c.code === cate)?.label ?? cate
    detail = { nearest: n.rows, unmatched: u.rows, cateLabel, floor: floorParam }
  }

  // 전체 KPI
  const totalSupply = rows.reduce((s, r) => s + r.supply_count, 0)
  const totalDemand = rows.reduce((s, r) => s + r.demand_count, 0)
  const gapBuckets = rows.filter((r) => r.supply_count === 0 && r.demand_count > 0).length

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold">🪟 카테고리×가격대 공백 (Price Gap)</h1>
          <p className="text-sm text-gray-500 mt-1">
            ggsan 카테고리별 도매가 버킷 vs 시장 수요 시그널 — 수요는 있는데 공급이 비어있는 가격대 발굴
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      {/* 필터 */}
      <div className="rounded border border-gray-200 px-4 py-3 space-y-3">
        <div className="flex flex-wrap items-center gap-4">
          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-500">기간</span>
            {DAYS_OPTIONS.map((d) => (
              <Link
                key={d.v}
                href={buildHref(current, { days: String(d.v), floor: null })}
                className={`px-2 py-1 text-xs rounded ${
                  validDays === d.v ? 'bg-amber-100 text-amber-700 font-semibold' : 'text-gray-500 hover:text-black'
                }`}
              >
                {d.label}
              </Link>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-500">버킷</span>
            {BUCKET_OPTIONS.map((b) => (
              <Link
                key={b.v}
                href={buildHref(current, { bucket: String(b.v), floor: null })}
                className={`px-2 py-1 text-xs rounded ${
                  validBucket === b.v ? 'bg-amber-100 text-amber-700 font-semibold' : 'text-gray-500 hover:text-black'
                }`}
              >
                {b.label}
              </Link>
            ))}
          </div>
        </div>
        <div className="flex flex-wrap gap-1 border-t border-gray-100 pt-2">
          <Link
            href={buildHref(current, { cate: null, floor: null })}
            className={`px-2 py-1 text-xs rounded ${cate === '' ? 'bg-black text-white font-semibold' : 'text-gray-500 hover:text-black'}`}
          >
            전체
          </Link>
          {CATEGORIES.map((c) => (
            <Link
              key={c.code}
              href={buildHref(current, { cate: c.code, floor: null })}
              className={`px-2 py-1 text-xs rounded ${cate === c.code ? 'bg-black text-white font-semibold' : 'text-gray-500 hover:text-black'}`}
            >
              {c.label}
            </Link>
          ))}
        </div>
      </div>

      {/* KPI */}
      <section className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Kpi label="ggsan 카탈로그 (집계)" value={totalSupply} />
        <Kpi label="매칭 키워드 occurrences" value={totalDemand} />
        <Kpi label="🚨 공백 버킷" value={gapBuckets} highlight={gapBuckets > 0} />
        <Kpi label="카테고리" value={byCate.size} />
      </section>

      {/* 에러 */}
      {error && (
        <div className="rounded border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800">
          RPC 에러: <code className="font-mono text-xs">{error}</code>
          <p className="text-xs mt-2 text-red-700">
            RPC <code>jimscanner_price_gap_buckets</code> 가 DB에 적용 안 됐을 가능성. supabase/ggsan_price_gap_buckets_rpc.sql 적용 필요.
          </p>
        </div>
      )}

      {/* 카테고리별 히스토그램 */}
      {!error && cateCodes.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500 space-y-2">
          <div className="text-base font-medium">데이터 없음</div>
          <div className="text-xs text-gray-400">
            ggsan 카탈로그 또는 trends_keywords 가 비어있을 가능성. 카테고리 필터를 풀거나 days 를 늘려보세요.
          </div>
        </div>
      ) : (
        <div className="space-y-6">
          {cateCodes.map((code) => {
            const arr = byCate.get(code) ?? []
            const cateLbl =
              arr[0]?.cate_label ?? CATEGORIES.find((c) => c.code === code)?.label ?? code
            const maxSupply = Math.max(1, ...arr.map((r) => r.supply_count))
            const maxDemand = Math.max(1, ...arr.map((r) => r.demand_count))

            return (
              <section key={code} className="rounded border border-gray-200 p-4">
                <div className="flex items-baseline justify-between mb-3">
                  <h2 className="text-base font-semibold">
                    {cateLbl} <span className="text-xs text-gray-500 font-mono">({code})</span>
                  </h2>
                  <div className="text-xs text-gray-500">
                    공급 {arr.reduce((s, r) => s + r.supply_count, 0)} · 수요 {arr.reduce((s, r) => s + r.demand_count, 0)}
                  </div>
                </div>

                <div className="space-y-1">
                  <div className="grid grid-cols-12 text-[10px] text-gray-400 px-1">
                    <div className="col-span-3">가격대</div>
                    <div className="col-span-4 text-center">공급 (ggsan 상품수)</div>
                    <div className="col-span-4 text-center">수요 (매칭 키워드 occurrences)</div>
                    <div className="col-span-1 text-right">flag</div>
                  </div>
                  {arr.map((r) => {
                    const isGap = r.supply_count === 0 && r.demand_count > 0
                    const isOpen = cate === code && floorParam === r.bucket_floor
                    const supplyW = (r.supply_count / maxSupply) * 100
                    const demandW = (r.demand_count / maxDemand) * 100
                    return (
                      <Link
                        key={`${code}-${r.bucket_floor}`}
                        href={buildHref(current, {
                          cate: code,
                          floor: String(r.bucket_floor),
                        })}
                        className={`grid grid-cols-12 items-center gap-1 px-1 py-1 rounded text-xs transition-colors ${
                          isGap
                            ? 'bg-red-50 hover:bg-red-100 border border-red-200'
                            : isOpen
                              ? 'bg-amber-50 border border-amber-200'
                              : 'hover:bg-gray-50'
                        }`}
                      >
                        <div className={`col-span-3 font-mono ${isGap ? 'text-red-700 font-semibold' : 'text-gray-700'}`}>
                          {bucketLabel(r.bucket_floor, validBucket)}
                        </div>
                        <div className="col-span-4 flex items-center gap-2">
                          <div className="h-3 bg-gray-100 rounded relative flex-1">
                            <div
                              className={`h-3 rounded ${r.supply_count === 0 ? 'bg-red-300' : 'bg-blue-500'}`}
                              style={{ width: `${supplyW}%` }}
                            />
                          </div>
                          <span className="font-mono text-gray-600 w-8 text-right">{r.supply_count}</span>
                        </div>
                        <div className="col-span-4 flex items-center gap-2">
                          <div className="h-3 bg-gray-100 rounded relative flex-1">
                            <div
                              className="h-3 rounded bg-amber-500"
                              style={{ width: `${demandW}%` }}
                            />
                          </div>
                          <span className="font-mono text-gray-600 w-8 text-right">{r.demand_count}</span>
                        </div>
                        <div className="col-span-1 text-right">
                          {isGap && <span className="text-red-700 font-bold">GAP</span>}
                        </div>
                      </Link>
                    )
                  })}
                </div>

                {/* 상위 매칭 키워드 미리보기 */}
                {arr.some((r) => r.demand_keywords_sample.length > 0) && (
                  <div className="mt-3 pt-3 border-t border-gray-100 text-xs text-gray-500">
                    매칭 키워드 샘플:{' '}
                    {[...new Set(arr.flatMap((r) => r.demand_keywords_sample))]
                      .slice(0, 8)
                      .map((kw) => (
                        <span key={kw} className="inline-block px-1.5 py-0.5 mr-1 mb-1 bg-gray-100 rounded">
                          {kw}
                        </span>
                      ))}
                  </div>
                )}
              </section>
            )
          })}
        </div>
      )}

      {/* 클릭한 버킷 디테일 */}
      {detail && (
        <section className="rounded border border-amber-300 bg-amber-50/40 p-4 space-y-4">
          <div className="flex items-baseline justify-between">
            <h2 className="text-base font-semibold">
              🔍 {detail.cateLabel} · {bucketLabel(detail.floor, validBucket)} 디테일
            </h2>
            <Link
              href={buildHref(current, { floor: null })}
              className="text-xs text-gray-600 hover:text-black underline"
            >
              닫기 ✕
            </Link>
          </div>

          {/* 인접 ggsan 후보 */}
          <div>
            <div className="text-xs font-semibold text-gray-700 mb-2">
              📦 가격대 미만/이상에서 가장 가까운 ggsan 후보 (각 5개)
            </div>
            {detail.nearest.length === 0 ? (
              <div className="text-xs text-gray-400">후보 없음</div>
            ) : (
              <div className="space-y-1">
                {detail.nearest.map((n) => (
                  <a
                    key={n.goods_no}
                    href={n.detail_url ?? '#'}
                    target="_blank"
                    rel="noopener"
                    className="flex items-center gap-3 px-2 py-1 rounded hover:bg-white text-xs"
                  >
                    <span
                      className={`font-mono w-12 ${
                        n.side === 'below' ? 'text-blue-700' : 'text-red-700'
                      }`}
                    >
                      {n.side === 'below' ? '↓ 미만' : '↑ 이상'}
                    </span>
                    {n.image_url && (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={n.image_url} alt="" loading="lazy" className="w-8 h-8 object-cover rounded" />
                    )}
                    <span className="flex-1 truncate">{n.title}</span>
                    <span className="font-mono font-semibold">{n.price_krw.toLocaleString()}원</span>
                  </a>
                ))}
              </div>
            )}
          </div>

          {/* 미매칭 키워드 Top 10 */}
          <div>
            <div className="text-xs font-semibold text-gray-700 mb-2">
              🔍 같은 카테고리에서 ggsan 미매칭 검색 키워드 Top 10 (전체 도매몰 비검출)
            </div>
            {detail.unmatched.length === 0 ? (
              <div className="text-xs text-gray-400">없음 (모든 키워드가 ggsan 어딘가에 매칭됨)</div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-1">
                {detail.unmatched.map((u, i) => (
                  <div key={u.keyword} className="flex items-center gap-2 px-2 py-1 text-xs">
                    <span className="font-mono text-gray-400 w-6">{i + 1}</span>
                    <span className="flex-1 truncate">{u.keyword}</span>
                    <span className="font-mono text-gray-500">{u.occurrences}</span>
                    <span className="text-[10px] text-gray-400 truncate w-20 text-right">
                      {u.sources.length} src
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>
      )}

      {/* 설명 */}
      <section className="text-xs text-gray-500 border-t border-gray-200 pt-4 space-y-1">
        <div className="font-semibold text-gray-700">📐 Price Gap 정의</div>
        <code className="block bg-gray-50 px-3 py-2 rounded font-mono text-[11px] leading-relaxed">
          supply_count = COUNT(ggsan_products WHERE cate_cd=C AND price_krw IN [floor, floor+bucket))
          <br />
          demand_count = SUM(occurrences) over trends_keywords matched to ggsan products
          {'                            '}grouped by matched product&apos;s (cate_cd, price bucket)
          <br />
          GAP = supply_count == 0 AND demand_count {'>'} 0
        </code>
        <div className="pt-2">
          <strong>V0 한계:</strong> 수요 트랙은 ggsan 카탈로그에 trgm 매칭되는 키워드만 집계 — ggsan 어디에도 매칭 안 되는 수요는
          별도 &quot;미매칭 키워드&quot; 섹션으로만 노출. 카테고리 분류 정확도는 trgm similarity 에 의존.
        </div>
      </section>
    </div>
  )
}

function Kpi({ label, value, highlight = false }: { label: string; value: number | string; highlight?: boolean }) {
  return (
    <div className={`rounded border p-3 ${highlight ? 'border-red-300 bg-red-50' : 'border-gray-200'}`}>
      <div className="text-xs text-gray-500">{label}</div>
      <div className={`text-2xl font-bold mt-1 ${highlight ? 'text-red-700' : ''}`}>
        {typeof value === 'number' ? value.toLocaleString() : value}
      </div>
    </div>
  )
}
