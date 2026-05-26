import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

// 신규 테이블 — generated types 갱신 전까지 임시 캐스팅
type WatchRow = {
  listing_id: string
  target_keyword: string
  rank: number | null
  page: number | null
  vendor_id_match: boolean
  product_id_match: number | null
  total_results: number | null
  captured_at: string
}

type LatestRow = WatchRow & {
  avg_rank_7d: string | number | null
  hit_days_7d: number | null
  scan_days_7d: number | null
  avg_rank_30d: string | number | null
  best_rank_30d: number | null
}

type ListingMini = {
  id: string
  product_id: number | null
  registered_title: string
  list_price_krw: number
  dome_price_krw: number
  brand: string | null
  display_category_name: string | null
  source_detail_url: string | null
}

type Quadrant = 'entered' | 'stable' | 'falling' | 'missing'

const QUADRANT_LABELS: Record<Quadrant, { label: string; cls: string; desc: string }> = {
  entered: {
    label: '진입',
    cls: 'bg-emerald-100 text-emerald-700',
    desc: '최근 7일 평균 노출 순위가 안정적으로 양호',
  },
  stable: {
    label: '정체',
    cls: 'bg-blue-100 text-blue-700',
    desc: '노출은 되지만 순위 변화 거의 없음',
  },
  falling: {
    label: '하락',
    cls: 'bg-amber-100 text-amber-700',
    desc: '최근 순위가 7일 평균 대비 악화 (rank ↑)',
  },
  missing: {
    label: '누락',
    cls: 'bg-rose-100 text-rose-700',
    desc: '최근 스캔에서 깊이 범위 내 미발견',
  },
}

async function fetchData() {
  const sb = createAdminClient() as unknown as {
    from: (t: string) => ReturnType<ReturnType<typeof createAdminClient>['from']>
  }

  const [latestRes, historyRes] = await Promise.all([
    sb.from('jimscanner_coupang_serp_watch_latest').select('*'),
    sb
      .from('jimscanner_coupang_serp_watch')
      .select('listing_id, target_keyword, rank, captured_at')
      .gte('captured_at', new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString())
      .order('captured_at', { ascending: true }),
  ])

  const latest = (latestRes.data ?? []) as unknown as LatestRow[]
  const history = (historyRes.data ?? []) as unknown as Pick<
    WatchRow,
    'listing_id' | 'target_keyword' | 'rank' | 'captured_at'
  >[]

  const listingIds = [...new Set(latest.map((r) => r.listing_id))]
  let listings: ListingMini[] = []
  if (listingIds.length) {
    const lr = await sb
      .from('jimscanner_coupang_listings')
      .select(
        'id, product_id, registered_title, list_price_krw, dome_price_krw, brand, display_category_name, source_detail_url',
      )
      .in('id', listingIds)
    listings = (lr.data ?? []) as unknown as ListingMini[]
  }

  return { latest, history, listings }
}

function classify(row: LatestRow, sparkSeries: (number | null)[]): Quadrant {
  const lastRank = row.rank
  if (lastRank == null) return 'missing'
  const avg7 = row.avg_rank_7d == null ? null : Number(row.avg_rank_7d)

  // 하락: 최신 rank 가 7일 평균보다 +20% 이상 크다 (=악화)
  if (avg7 != null && lastRank > avg7 * 1.2 && lastRank - avg7 >= 5) return 'falling'

  // 진입: 평균이 page 1 안에 들어와 있음 (rank <= 72) + 최소 3일 적중
  if (avg7 != null && avg7 <= 72 && (row.hit_days_7d ?? 0) >= 3) return 'entered'

  // 시리즈에 NULL(누락) 일자가 절반 이상이면 missing
  const nullDays = sparkSeries.filter((v) => v == null).length
  if (nullDays >= Math.max(2, Math.floor(sparkSeries.length / 2))) return 'missing'

  return 'stable'
}

/**
 * 하락 SKU 자동 진단 — 휴리스틱 분기
 *  1) 제목 토큰 누락: 타겟 키워드 토큰이 registered_title 에 일부 빠져 있음
 *  2) 가격 분포 outlier: list_price 가 매입가 대비 비정상 (잠재적; market_price 미연결 시 dome_price 비율로 추정)
 *  3) 이미지·평점 누락 — 본 페이지에서는 hint 만, 실제 검증은 후속 진단 cron
 */
