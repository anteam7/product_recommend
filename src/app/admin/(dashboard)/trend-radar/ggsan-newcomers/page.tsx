import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import PinButton from './PinButton'

export const dynamic = 'force-dynamic'

const PAGE_SIZE = 60

interface NewcomerRow {
  goods_no: string
  title: string
  cate_cd: string | null
  cate_label: string | null
  price_krw: number | null
  image_url: string | null
  detail_url: string | null
  first_seen_at: string
  market_min_krw: number | null
  market_median_krw: number | null
  market_seller_count: number | null
  market_review_count: number | null
  market_query: string | null
  probe_status: string
  margin_pct: number | null
  saturation_score: number | null
  category_zscore: number | null
  newcomer_score: number | null
  queued_at: string
  probed_at: string | null
  pinned: boolean
  dismissed: boolean
}

const FILTER_OPTIONS = [
  { v: 'all', label: '전체' },
  { v: 'probed', label: '✓ 시장가 측정됨' },
  { v: 'pending', label: '⏳ 측정 대기' },
  { v: 'high_margin', label: '🔥 마진≥40%' },
  { v: 'blue_ocean', label: '🌊 포화도≤0.3' },
] as const
type Filter = (typeof FILTER_OPTIONS)[number]['v']

const SORT_OPTIONS = [
  { v: 'score', label: '점수순' },
  { v: 'first_seen', label: '최신 입고순' },
  { v: 'margin', label: '마진율순' },
] as const
type SortKey = (typeof SORT_OPTIONS)[number]['v']

function buildHref(current: Record<string, string>, override: Record<string, string | null>): string {
  const params = new URLSearchParams()
  for (const [k, v] of Object.entries(current)) if (v) params.set(k, v)
  for (const [k, v] of Object.entries(override)) {
    if (v == null || v === '') params.delete(k)
    else params.set(k, v)
  }
  const qs = params.toString()
  return '/admin/trend-radar/ggsan-newcomers' + (qs ? `?${qs}` : '')
}

async function fetchData(opts: { filter: Filter; sort: SortKey; page: number }) {
  const sb = createAdminClient()
  // newcomer_scores 테이블은 마이그레이션(supabase/ggsan_newcomers.sql) 후 존재.
  // 타입 재생성 전까지 any 캐스팅.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sbAny = sb as any

  // newcomer_scores LEFT JOIN ggsan_products via FK 가 직접 안 되어
  // 2단계로: scores 먼저 가져오고 products 룩업
  let scoresQ = sbAny
    .from('jimscanner_ggsan_newcomer_scores')
    .select('*', { count: 'exact' })
    .eq('dismissed', false)

  if (opts.filter === 'probed') scoresQ = scoresQ.eq('probe_status', 'probed')
  else if (opts.filter === 'pending') scoresQ = scoresQ.in('probe_status', ['pending', 'error'])
  else if (opts.filter === 'high_margin') scoresQ = scoresQ.gte('margin_pct', 40)
  else if (opts.filter === 'blue_ocean') scoresQ = scoresQ.lte('saturation_score', 0.3)

  if (opts.sort === 'score') scoresQ = scoresQ.order('newcomer_score', { ascending: false, nullsFirst: false })
  else if (opts.sort === 'first_seen') scoresQ = scoresQ.order('queued_at', { ascending: false })
  else if (opts.sort === 'margin') scoresQ = scoresQ.order('margin_pct', { ascending: false, nullsFirst: false })

  const offset = (opts.page - 1) * PAGE_SIZE
  scoresQ = scoresQ.range(offset, offset + PAGE_SIZE - 1)

  const { data: scores, count } = await scoresQ
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const scoreRows: any[] = scores ?? []

  if (scoreRows.length === 0) {
    return { rows: [] as NewcomerRow[], total: count ?? 0 }
  }

  const goodsNos = scoreRows.map((s) => s.goods_no as string)
  const { data: products } = await sb
    .from('jimscanner_ggsan_products')
    .select('goods_no, title, cate_cd, cate_label, price_krw, image_url, detail_url, first_seen_at')
    .in('goods_no', goodsNos)

  type ProductRow = NonNullable<typeof products>[number]
  const productMap = new Map<string, ProductRow>()
  for (const p of products ?? []) productMap.set(p.goods_no, p)

  // 이미 핀된 항목 조회 (jimscanner_trends_pins keyword = goods_no::ggsan)
  const pinKeys = goodsNos.map((g) => `ggsan:${g}`)
  const { data: pins } = await sb
    .from('jimscanner_trends_pins')
    .select('keyword')
    .eq('source', 'ggsan_newcomer')
    .in('keyword', pinKeys)
  const pinnedSet = new Set((pins ?? []).map((p) => p.keyword))

  const rows: NewcomerRow[] = scoreRows.map((s) => {
    const p = productMap.get(s.goods_no)
    return {
      goods_no: s.goods_no,
      title: p?.title ?? '(상품 정보 없음)',
      cate_cd: p?.cate_cd ?? null,
      cate_label: p?.cate_label ?? null,
      price_krw: p?.price_krw ?? null,
      image_url: p?.image_url ?? null,
      detail_url: p?.detail_url ?? null,
      first_seen_at: p?.first_seen_at ?? s.queued_at,
      market_min_krw: s.market_min_krw,
      market_median_krw: s.market_median_krw,
      market_seller_count: s.market_seller_count,
      market_review_count: s.market_review_count,
      market_query: s.market_query,
      probe_status: s.probe_status,
      margin_pct: s.margin_pct == null ? null : Number(s.margin_pct),
      saturation_score: s.saturation_score == null ? null : Number(s.saturation_score),
      category_zscore: s.category_zscore == null ? null : Number(s.category_zscore),
      newcomer_score: s.newcomer_score == null ? null : Number(s.newcomer_score),
      queued_at: s.queued_at,
      probed_at: s.probed_at,
      pinned: pinnedSet.has(`ggsan:${s.goods_no}`),
      dismissed: s.dismissed,
    }
  })

  return { rows, total: count ?? 0 }
}

