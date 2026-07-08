import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

// 비셀러(beseller.net) 수집 카탈로그 관리 — scripts/beseller-collect.mjs 적재분.
// 변형(수량/무게) 그룹핑: group_key 로 정렬해 같은 그룹을 연속 표시 + 그룹 시작 행에 뱃지.

interface Row {
  branduid: string
  product_code: string | null
  title: string | null
  group_key: string | null
  variant_label: string | null
  cate_mcode: string | null
  cate_label: string | null
  supply_price: number | null
  tax_note: string | null
  min_sell_price: number | null
  composition: string | null
  order_deadline: string | null
  shipping_note: string | null
  carrier: string | null
  expiry_text: string | null
  origin: string | null
  jeju_islands: string | null
  ship_from: string | null
  supplier_nick: string | null
  thumb_url: string | null
  detail_url: string | null
  status: string
  last_seen_at: string
  last_changed_at: string
}

const CATEGORIES: { code: string; label: string }[] = [
  { code: '001', label: '가공식품' },
  { code: '002', label: '건강식품' },
  { code: '003', label: '농산물' },
  { code: '004', label: '수산물' },
  { code: '005', label: '청과물' },
  { code: '006', label: '축산물' },
  { code: '007', label: '김치/장류/반찬' },
  { code: '008', label: '기타' },
]
const STATUS_LABELS: Record<string, { label: string; cls: string }> = {
  active: { label: '판매중', cls: 'bg-emerald-100 text-emerald-700' },
  soldout: { label: '품절', cls: 'bg-rose-100 text-rose-700' },
  gone: { label: '내려감', cls: 'bg-zinc-200 text-zinc-600' },
}
const SORT_OPTIONS = [
  { v: 'group', label: '그룹순' },
  { v: 'recent', label: '최신 갱신순' },
  { v: 'price_asc', label: '공급가 낮은순' },
  { v: 'price_desc', label: '공급가 높은순' },
] as const
type SortKey = (typeof SORT_OPTIONS)[number]['v']

const PAGE_SIZE = 60

interface Compare {
  group_key: string
  our_supply: number | null
  market_low: number | null
  market_mall: string | null
  market_count: number | null
  margin_at_low: number | null
  margin_rate: number | null
  grade: string | null
  low_confidence: boolean | null
}
const GRADE_META: Record<string, { icon: string; label: string; cls: string }> = {
  strong: { icon: '🏆', label: '강력', cls: 'bg-emerald-200 text-emerald-900' },
  ok: { icon: '✅', label: '경쟁', cls: 'bg-green-100 text-green-700' },
  weak: { icon: '🟡', label: '약함', cls: 'bg-amber-100 text-amber-700' },
}

// 경쟁력 필터: 해당 등급 group_key 집합을 먼저 구해 products 를 in() 필터
async function competitiveKeys(sb: any, mode: string): Promise<string[]> {
  const grades = mode === 'strong' ? ['strong'] : ['strong', 'ok']
  const { data } = await sb.from('jimscanner_beseller_price_compare').select('group_key').in('grade', grades)
  return ((data ?? []) as Array<{ group_key: string }>).map((r) => r.group_key)
}