function diagnose(listing: ListingMini | undefined, keyword: string): string[] {
  const reasons: string[] = []
  if (!listing) return ['리스팅 메타 누락 — 재싱크 필요']

  const tokens = keyword
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2)
  const title = (listing.registered_title || '').toLowerCase()
  const missing = tokens.filter((t) => !title.includes(t.toLowerCase()))
  if (missing.length > 0) {
    reasons.push(`제목 토큰 누락: ${missing.join(', ')}`)
  }

  if (listing.dome_price_krw > 0 && listing.list_price_krw > 0) {
    const ratio = listing.list_price_krw / listing.dome_price_krw
    if (ratio >= 3) reasons.push('가격 outlier (매입 대비 3배+) — 경쟁가 확인')
    else if (ratio <= 1.15) reasons.push('판매가 마진 협소 — 광고 진입 가능성 낮음')
  }

  if (!listing.product_id) reasons.push('product_id 없음 — 발행 미완료')

  if (!reasons.length) reasons.push('타이틀·가격 양호 — 이미지/평점/리뷰 정합성 점검 권장')
  return reasons
}

function sparkPath(values: (number | null)[], width = 100, height = 28) {
  const nums = values.map((v) => (v == null ? null : v))
  const knownVals = nums.filter((v): v is number => v != null)
  if (knownVals.length === 0) return null
  const max = Math.max(...knownVals)
  const min = Math.min(...knownVals)
  const span = Math.max(1, max - min)
  // rank 는 낮을수록 좋음 → y 반전 (낮은 값을 위로)
  const points: { x: number; y: number | null }[] = nums.map((v, i) => ({
    x: (i / Math.max(1, nums.length - 1)) * width,
    y: v == null ? null : height - ((v - min) / span) * height,
  }))
  // 선분 path — null 은 break
  let d = ''
  let pen = false
  for (const p of points) {
    if (p.y == null) {
      pen = false
      continue
    }
    if (!pen) {
      d += `M${p.x.toFixed(1)} ${p.y.toFixed(1)} `
      pen = true
    } else {
      d += `L${p.x.toFixed(1)} ${p.y.toFixed(1)} `
    }
  }
  return d.trim() || null
}

function buildSparkSeries(
  history: Pick<WatchRow, 'listing_id' | 'target_keyword' | 'rank' | 'captured_at'>[],
  listing_id: string,
  keyword: string,
  days = 7,
): (number | null)[] {
  const buckets: (number | null)[] = Array(days).fill(null)
  const now = Date.now()
  const start = now - days * 24 * 60 * 60 * 1000
  for (const r of history) {
    if (r.listing_id !== listing_id || r.target_keyword !== keyword) continue
    const t = new Date(r.captured_at).getTime()
    if (t < start) continue
    const idx = Math.min(days - 1, Math.floor((t - start) / (24 * 60 * 60 * 1000)))
    // 같은 일자에 여러 캡처 — 더 좋은(낮은) rank 채택
    const prev = buckets[idx]
    if (r.rank == null) {
      if (prev == null) buckets[idx] = null
    } else {
      buckets[idx] = prev == null ? r.rank : Math.min(prev, r.rank)
    }
  }
  return buckets
}