async function fetchMeta() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sb = createAdminClient() as any
  const [{ count: queuedTotal }, { count: pendingTotal }, { count: probedTotal }] = await Promise.all([
    sb.from('jimscanner_ggsan_newcomer_scores').select('*', { count: 'exact', head: true }).eq('dismissed', false),
    sb
      .from('jimscanner_ggsan_newcomer_scores')
      .select('*', { count: 'exact', head: true })
      .eq('dismissed', false)
      .in('probe_status', ['pending', 'error']),
    sb
      .from('jimscanner_ggsan_newcomer_scores')
      .select('*', { count: 'exact', head: true })
      .eq('dismissed', false)
      .eq('probe_status', 'probed'),
  ])
  return {
    queuedTotal: queuedTotal ?? 0,
    pendingTotal: pendingTotal ?? 0,
    probedTotal: probedTotal ?? 0,
  }
}

function fmtPct(n: number | null) {
  if (n == null) return '—'
  return `${n.toFixed(0)}%`
}
function fmtScore(n: number | null) {
  if (n == null) return '—'
  return n.toFixed(0)
}
function fmtSaturation(n: number | null) {
  if (n == null) return '—'
  return n.toFixed(2)
}

function badgeColor(margin: number | null) {
  if (margin == null) return 'bg-gray-100 text-gray-500'
  if (margin >= 50) return 'bg-red-100 text-red-700'
  if (margin >= 30) return 'bg-amber-100 text-amber-700'
  if (margin >= 15) return 'bg-emerald-100 text-emerald-700'
  return 'bg-gray-100 text-gray-600'
}
function saturationColor(s: number | null) {
  if (s == null) return 'bg-gray-100 text-gray-500'
  if (s <= 0.3) return 'bg-emerald-100 text-emerald-700'
  if (s <= 0.6) return 'bg-amber-100 text-amber-700'
  return 'bg-red-100 text-red-700'
}

