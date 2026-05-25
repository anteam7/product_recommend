import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

interface BoardRow {
  goods_no: string
  ggsan_title: string
  cate_label: string | null
  ggsan_image_url: string | null
  wholesale_krw: number | null
  is_imminent: boolean
  last_changed_at: string
  match_count: number
  market_min_krw: number | null
  market_max_krw: number | null
  market_avg_krw: number | null
  avg_similarity: number | null
  last_match_at: string | null
  margin_krw: number | null
  margin_pct: number | null
  price_spread_ratio: number | null
}

interface MatchRow {
  id: string
  goods_no: string
  marketplace: string
  market_url: string
  thumbnail_url: string | null
  title: string | null
  market_price_krw: number | null
  review_count: number | null
  market_rank: number | null
  similarity: number
  observed_at: string
}

const TABS = [
  { v: 'opportunity', label: '💎 기회 (마진 ↑ · 노출 多)' },
  { v: 'blue_ocean',  label: '🌊 블루오션 (도매 有 · KR 노출 0)' },
  { v: 'red_ocean',   label: '🔴 레드오션 (노출 多 · 가격 평탄)' },
  { v: 'all',         label: '전체' },
] as const
type TabKey = (typeof TABS)[number]['v']

const PAGE_SIZE = 30
const SIMILARITY_THRESHOLD = 0.85

async function fetchBoard(tab: TabKey, page: number) {
  const sb = createAdminClient()
  const offset = (page - 1) * PAGE_SIZE

  // View 는 generated types 에 없으므로 as any 캐스팅
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let query: any = (sb as any)
    .from('jimscanner_visual_bridge_board')
    .select('*', { count: 'exact' })

  switch (tab) {
    case 'blue_ocean':
      query = query.eq('match_count', 0).not('wholesale_krw', 'is', null)
      query = query.order('wholesale_krw', { ascending: true, nullsFirst: false })
      break
    case 'red_ocean':
      // 노출 5건 이상 + spread ratio ≤ 1.15 (가격 평탄)
      query = query.gte('match_count', 5).lte('price_spread_ratio', 1.15)
      query = query.order('match_count', { ascending: false })
      break
    case 'opportunity':
      // 매치 1+ AND margin_pct >= 30 (KR 시장 최저가 대비 30% 이상 마진)
      query = query.gte('match_count', 1).gte('margin_pct', 30)
      query = query.order('margin_pct', { ascending: false, nullsFirst: false })
      break
    case 'all':
    default:
      query = query.order('last_match_at', { ascending: false, nullsFirst: false })
  }

  query = query.range(offset, offset + PAGE_SIZE - 1)
  const { data, count } = await query
  return { rows: (data ?? []) as BoardRow[], total: (count as number) ?? 0 }
}

async function fetchMatchesForGoods(goodsNos: string[]): Promise<Map<string, MatchRow[]>> {
  if (goodsNos.length === 0) return new Map()
  const sb = createAdminClient()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data } = await (sb as any)
    .from('jimscanner_visual_match')
    .select('id, goods_no, marketplace, market_url, thumbnail_url, title, market_price_krw, review_count, market_rank, similarity, observed_at')
    .in('goods_no', goodsNos)
    .gte('similarity', SIMILARITY_THRESHOLD)
    .order('similarity', { ascending: false })

  const map = new Map<string, MatchRow[]>()
  for (const row of (data ?? []) as MatchRow[]) {
    const arr = map.get(row.goods_no) ?? []
    arr.push(row)
    map.set(row.goods_no, arr)
  }
  return map
}