async function fetchData(opts: { cat: string; status: string; q: string; sort: SortKey; page: number; compete: string }) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sb = createAdminClient() as any
  let query = sb.from('jimscanner_beseller_products').select('*', { count: 'exact' })
  if (opts.cat) query = query.eq('cate_mcode', opts.cat)
  if (opts.status) query = query.eq('status', opts.status)
  if (opts.compete) {
    const keys = await competitiveKeys(sb, opts.compete)
    if (keys.length === 0) return { rows: [], total: 0, cmp: new Map<string, Compare>() }
    query = query.in('group_key', keys)
  }
  if (opts.q) {
    const safe = opts.q.replace(/[,()]/g, ' ').trim() // PostgREST or() 필터 문법 보호
    if (safe) query = query.or(`title.ilike.%${safe}%,group_key.ilike.%${safe}%,supplier_nick.ilike.%${safe}%`)
  }
  switch (opts.sort) {
    case 'recent': query = query.order('last_changed_at', { ascending: false }); break
    case 'price_asc': query = query.order('supply_price', { ascending: true, nullsFirst: false }); break
    case 'price_desc': query = query.order('supply_price', { ascending: false, nullsFirst: false }); break
    case 'group':
    default: query = query.order('group_key', { ascending: true }).order('supply_price', { ascending: true })
  }
  const offset = (opts.page - 1) * PAGE_SIZE
  const { data, count } = await query.range(offset, offset + PAGE_SIZE - 1)
  const rows = (data ?? []) as Row[]
  // 이 페이지 group_key 들의 경쟁력 정보 조인
  const gks = [...new Set(rows.map((r) => r.group_key).filter(Boolean))] as string[]
  const cmp = new Map<string, Compare>()
  if (gks.length) {
    const { data: cd } = await sb.from('jimscanner_beseller_price_compare').select('*').in('group_key', gks)
    for (const c of (cd ?? []) as Compare[]) cmp.set(c.group_key, c)
  }
  return { rows, total: count ?? 0, cmp }
}

async function fetchMeta() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sb = createAdminClient() as any
  // Supabase 기본 1,000행 캡 → 페이징으로 전량 (4,000+건)
  const rows: Array<{ status: string; group_key: string | null; cate_mcode: string | null }> = []
  for (let off = 0; off < 50000; off += 1000) {
    const { data } = await sb.from('jimscanner_beseller_products').select('status, group_key, cate_mcode').range(off, off + 999)
    const chunk = (data ?? []) as typeof rows
    rows.push(...chunk)
    if (chunk.length < 1000) break
  }
  const byStatus = new Map<string, number>()
  const byCat = new Map<string, number>()
  const groups = new Set<string>()
  for (const r of rows) {
    byStatus.set(r.status, (byStatus.get(r.status) ?? 0) + 1)
    if (r.cate_mcode) byCat.set(r.cate_mcode, (byCat.get(r.cate_mcode) ?? 0) + 1)
    if (r.group_key) groups.add(r.group_key)
  }
  // 경쟁력 등급 집계 (Supabase 1,000행 캡 → 페이징)
  const byGrade = new Map<string, number>()
  let comparedTotal = 0
  for (let off = 0; off < 50000; off += 1000) {
    const { data: chunk } = await sb.from('jimscanner_beseller_price_compare').select('grade').range(off, off + 999)
    const cc = (chunk ?? []) as Array<{ grade: string | null }>
    for (const c of cc) if (c.grade) byGrade.set(c.grade, (byGrade.get(c.grade) ?? 0) + 1)
    comparedTotal += cc.length
    if (cc.length < 1000) break
  }
  return { total: rows.length, byStatus, byCat, groupCount: groups.size, byGrade, comparedTotal }
}

function buildHref(current: Record<string, string>, override: Record<string, string | null>) {
  const params = new URLSearchParams()
  for (const [k, v] of Object.entries(current)) if (v) params.set(k, v)
  for (const [k, v] of Object.entries(override)) {
    if (v == null || v === '') params.delete(k)
    else params.set(k, v)
  }
  const qs = params.toString()
  return '/admin/trend-radar/beseller' + (qs ? `?${qs}` : '')
}
const fmt = (n: number | null) => (n == null ? '—' : n.toLocaleString())