export default async function CoupangRankWatchPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; quadrant?: string }>
}) {
  const sp = await searchParams
  const filterQ = (sp.q ?? '').trim()
  const filterQuadrant = sp.quadrant ?? ''
  const { latest, history, listings } = await fetchData()
  const listingMap = new Map(listings.map((l) => [l.id, l]))

  // 분류 + 필터
  type EnrichedRow = LatestRow & {
    spark: (number | null)[]
    quadrant: Quadrant
    listing: ListingMini | undefined
  }
  const enriched: EnrichedRow[] = latest.map((r) => {
    const spark = buildSparkSeries(history, r.listing_id, r.target_keyword)
    const quadrant = classify(r, spark)
    return { ...r, spark, quadrant, listing: listingMap.get(r.listing_id) }
  })

  const quadCounts: Record<Quadrant, number> = {
    entered: 0,
    stable: 0,
    falling: 0,
    missing: 0,
  }
  for (const r of enriched) quadCounts[r.quadrant]++

  let visible = enriched
  if (filterQuadrant && filterQuadrant in QUADRANT_LABELS) {
    visible = visible.filter((r) => r.quadrant === (filterQuadrant as Quadrant))
  }
  if (filterQ) {
    const q = filterQ.toLowerCase()
    visible = visible.filter(
      (r) =>
        r.target_keyword.toLowerCase().includes(q) ||
        (r.listing?.registered_title ?? '').toLowerCase().includes(q),
    )
  }

  // 정렬: 하락 > 누락 > 정체 > 진입, 그 안에서는 rank 악화 큰 순
  const order: Record<Quadrant, number> = { falling: 0, missing: 1, stable: 2, entered: 3 }
  visible.sort((a, b) => {
    const d = order[a.quadrant] - order[b.quadrant]
    if (d !== 0) return d
    return (b.rank ?? 9999) - (a.rank ?? 9999)
  })

  function buildHref(override: Record<string, string | null>) {
    const params = new URLSearchParams()
    if (filterQ) params.set('q', filterQ)
    if (filterQuadrant) params.set('quadrant', filterQuadrant)
    for (const [k, v] of Object.entries(override)) {
      if (v == null || v === '') params.delete(k)
      else params.set(k, v)
    }
    const qs = params.toString()
    return '/admin/coupang-publish/rank-watch' + (qs ? `?${qs}` : '')
  }

  return (
    <div className="space-y-6 p-6">
      <header className="space-y-2">
        <div className="flex items-baseline justify-between flex-wrap gap-3">
          <div>
            <h1 className="text-2xl font-bold">쿠팡 SERP 노출 트래커</h1>
            <p className="text-sm text-gray-500 mt-1">
              발행 SKU 별 타겟 키워드 검색 결과 순위 추적 · 추적 중{' '}
              <strong>{enriched.length.toLocaleString()}</strong>개 (listing × keyword)
            </p>
          </div>
          <Link
            href="/admin/coupang-publish"
            className="text-xs text-gray-500 hover:text-amber-700"
          >
            ← 등록 상품 관리
          </Link>
        </div>
        <p className="text-[11px] text-gray-400">
          ※ cron:{' '}
          <code className="bg-gray-100 px-1 rounded">
            node scripts/scrape-coupang-listing-rank.mjs
          </code>{' '}
          — 매일 1회 권장
        </p>
      </header>

      {/* 4분위 카드 */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {(Object.keys(QUADRANT_LABELS) as Quadrant[]).map((q) => {
          const meta = QUADRANT_LABELS[q]
          const active = filterQuadrant === q
          return (
            <Link
              key={q}
              href={buildHref({ quadrant: active ? null : q })}
              className={`block rounded-lg border p-3 transition ${
                active ? 'border-blue-500 ring-2 ring-blue-200' : 'border-gray-200 hover:border-gray-300'
              }`}
            >
              <div className="flex items-baseline justify-between">
                <span className={`inline-block px-2 py-0.5 rounded text-xs font-semibold ${meta.cls}`}>
                  {meta.label}
                </span>
                <span className="text-2xl font-bold tabular-nums">{quadCounts[q]}</span>
              </div>
              <p className="text-[11px] text-gray-500 mt-2 leading-relaxed">{meta.desc}</p>
            </Link>
          )
        })}
      </div>

      {/* 검색 */}
      <form className="max-w-md" action="/admin/coupang-publish/rank-watch">
        {filterQuadrant && <input type="hidden" name="quadrant" value={filterQuadrant} />}
        <input
          type="text"
          name="q"
          defaultValue={filterQ}
          placeholder="키워드 또는 상품명 검색"
          className="w-full px-3 py-1.5 text-sm border border-gray-300 rounded"
        />
      </form>

      {/* 테이블 */}
      <div className="overflow-x-auto bg-white border rounded">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-gray-600 text-xs">
            <tr>
              <th className="px-3 py-2 text-left font-semibold w-[28%]">상품 / 키워드</th>
              <th className="px-3 py-2 text-center font-semibold">분류</th>
              <th className="px-3 py-2 text-right font-semibold">최신 rank</th>
              <th className="px-3 py-2 text-right font-semibold">7일 평균</th>
              <th className="px-3 py-2 text-right font-semibold">30일 best</th>
              <th className="px-3 py-2 text-center font-semibold">7일 추세</th>
              <th className="px-3 py-2 text-left font-semibold w-[28%]">진단 / 액션</th>
            </tr>
          </thead>
          <tbody>
            {visible.length === 0 && (
              <tr>
                <td colSpan={7} className="px-3 py-12 text-center text-gray-400 text-sm">
                  {enriched.length === 0
                    ? '아직 추적 데이터가 없습니다. jimscanner_coupang_serp_keywords 에 타겟 키워드를 등록한 뒤 cron 을 돌리세요.'
                    : '필터 조건에 맞는 행이 없습니다.'}
                </td>
              </tr>
            )}
            {visible.map((r) => {
              const quad = QUADRANT_LABELS[r.quadrant]
              const path = sparkPath(r.spark, 90, 24)
              const showDiag = r.quadrant === 'falling' || r.quadrant === 'missing'
              const reasons = showDiag ? diagnose(r.listing, r.target_keyword) : []
              const coupangUrl = r.listing?.product_id
                ? `https://www.coupang.com/vp/products/${r.listing.product_id}`
                : null
              const searchUrl = `https://www.coupang.com/np/search?q=${encodeURIComponent(r.target_keyword)}`
              return (
                <tr key={`${r.listing_id}::${r.target_keyword}`} className="border-t align-top">
                  <td className="px-3 py-2">
                    <div className="font-medium text-gray-900 line-clamp-2">
                      {r.listing?.registered_title ?? '(리스팅 미연결)'}
                    </div>
                    <div className="text-[11px] text-gray-500 mt-0.5">
                      <span className="font-semibold text-gray-700">키워드:</span>{' '}
                      <a
                        href={searchUrl}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="text-blue-700 hover:underline"
                      >
                        {r.target_keyword}
                      </a>
                    </div>
                  </td>
                  <td className="px-3 py-2 text-center">
                    <span className={`inline-block px-2 py-0.5 rounded text-xs ${quad.cls}`}>
                      {quad.label}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {r.rank == null ? (
                      <span className="text-rose-500">—</span>
                    ) : (
                      <>
                        <span className="font-semibold">{r.rank}</span>
                        <span className="text-[10px] text-gray-400 ml-1">p{r.page}</span>
                      </>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-gray-600">
                    {r.avg_rank_7d == null ? '—' : Number(r.avg_rank_7d).toFixed(1)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-gray-600">
                    {r.best_rank_30d ?? '—'}
                  </td>
                  <td className="px-3 py-2 text-center">
                    {path ? (
                      <svg width={90} height={24} className="inline-block">
                        <path d={path} fill="none" stroke="#2563eb" strokeWidth={1.5} />
                      </svg>
                    ) : (
                      <span className="text-[10px] text-gray-400">데이터 부족</span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    {showDiag ? (
                      <ul className="space-y-0.5 text-[11px] text-gray-700">
                        {reasons.map((reason, i) => (
                          <li key={i}>• {reason}</li>
                        ))}
                        <li className="pt-1 flex gap-2">
                          {coupangUrl && (
                            <a
                              href={coupangUrl}
                              target="_blank"
                              rel="noreferrer noopener"
                              className="text-blue-700 hover:underline"
                            >
                              쿠팡 상세
                            </a>
                          )}
                          {r.listing?.source_detail_url && (
                            <a
                              href={r.listing.source_detail_url}
                              target="_blank"
                              rel="noreferrer noopener"
                              className="text-amber-700 hover:underline"
                            >
                              매입처
                            </a>
                          )}
                        </li>
                      </ul>
                    ) : (
                      <span className="text-[11px] text-gray-400">정상</span>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