async function fetchSummary() {
  const sb = createAdminClient()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sbAny = sb as any
  const [
    { count: totalGgsan },
    { count: totalMatches },
    { count: blueOceanCount },
    { data: lastMatch },
  ] = await Promise.all([
    sb.from('jimscanner_ggsan_products').select('*', { count: 'exact', head: true }),
    sbAny.from('jimscanner_visual_match').select('*', { count: 'exact', head: true }),
    sbAny
      .from('jimscanner_visual_bridge_board')
      .select('*', { count: 'exact', head: true })
      .eq('match_count', 0)
      .not('wholesale_krw', 'is', null),
    sbAny
      .from('jimscanner_visual_match')
      .select('observed_at')
      .order('observed_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
  ])

  return {
    totalGgsan: totalGgsan ?? 0,
    totalMatches: (totalMatches as number) ?? 0,
    blueOceanCount: (blueOceanCount as number) ?? 0,
    lastMatchAt: (lastMatch as { observed_at?: string } | null)?.observed_at ?? null,
  }
}

function buildHref(current: Record<string, string>, override: Record<string, string | null>): string {
  const params = new URLSearchParams()
  for (const [k, v] of Object.entries(current)) if (v) params.set(k, v)
  for (const [k, v] of Object.entries(override)) {
    if (v == null || v === '') params.delete(k)
    else params.set(k, v)
  }
  const qs = params.toString()
  return '/admin/trend-radar/visual-bridge' + (qs ? `?${qs}` : '')
}

function fmtKrw(n: number | null | undefined): string {
  if (n == null) return '—'
  return `${n.toLocaleString()}원`
}

function marketplaceBadge(m: string): string {
  switch (m) {
    case 'coupang':        return 'bg-rose-100 text-rose-700'
    case 'naver_shopping': return 'bg-emerald-100 text-emerald-700'
    case 'gmarket':        return 'bg-sky-100 text-sky-700'
    default:               return 'bg-gray-100 text-gray-700'
  }
}

function PriceSparkline({ min, avg, max }: { min: number | null; avg: number | null; max: number | null }) {
  if (min == null || max == null || avg == null || max <= min) {
    return <div className="text-[10px] text-gray-400">가격 분포 N/A</div>
  }
  const pct = ((avg - min) / (max - min)) * 100
  return (
    <div className="w-full">
      <div className="text-[10px] text-gray-500 flex justify-between">
        <span>{fmtKrw(min)}</span>
        <span>{fmtKrw(max)}</span>
      </div>
      <div className="relative h-1.5 bg-gradient-to-r from-emerald-300 via-amber-300 to-rose-400 rounded">
        <div
          className="absolute top-1/2 -translate-y-1/2 w-2 h-2 bg-black border border-white rounded-full"
          style={{ left: `calc(${Math.max(0, Math.min(100, pct))}% - 4px)` }}
          title={`평균 ${fmtKrw(avg)}`}
        />
      </div>
    </div>
  )
}

export default async function VisualBridgePage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; page?: string }>
}) {
  const sp = await searchParams
  const tab = (TABS.some((t) => t.v === sp.tab) ? sp.tab : 'opportunity') as TabKey
  const page = Math.max(1, parseInt(sp.page ?? '1', 10) || 1)
  const current: Record<string, string> = { tab, page: String(page) }

  const [summary, board] = await Promise.all([fetchSummary(), fetchBoard(tab, page)])
  const matchMap = await fetchMatchesForGoods(board.rows.map((r) => r.goods_no))
  const totalPages = Math.max(1, Math.ceil(board.total / PAGE_SIZE))

  return (
    <div className="space-y-6 p-6">
      <header className="space-y-2">
        <h1 className="text-2xl font-bold">🖼 비주얼 소싱 브릿지</h1>
        <p className="text-sm text-gray-500">
          ggsan 도매 상품 이미지 ↔ 쿠팡·네이버쇼핑 SERP 썸네일 CLIP 유사도 매칭(≥ {SIMILARITY_THRESHOLD}).
          텍스트 alias 가 못 잡는 OEM 동일품 / 브랜드 리네이밍을 시각 신호로 보강한다.
        </p>
      </header>

      {/* 요약 카드 */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className="rounded border border-gray-200 p-3">
          <div className="text-xs text-gray-500">ggsan SKU</div>
          <div className="text-xl font-bold">{summary.totalGgsan.toLocaleString()}</div>
        </div>
        <div className="rounded border border-gray-200 p-3">
          <div className="text-xs text-gray-500">비주얼 매치 수</div>
          <div className="text-xl font-bold">{summary.totalMatches.toLocaleString()}</div>
        </div>
        <div className="rounded border border-gray-200 p-3 bg-sky-50">
          <div className="text-xs text-sky-700">🌊 블루오션 후보</div>
          <div className="text-xl font-bold text-sky-700">{summary.blueOceanCount.toLocaleString()}</div>
        </div>
        <div className="rounded border border-gray-200 p-3">
          <div className="text-xs text-gray-500">마지막 매치 적재</div>
          <div className="text-sm font-mono">
            {summary.lastMatchAt ? summary.lastMatchAt.slice(0, 16).replace('T', ' ') : '없음'}
          </div>
        </div>
      </div>

      {/* 탭 */}
      <nav className="flex flex-wrap gap-1 border-b border-gray-200">
        {TABS.map((t) => (
          <Link
            key={t.v}
            href={buildHref(current, { tab: t.v, page: null })}
            className={`px-3 py-2 text-sm border-b-2 ${tab === t.v ? 'border-amber-500 font-semibold' : 'border-transparent text-gray-500 hover:text-black'}`}
          >
            {t.label}
          </Link>
        ))}
      </nav>

      <div className="text-xs text-gray-500">
        {board.total.toLocaleString()}건 · {page}/{totalPages} 페이지
      </div>

      {board.rows.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500">
          <div className="text-base mb-2">표시할 항목 없음</div>
          <div className="text-xs text-gray-400">
            collector(WSL) 가 SERP 썸네일 + CLIP 임베딩을 적재하면 결과가 나타납니다.
            <br />
            scripts: <code>fetch_serp_thumbnails.mjs</code> · <code>embed_clip.py</code>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          {board.rows.map((row) => {
            const matches = matchMap.get(row.goods_no) ?? []
            const marginPositive = (row.margin_pct ?? 0) > 0
            return (
              <article
                key={row.goods_no}
                className="rounded border border-gray-200 hover:border-amber-300 transition-all"
              >
                <div className="grid grid-cols-1 md:grid-cols-[180px_1fr_220px] gap-4 p-3">
                  {/* ggsan 카드 */}
                  <div className="flex md:block gap-3">
                    <div className="aspect-square w-24 md:w-full bg-gray-100 rounded overflow-hidden shrink-0 relative">
                      {row.ggsan_image_url && (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={row.ggsan_image_url} alt="" loading="lazy" className="w-full h-full object-cover" />
                      )}
                      {row.is_imminent && (
                        <span className="absolute top-1 left-1 bg-red-600 text-white text-[10px] px-1 py-0.5 rounded">
                          임박
                        </span>
                      )}
                    </div>
                    <div className="md:mt-2 space-y-1">
                      <div className="text-[10px] font-mono text-gray-400">ggsan · {row.cate_label ?? '-'}</div>
                      <div className="text-xs font-medium line-clamp-3" title={row.ggsan_title}>
                        {row.ggsan_title}
                      </div>
                      <div className="text-sm font-bold text-amber-700">
                        도매 {fmtKrw(row.wholesale_krw)}
                      </div>
                    </div>
                  </div>

                  {/* KR 시장 노출 갤러리 */}
                  <div>
                    {matches.length === 0 ? (
                      <div className="h-full rounded bg-sky-50 border border-sky-200 p-4 text-sm text-sky-700 flex items-center justify-center">
                        🌊 KR 시장 노출 0건 — 블루오션 후보
                      </div>
                    ) : (
                      <div className="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-6 gap-2">
                        {matches.slice(0, 12).map((m) => (
                          <a
                            key={m.id}
                            href={m.market_url}
                            target="_blank"
                            rel="noopener"
                            className="block rounded border border-gray-200 hover:border-black overflow-hidden"
                            title={`${m.title ?? ''}\n유사도 ${m.similarity.toFixed(3)}`}
                          >
                            <div className="aspect-square bg-gray-100 relative">
                              {m.thumbnail_url && (
                                // eslint-disable-next-line @next/next/no-img-element
                                <img src={m.thumbnail_url} alt="" loading="lazy" className="w-full h-full object-cover" />
                              )}
                              <span className={`absolute top-0.5 left-0.5 text-[9px] px-1 rounded ${marketplaceBadge(m.marketplace)}`}>
                                {m.marketplace}
                              </span>
                              {m.market_rank != null && (
                                <span className="absolute top-0.5 right-0.5 bg-black/70 text-white text-[9px] px-1 rounded">
                                  #{m.market_rank}
                                </span>
                              )}
                              <span className="absolute bottom-0.5 right-0.5 bg-white/90 text-[9px] px-1 rounded font-mono">
                                {m.similarity.toFixed(2)}
                              </span>
                            </div>
                            <div className="px-1 py-0.5 text-[10px]">
                              <div className="font-bold">{fmtKrw(m.market_price_krw)}</div>
                              {m.review_count != null && (
                                <div className="text-gray-400">리뷰 {m.review_count.toLocaleString()}</div>
                              )}
                            </div>
                          </a>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* 사이드 카: 마진 / 가격 분산 */}
                  <aside className="space-y-3 border-l border-gray-100 md:pl-4">
                    <div>
                      <div className="text-[10px] text-gray-500">즉시 마진 (시장 최저가 − 도매가)</div>
                      <div className={`text-lg font-bold ${marginPositive ? 'text-emerald-600' : 'text-gray-400'}`}>
                        {row.margin_krw != null ? `${row.margin_krw >= 0 ? '+' : ''}${row.margin_krw.toLocaleString()}원` : '—'}
                      </div>
                      <div className={`text-xs ${marginPositive ? 'text-emerald-600' : 'text-gray-400'}`}>
                        {row.margin_pct != null ? `${row.margin_pct > 0 ? '+' : ''}${row.margin_pct}%` : ''}
                      </div>
                    </div>
                    <div>
                      <div className="text-[10px] text-gray-500 mb-1">시장 가격 분포 ({row.match_count}건)</div>
                      <PriceSparkline min={row.market_min_krw} avg={row.market_avg_krw} max={row.market_max_krw} />
                      {row.price_spread_ratio != null && (
                        <div className={`text-[10px] mt-1 ${row.price_spread_ratio <= 1.15 ? 'text-rose-600' : 'text-gray-500'}`}>
                          spread {row.price_spread_ratio}× {row.price_spread_ratio <= 1.15 && '· 🔴 평탄(레드오션)'}
                        </div>
                      )}
                    </div>
                    {row.avg_similarity != null && (
                      <div className="text-[10px] text-gray-500">
                        평균 유사도 <span className="font-mono">{row.avg_similarity}</span>
                      </div>
                    )}
                  </aside>
                </div>
              </article>
            )
          })}
        </div>
      )}

      {totalPages > 1 && (
        <nav className="flex items-center justify-center gap-1 pt-4">
          {page > 1 && (
            <Link href={buildHref(current, { page: String(page - 1) })} className="px-3 py-1 text-sm rounded border border-gray-200 hover:bg-gray-50">
              이전
            </Link>
          )}
          {Array.from({ length: Math.min(7, totalPages) }, (_, i) => {
            let n: number
            if (totalPages <= 7) n = i + 1
            else if (page <= 4) n = i + 1
            else if (page >= totalPages - 3) n = totalPages - 6 + i
            else n = page - 3 + i
            return (
              <Link
                key={n}
                href={buildHref(current, { page: String(n) })}
                className={`px-3 py-1 text-sm rounded ${n === page ? 'bg-black text-white' : 'border border-gray-200 hover:bg-gray-50'}`}
              >
                {n}
              </Link>
            )
          })}
          {page < totalPages && (
            <Link href={buildHref(current, { page: String(page + 1) })} className="px-3 py-1 text-sm rounded border border-gray-200 hover:bg-gray-50">
              다음
            </Link>
          )}
        </nav>
      )}

      <footer className="text-[10px] text-gray-400 border-t border-gray-100 pt-3">
        DDL: <code>supabase/visual_match.sql</code> · Collector: WSL <code>fetch_serp_thumbnails.mjs</code> + <code>embed_clip.py</code>
        · 유사도 임계값 {SIMILARITY_THRESHOLD} · CLIP ViT-B/32 (vector(512), pgvector)
      </footer>
    </div>
  )
}