export default async function GgsanNewcomersPage({
  searchParams,
}: {
  searchParams: Promise<{ filter?: string; sort?: string; page?: string }>
}) {
  const sp = await searchParams
  const filter = (FILTER_OPTIONS.some((f) => f.v === sp.filter) ? sp.filter : 'all') as Filter
  const sort = (SORT_OPTIONS.some((s) => s.v === sp.sort) ? sp.sort : 'score') as SortKey
  const page = Math.max(1, parseInt(sp.page ?? '1', 10) || 1)

  const current: Record<string, string> = { filter, sort, page: String(page) }

  const [{ rows, total }, meta] = await Promise.all([fetchData({ filter, sort, page }), fetchMeta()])
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  return (
    <div className="space-y-6 p-6">
      <header className="space-y-2">
        <h1 className="text-2xl font-bold">🆕 ggsan 신규 입고 정찰병</h1>
        <p className="text-sm text-gray-500">
          도매가 가장 먼저 푸는 SKU 의 24h 선점 게이트. price_history 1건 = 신상으로 식별, 시장 probe(네이버 쇼핑 / 다나와)
          후 마진율·포화도로 정렬.
        </p>
        <div className="flex gap-4 text-xs text-gray-600">
          <span>큐: <strong>{meta.queuedTotal}</strong></span>
          <span>측정됨: <strong className="text-emerald-700">{meta.probedTotal}</strong></span>
          <span>대기: <strong className="text-amber-700">{meta.pendingTotal}</strong></span>
        </div>
      </header>

      <div className="flex flex-wrap items-center gap-3">
        <div className="flex gap-1">
          {FILTER_OPTIONS.map((f) => (
            <Link
              key={f.v}
              href={buildHref(current, { filter: f.v, page: null })}
              className={`px-2 py-1 text-xs rounded ${
                filter === f.v ? 'bg-black text-white font-semibold' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
              }`}
            >
              {f.label}
            </Link>
          ))}
        </div>

        <div className="ml-auto flex items-center gap-2">
          <span className="text-xs text-gray-500">정렬</span>
          {SORT_OPTIONS.map((s) => (
            <Link
              key={s.v}
              href={buildHref(current, { sort: s.v, page: null })}
              className={`px-2 py-1 text-xs rounded ${
                sort === s.v ? 'bg-amber-100 text-amber-700 font-semibold' : 'text-gray-500 hover:text-black'
              }`}
            >
              {s.label}
            </Link>
          ))}
        </div>
      </div>

      <div className="text-xs text-gray-500">
        {total.toLocaleString()}건 · {page}/{totalPages} 페이지
      </div>

      {rows.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500">
          <p className="text-base font-medium">신규 입고 큐 비어있음</p>
          <p className="text-sm mt-2">
            매일 KST 02:00 ggsan 동기화 직후 자동으로 채워짐. price_history 1건만 가진 row 가 대상.
            <br />
            DDL: <code className="text-xs">supabase/ggsan_newcomers.sql</code>
            <br />
            Probe cron: <code className="text-xs">scripts/probe-newcomer-market.mjs</code>
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
          {rows.map((r) => {
            const noteSeed =
              `[신규 입고 정찰병] ${r.cate_label ?? r.cate_cd ?? ''} · 도매 ${r.price_krw?.toLocaleString() ?? '?'}원 ` +
              `· 시장가 ${r.market_min_krw?.toLocaleString() ?? '미측정'}원 ` +
              `· 마진 ${fmtPct(r.margin_pct)} · 포화도 ${fmtSaturation(r.saturation_score)} ` +
              `· score ${fmtScore(r.newcomer_score)}`
            return (
              <div
                key={r.goods_no}
                className="rounded border border-gray-200 hover:border-amber-400 transition-all overflow-hidden flex flex-col"
              >
                <a href={r.detail_url ?? '#'} target="_blank" rel="noopener" className="block">
                  <div className="aspect-square bg-gray-100 relative overflow-hidden">
                    {r.image_url && (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={r.image_url} alt="" loading="lazy" className="w-full h-full object-cover" />
                    )}
                    {r.newcomer_score != null && (
                      <span className="absolute top-1 left-1 bg-black text-white text-[10px] px-1.5 py-0.5 rounded font-mono">
                        ★ {fmtScore(r.newcomer_score)}
                      </span>
                    )}
                    {r.probe_status === 'pending' && (
                      <span className="absolute top-1 right-1 bg-amber-500 text-white text-[10px] px-1.5 py-0.5 rounded">
                        측정 대기
                      </span>
                    )}
                    {r.probe_status === 'no_match' && (
                      <span className="absolute top-1 right-1 bg-gray-500 text-white text-[10px] px-1.5 py-0.5 rounded">
                        시장 미발견
                      </span>
                    )}
                  </div>
                </a>
                <div className="p-2 space-y-1.5 flex-1 flex flex-col">
                  <div className="text-xs text-gray-400 font-mono flex justify-between">
                    <span>{r.cate_label ?? r.cate_cd ?? '—'}</span>
                    <span>{r.first_seen_at.slice(5, 10)}</span>
                  </div>
                  <div className="text-sm font-medium line-clamp-2 leading-snug" title={r.title}>
                    {r.title}
                  </div>

                  <div className="flex flex-wrap gap-1 text-[10px]">
                    <span className={`px-1.5 py-0.5 rounded ${badgeColor(r.margin_pct)}`} title="예상 마진율">
                      마진 {fmtPct(r.margin_pct)}
                    </span>
                    <span className={`px-1.5 py-0.5 rounded ${saturationColor(r.saturation_score)}`} title="시장 포화도 (0=블루오션, 1=레드오션)">
                      포화 {fmtSaturation(r.saturation_score)}
                    </span>
                    {r.market_seller_count != null && (
                      <span className="px-1.5 py-0.5 rounded bg-gray-100 text-gray-600" title="판매처 수">
                        판매처 {r.market_seller_count}
                      </span>
                    )}
                  </div>

                  <div className="text-xs flex items-baseline gap-2">
                    <span className="font-bold">
                      {r.price_krw ? `${r.price_krw.toLocaleString()}원` : '—'}
                    </span>
                    {r.market_min_krw != null && (
                      <span className="text-gray-500 line-through">
                        시장가 {r.market_min_krw.toLocaleString()}원
                      </span>
                    )}
                  </div>

                  <div className="mt-auto pt-1 flex justify-end">
                    <PinButton
                      goodsNo={r.goods_no}
                      title={r.title}
                      initialPinned={r.pinned}
                      noteSeed={noteSeed}
                    />
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {totalPages > 1 && (
        <nav className="flex items-center justify-center gap-1 pt-4">
          {page > 1 && (
            <Link
              href={buildHref(current, { page: String(page - 1) })}
              className="px-3 py-1 text-sm rounded border border-gray-200 hover:bg-gray-50"
            >
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
                className={`px-3 py-1 text-sm rounded ${
                  n === page ? 'bg-black text-white' : 'border border-gray-200 hover:bg-gray-50'
                }`}
              >
                {n}
              </Link>
            )
          })}
          {page < totalPages && (
            <Link
              href={buildHref(current, { page: String(page + 1) })}
              className="px-3 py-1 text-sm rounded border border-gray-200 hover:bg-gray-50"
            >
              다음
            </Link>
          )}
        </nav>
      )}
    </div>
  )
}