export default async function BesellerPage({
  searchParams,
}: {
  searchParams: Promise<{ cat?: string; status?: string; q?: string; sort?: string; page?: string; compete?: string }>
}) {
  const sp = await searchParams
  const cat = CATEGORIES.some((c) => c.code === sp.cat) ? (sp.cat as string) : ''
  const status = ['active', 'soldout', 'gone'].includes(sp.status ?? '') ? (sp.status as string) : ''
  const compete = ['win', 'strong'].includes(sp.compete ?? '') ? (sp.compete as string) : ''
  const q = sp.q ?? ''
  const sort = (SORT_OPTIONS.some((s) => s.v === sp.sort) ? sp.sort : 'group') as SortKey
  const page = Math.max(1, parseInt(sp.page ?? '1', 10) || 1)
  const current: Record<string, string> = { cat, status, compete, q, sort, page: String(page) }

  const [{ rows, total, cmp }, meta] = await Promise.all([fetchData({ cat, status, q, sort, page, compete }), fetchMeta()])
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const winCount = (meta.byGrade.get('strong') ?? 0) + (meta.byGrade.get('ok') ?? 0)

  return (
    <div className="space-y-5 p-6">
      <header className="flex items-baseline justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold">비셀러 카탈로그</h1>
          <p className="text-sm text-gray-500 mt-1">
            beseller.net 수집 상품 — 총 <strong>{meta.total.toLocaleString()}</strong>개 · 변형그룹{' '}
            <strong>{meta.groupCount.toLocaleString()}</strong>개 · 판매중 {meta.byStatus.get('active') ?? 0} · 품절{' '}
            {meta.byStatus.get('soldout') ?? 0} · 내려감 {meta.byStatus.get('gone') ?? 0}
          </p>
          <p className="text-[11px] text-gray-400 mt-0.5">
            수집: <code>beseller-collect.mjs</code> · 품절갱신: <code>beseller-stock-refresh.mjs</code> · 네이버 가격비교: <code>beseller-naver-compete.mjs</code>
          </p>
        </div>
      </header>

      {/* 네이버 경쟁력 요약 + 필터 (그룹 최저옵션 vs 네이버 최저 경쟁가대) */}
      <div className="rounded border border-emerald-200 bg-emerald-50/40 p-3 flex items-center gap-3 flex-wrap">
        <span className="text-sm font-semibold text-emerald-800">🛒 네이버 경쟁력</span>
        <span className="text-xs text-gray-500">비교완료 {meta.comparedTotal.toLocaleString()}그룹 중</span>
        <div className="flex gap-1">
          <Link href={buildHref(current, { compete: null, page: null })} className={`text-xs px-2.5 py-1 rounded ${compete === '' ? 'bg-white border border-emerald-300 font-semibold' : 'text-gray-500 hover:bg-white/60'}`}>전체</Link>
          <Link href={buildHref(current, { compete: 'win', page: null })} className={`text-xs px-2.5 py-1 rounded ${compete === 'win' ? 'bg-emerald-600 text-white font-semibold' : 'bg-white text-emerald-700 border border-emerald-300 hover:bg-emerald-100'}`}>
            🏆✅ 경쟁력 있음 <b>{winCount}</b>
          </Link>
          <Link href={buildHref(current, { compete: 'strong', page: null })} className={`text-xs px-2.5 py-1 rounded ${compete === 'strong' ? 'bg-emerald-700 text-white font-semibold' : 'bg-white text-emerald-800 border border-emerald-300 hover:bg-emerald-100'}`}>
            🏆 강력만 <b>{meta.byGrade.get('strong') ?? 0}</b>
          </Link>
        </div>
        <span className="text-[11px] text-gray-400 ml-auto">🟡약함 {meta.byGrade.get('weak') ?? 0} · 마진 = 네이버 경쟁가대(하위20%)×0.94 − 공급가</span>
      </div>

      {/* 카테고리 필터 */}
      <nav className="flex flex-wrap gap-1 border-b border-gray-200">
        <Link href={buildHref(current, { cat: null, page: null })} className={`px-3 py-2 text-sm border-b-2 ${cat === '' ? 'border-emerald-500 font-semibold' : 'border-transparent text-gray-500 hover:text-black'}`}>
          전체 <span className="text-xs text-gray-400">{meta.total}</span>
        </Link>
        {CATEGORIES.map((c) => {
          const cnt = meta.byCat.get(c.code) ?? 0
          if (cnt === 0 && cat !== c.code) return null
          return (
            <Link key={c.code} href={buildHref(current, { cat: c.code, page: null })} className={`px-3 py-2 text-sm border-b-2 ${cat === c.code ? 'border-emerald-500 font-semibold' : 'border-transparent text-gray-500 hover:text-black'}`}>
              {c.label} <span className="text-xs text-gray-400">{cnt}</span>
            </Link>
          )
        })}
      </nav>

      {/* 상태 + 검색 + 정렬 */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex gap-1">
          {(['', 'active', 'soldout', 'gone'] as const).map((s) => (
            <Link key={s || 'all'} href={buildHref(current, { status: s || null, page: null })} className={`text-xs px-2 py-1 rounded ${status === s ? 'bg-blue-100 text-blue-700 font-semibold' : 'text-gray-500 hover:bg-gray-100'}`}>
              {s === '' ? '상태전체' : STATUS_LABELS[s].label}
            </Link>
          ))}
        </div>
        <form className="flex-1 max-w-xs" action="/admin/trend-radar/beseller">
          {cat && <input type="hidden" name="cat" value={cat} />}
          {status && <input type="hidden" name="status" value={status} />}
          <input type="text" name="q" defaultValue={q} placeholder="상품명·그룹·공급사 검색" className="w-full px-3 py-1 text-sm border border-gray-300 rounded" />
        </form>
        <div className="ml-auto flex items-center gap-2">
          {SORT_OPTIONS.map((s) => (
            <Link key={s.v} href={buildHref(current, { sort: s.v, page: null })} className={`text-xs px-2 py-1 rounded ${sort === s.v ? 'bg-blue-100 text-blue-700 font-semibold' : 'text-gray-500 hover:bg-gray-100'}`}>
              {s.label}
            </Link>
          ))}
        </div>
      </div>

      {/* 테이블 (그룹순 정렬 시 같은 그룹 연속 + 시작행 뱃지) */}
      <div className="overflow-x-auto bg-white border rounded">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-gray-600 text-xs">
            <tr>
              <th className="px-2 py-2 text-left font-semibold w-[34%]">상품 / 변형그룹</th>
              <th className="px-2 py-2 text-right font-semibold">공급가</th>
              <th className="px-2 py-2 text-right font-semibold">최저판매가</th>
              <th className="px-2 py-2 text-left font-semibold">발주마감</th>
              <th className="px-2 py-2 text-left font-semibold">배송</th>
              <th className="px-2 py-2 text-left font-semibold">원산지/소비기한</th>
              <th className="px-2 py-2 text-center font-semibold">상태</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr><td colSpan={7} className="px-3 py-12 text-center text-gray-400 text-sm">수집된 상품이 없습니다. <code>node --env-file=.env.local scripts/beseller-collect.mjs</code> 실행 후 확인하세요.</td></tr>
            )}
            {rows.map((r, i) => {
              const st = STATUS_LABELS[r.status] ?? { label: r.status, cls: 'bg-gray-100 text-gray-600' }
              const groupStart = sort === 'group' && (i === 0 || rows[i - 1].group_key !== r.group_key)
              const groupSize = sort === 'group' ? rows.filter((x) => x.group_key === r.group_key).length : 0
              return (
                <tr key={r.branduid} className={`border-t hover:bg-emerald-50/30 ${groupStart && i !== 0 ? 'border-t-2 border-t-gray-300' : ''}`}>
                  <td className="px-2 py-2">
                    <div className="flex items-start gap-2">
                      <div className="w-11 h-11 bg-gray-100 rounded overflow-hidden flex-shrink-0">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        {r.thumb_url && <img src={r.thumb_url} alt="" loading="lazy" className="w-full h-full object-cover" />}
                      </div>
                      <div className="min-w-0">
                        {groupStart && (
                          <div className="text-[10px] text-violet-700 font-semibold mb-0.5">
                            📦 {r.group_key} <span className="text-violet-400">변형 {groupSize}{groupSize >= 3 ? '+' : ''}종</span>
                          </div>
                        )}
                        {(groupStart || sort !== 'group') && (() => {
                          const c = r.group_key ? cmp.get(r.group_key) : undefined
                          const gm = c ? GRADE_META[c.grade ?? ''] : undefined
                          if (!c || !gm) return null
                          return (
                            <div className="mb-0.5 flex items-center gap-1 flex-wrap">
                              <span className={`text-[10px] px-1.5 py-0.5 rounded font-semibold ${gm.cls}`}>{gm.icon} {gm.label}{c.margin_rate != null ? ' ' + Math.round(c.margin_rate * 100) + '%' : ''}</span>
                              <span className="text-[10px] text-gray-500">네이버 {fmt(c.market_low)} vs 공급 {fmt(c.our_supply)} · 표본 {c.market_count ?? 0}{c.low_confidence ? ' ~저신뢰' : ''}</span>
                            </div>
                          )
                        })()}
                        <a href={r.detail_url ?? '#'} target="_blank" rel="noreferrer noopener" className="font-medium text-gray-900 hover:text-blue-700 leading-snug block">
                          {r.title}
                          {r.variant_label && <span className="ml-1 text-[11px] px-1 py-0.5 rounded bg-violet-50 text-violet-700 font-semibold">{r.variant_label}</span>}
                        </a>
                        <div className="text-[10px] text-gray-400 mt-0.5">
                          {r.composition && <span className="mr-2">구성 {r.composition.slice(0, 30)}</span>}
                          {r.supplier_nick && <span className="mr-2">공급 {r.supplier_nick}</span>}
                          {r.product_code && <span className="font-mono">{r.product_code}</span>}
                        </div>
                      </div>
                    </div>
                  </td>
                  <td className="px-2 py-2 text-right tabular-nums font-semibold">
                    {fmt(r.supply_price)}
                    {r.tax_note && <div className="text-[10px] text-gray-400 font-normal">{r.tax_note}</div>}
                  </td>
                  <td className="px-2 py-2 text-right tabular-nums">{fmt(r.min_sell_price)}</td>
                  <td className="px-2 py-2 text-xs">{r.order_deadline ?? '—'}</td>
                  <td className="px-2 py-2 text-[11px] text-gray-600">
                    {r.carrier && <div>{r.carrier}</div>}
                    {r.jeju_islands && <div className={/불가/.test(r.jeju_islands) ? 'text-rose-600' : ''}>제주 {r.jeju_islands.slice(0, 12)}</div>}
                    {r.ship_from && <div className="text-gray-400">{r.ship_from.slice(0, 16)}</div>}
                  </td>
                  <td className="px-2 py-2 text-[11px] text-gray-600">
                    {r.origin && <div>{r.origin.slice(0, 14)}</div>}
                    {r.expiry_text && <div className="text-gray-400">{r.expiry_text.slice(0, 16)}</div>}
                  </td>
                  <td className="px-2 py-2 text-center">
                    <span className={`inline-block px-2 py-0.5 rounded text-xs ${st.cls}`}>{st.label}</span>
                    <div className="text-[9px] text-gray-400 mt-0.5">{(r.last_seen_at || '').slice(5, 16).replace('T', ' ')}</div>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {/* 페이지네이션 */}
      {totalPages > 1 && (
        <div className="flex justify-center gap-1 text-sm">
          {Array.from({ length: Math.min(totalPages, 12) }, (_, i) => i + 1).map((p) => (
            <Link key={p} href={buildHref(current, { page: String(p) })} className={`px-3 py-1 rounded ${page === p ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'}`}>
              {p}
            </Link>
          ))}
          {totalPages > 12 && <span className="px-2 py-1 text-gray-400">… {totalPages}p</span>}
        </div>
      )}
    </div>
  )
}
