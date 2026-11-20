import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import { specOf } from '../../../../../scripts/lib/domeatoz-spec.mjs'
import { SpecEditor } from './SpecEditor'

export const dynamic = 'force-dynamic'

// 도매아토즈 규격 입력 — 쿠팡 구매옵션(1개당 중량·개수·맛 등)을 상품명·상세 이미지로 못 만들어 등록기가 제외한 상품.
// 사람이 값을 넣으면 manual_spec 에 저장되고 제외가 풀려 다음 드립 회차(10분 간격)에 등록된다. (2026-11-20 사장님 요청)

const TABLE = 'jimscanner_domeatoz_products'
const PAGE_SIZE = 40
const AUTO = '자동: 구매옵션%'
const SKIP = '사람: 등록 안 함%'

type View = 'weight' | 'attr' | 'other' | 'done' | 'skipped'
const VIEWS: { v: View; label: string; hint: string }[] = [
  { v: 'weight', label: '⚖️ 1개당 중량 필요', hint: '스틱·티백·포처럼 개수만 있는 상품 — 쿠팡이 1개당 중량(또는 용량)을 요구합니다. 상세 이미지의 표시사항(내용량)에서 찾아 넣으세요.' },
  { v: 'attr', label: '🏷️ 필수 옵션 필요', hint: '카테고리가 맛 등 다른 필수 구매옵션을 요구합니다. 상품명·상세 이미지에서 값을 찾아 넣으세요.' },
  { v: 'other', label: '🧩 세트·규격 없음', hint: '세트(구성품마다 중량이 다름)·상품명에 용량이 없음·수량 표기가 애매함. 1개당 중량과 총 개수를 넣거나 [등록 안 함]을 누르세요.' },
  { v: 'done', label: '✍️ 입력 완료', hint: '입력한 값과 쿠팡 등록 결과. 다시 실패하면 사유가 표시됩니다.' },
  { v: 'skipped', label: '🚫 등록 안 함', hint: '[등록 안 함]으로 뺀 상품.' },
]
const SUPPLIER: Record<string, string> = { '00002137': '삼일유통' }

interface Row {
  idx: string
  supplier_code: string | null
  name_clean: string | null
  wholesale_price: number | null
  delivery_price: number | null
  thumb_url: string | null
  detail_images: string[] | null
  register_excluded: boolean
  register_excluded_reason: string | null
  manual_spec: { unit: 'g' | 'ml' | null; per: number | null; pieces: number | null; attrs?: Record<string, string>; note?: string | null; prev_reason?: string | null } | null
  manual_spec_by: string | null
  manual_spec_at: string | null
}
interface Listing { source_goods_no: string; status: string; list_price_krw: number | null; rejection_reason: string | null; created_at: string }
const COLS = 'idx, supplier_code, name_clean, wholesale_price, delivery_price, thumb_url, detail_images, register_excluded, register_excluded_reason, manual_spec, manual_spec_by, manual_spec_at'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function applyView(q: any, view: View) {
  const base = q.eq('status', 'active')
  switch (view) {
    case 'weight':
      return base.eq('register_excluded', true).ilike('register_excluded_reason', AUTO).ilike('register_excluded_reason', '%개수만 있는 이름%')
    case 'attr':
      return base.eq('register_excluded', true).ilike('register_excluded_reason', AUTO).ilike('register_excluded_reason', '%필수 구매옵션%')
    case 'other':
      return base.eq('register_excluded', true).ilike('register_excluded_reason', AUTO)
        .not('register_excluded_reason', 'ilike', '%개수만 있는 이름%').not('register_excluded_reason', 'ilike', '%필수 구매옵션%')
    case 'done':
      return base.not('manual_spec', 'is', null)
    case 'skipped':
      return base.ilike('register_excluded_reason', SKIP)
  }
}

async function fetchData(view: View, q: string, page: number) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sb = createAdminClient() as any
  let query = applyView(sb.from(TABLE).select(COLS, { count: 'exact' }), view)
  const safe = q.replace(/[,()%]/g, ' ').trim()
  if (safe) query = query.ilike('name_clean', `%${safe}%`)
  const offset = (page - 1) * PAGE_SIZE
  const [{ data, count, error }, countResults] = await Promise.all([
    query.order(view === 'done' ? 'manual_spec_at' : 'name_clean', { ascending: view !== 'done' }).range(offset, offset + PAGE_SIZE - 1),
    Promise.all(VIEWS.map((v) => applyView(sb.from(TABLE).select('idx', { count: 'exact', head: true }), v.v))),
  ])
  const rows = (data ?? []) as Row[]
  const counts = Object.fromEntries(VIEWS.map((v, i) => [v.v, (countResults[i] as { count: number | null }).count ?? 0])) as Record<View, number>
  // 입력한 상품의 쿠팡 등록 결과(가장 최근 리스팅)
  const listings = new Map<string, Listing>()
  const ids = rows.filter((r) => r.manual_spec).map((r) => r.idx)
  if (ids.length) {
    const { data: ls } = await sb.from('jimscanner_coupang_listings').select('source_goods_no, status, list_price_krw, rejection_reason, created_at').eq('source', 'domeatoz').in('source_goods_no', ids).order('created_at', { ascending: false })
    for (const l of (ls ?? []) as Listing[]) if (!listings.has(l.source_goods_no)) listings.set(l.source_goods_no, l)
  }
  return { rows, total: (count as number | null) ?? 0, counts, listings, error: (error as { message: string } | null)?.message ?? null }
}

function buildHref(view: View, q: string, page?: number) {
  const params = new URLSearchParams()
  if (view !== 'weight') params.set('view', view)
  if (q) params.set('q', q)
  if (page && page > 1) params.set('page', String(page))
  const qs = params.toString()
  return '/admin/domeatoz-spec' + (qs ? `?${qs}` : '')
}
const fmt = (n: number | null | undefined) => (n == null ? '—' : n.toLocaleString())

/** 제외 사유를 사람 말로 */
function reasonText(r: string | null) {
  const s = String(r ?? '').replace(/^사람: 등록 안 함 \| /, '').replace(/^자동: /, '').replace(/^구매옵션 — /, '')
  if (/개수만 있는 이름/.test(s)) return '1개당 중량(또는 용량)이 필요합니다'
  const m = s.match(/필수 구매옵션: ([^·]+)/)
  if (m) return `필수 구매옵션 '${m[1].trim()}' 값이 필요합니다`
  if (/세트/.test(s)) return '세트 — 구성품마다 중량이 다릅니다'
  if (/용량\(g·ml\)·개수 없음/.test(s)) return '상품명에 용량·개수가 없습니다'
  if (/개당인지 전체인지/.test(s)) return '"(N개입)"이 1개당인지 전체인지 모릅니다'
  return s.slice(0, 80)
}
/** 사유에서 필요한 구매옵션 이름(가공식품맛 등) */
function neededAttrs(r: string | null): string[] {
  const m = String(r ?? '').match(/필수 구매옵션: ([^·]+)/)
  return m ? [m[1].trim()] : []
}
/** 상품명에서 읽은 규격(편집기 기본값) */
function nameSpec(name: string | null) {
  const sp = specOf(name ?? '') as { set: boolean; vol?: { v: number; u: string } | null; count?: number }
  if (sp.set) return { text: '세트(규격 비교 불가)', pieces: null as number | null, per: null as number | null, unit: null as 'g' | 'ml' | null }
  const pieces = sp.count && sp.count > 1 ? sp.count : null
  const unit: 'g' | 'ml' | null = sp.vol ? (sp.vol.u === 'ml' ? 'ml' : 'g') : null
  const text = [sp.vol ? `${sp.vol.v}${sp.vol.u}` : null, pieces ? `${pieces}개` : null].filter(Boolean).join(' × ') || '읽은 규격 없음'
  return { text, pieces, per: sp.vol?.v ?? null, unit }
}
const LISTING_META: Record<string, { label: string; cls: string }> = {
  SELLING: { label: '판매중', cls: 'bg-emerald-100 text-emerald-700' },
  APPROVED: { label: '승인완료', cls: 'bg-emerald-100 text-emerald-700' },
  PENDING_APPROVAL: { label: '승인 대기', cls: 'bg-sky-100 text-sky-700' },
  TEMPORARY_SAVE: { label: '임시저장', cls: 'bg-amber-100 text-amber-700' },
  REJECTED: { label: '반려', cls: 'bg-rose-100 text-rose-700' },
  FAILED: { label: '등록 실패', cls: 'bg-rose-100 text-rose-700' },
}

export default async function DomeatozSpecPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string; q?: string; page?: string }>
}) {
  const sp = await searchParams
  const view = (VIEWS.some((v) => v.v === sp.view) ? sp.view : 'weight') as View
  const q = (sp.q ?? '').trim()
  const page = Math.max(1, parseInt(sp.page ?? '1', 10) || 1)
  const { rows, total, counts, listings, error } = await fetchData(view, q, page)
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const hint = VIEWS.find((v) => v.v === view)?.hint

  return (
    <div className="space-y-5 p-4 sm:p-6">
      <header>
        <h1 className="text-2xl font-bold">⚖️ 도매아토즈 규격 입력</h1>
        <p className="text-sm text-gray-500 mt-1">
          쿠팡 구매옵션(1개당 중량·개수·맛 등)을 상품명이나 상세 이미지로 만들지 못해 <strong>등록에서 빠진 상품</strong>입니다.
          값을 넣고 저장하면 다음 자동 등록 회차(10분 간격)에 쿠팡에 올라갑니다.
        </p>
        <p className="text-[11px] text-gray-400 mt-0.5">
          1개당 중량은 <b>낱개 하나</b>(스틱 1개·티백 1개)의 무게 · 총 개수는 판매 단위 하나에 든 낱개 수(예: 15스틱 × 20개입 = 300)
        </p>
      </header>

      {error && (
        <div className="rounded border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">
          데이터 조회 실패: {error} — <code>supabase/domeatoz_manual_spec.sql</code> 적용 여부를 확인하세요.
        </div>
      )}

      <nav className="flex flex-wrap gap-1 border-b border-gray-200">
        {VIEWS.map((v) => (
          <Link
            key={v.v}
            href={buildHref(v.v, q)}
            className={`px-3 py-2 text-sm border-b-2 ${view === v.v ? 'border-emerald-500 font-semibold' : 'border-transparent text-gray-500 hover:text-black'}`}
          >
            {v.label} <span className="text-xs text-gray-400">{counts[v.v] ?? 0}</span>
          </Link>
        ))}
      </nav>

      <div className="flex flex-wrap items-center gap-3">
        {hint && <p className="text-xs text-gray-500">{hint}</p>}
        <form className="ml-auto w-full max-w-xs" action="/admin/domeatoz-spec">
          {view !== 'weight' && <input type="hidden" name="view" value={view} />}
          <input type="text" name="q" defaultValue={q} placeholder="상품명 검색" className="w-full px-3 py-1 text-sm border border-gray-300 rounded" />
        </form>
      </div>

      <div className="space-y-3">
        {rows.length === 0 && <div className="py-12 text-center text-gray-400 text-sm border rounded bg-white">해당 상품이 없습니다.</div>}
        {rows.map((r) => {
          const ns = nameSpec(r.name_clean)
          const l = listings.get(r.idx)
          const lm = l ? LISTING_META[l.status] ?? { label: l.status, cls: 'bg-gray-100 text-gray-600' } : null
          const imgs = Array.isArray(r.detail_images) ? r.detail_images.filter((u) => typeof u === 'string') : []
          return (
            <div key={r.idx} className="bg-white border rounded p-3 flex flex-col lg:flex-row gap-3">
              <div className="flex items-start gap-3 lg:w-[48%] min-w-0">
                <div className="w-16 h-16 bg-gray-100 rounded overflow-hidden flex-shrink-0">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  {r.thumb_url && <img src={r.thumb_url} alt="" loading="lazy" className="w-full h-full object-cover" />}
                </div>
                <div className="min-w-0">
                  <a href={`https://domeatoz.com/product/${r.idx}`} target="_blank" rel="noreferrer noopener" className="font-medium text-gray-900 hover:text-blue-700 leading-snug block">
                    {r.name_clean} <span className="text-[10px] text-blue-500">↗</span>
                  </a>
                  <div className="mt-0.5 text-[11px] text-gray-500">
                    #{r.idx} · {SUPPLIER[r.supplier_code ?? ''] ?? r.supplier_code ?? '—'} · 도매 {fmt(r.wholesale_price)} + 배송 {fmt(r.delivery_price)}
                  </div>
                  <div className="mt-1 text-xs">
                    <span className="inline-block px-1.5 py-0.5 rounded bg-amber-50 text-amber-800">{reasonText(r.manual_spec?.prev_reason ?? r.register_excluded_reason)}</span>
                    <span className="ml-2 text-gray-400">상품명에서 읽은 규격: {ns.text}</span>
                  </div>
                  {lm && (
                    <div className="mt-1 text-xs">
                      쿠팡: <span className={`inline-block px-1.5 py-0.5 rounded ${lm.cls}`}>{lm.label}</span>
                      {l?.list_price_krw != null && <span className="ml-1 tabular-nums">{fmt(l.list_price_krw)}원</span>}
                      {l?.rejection_reason && <span className="ml-1 text-rose-600">{l.rejection_reason.slice(0, 120)}</span>}
                    </div>
                  )}
                  {r.manual_spec && !l && !r.register_excluded && <div className="mt-1 text-xs text-sky-700">다음 자동 등록 회차를 기다리는 중</div>}
                  {r.manual_spec && r.register_excluded && <div className="mt-1 text-xs text-rose-600">입력 후에도 등록 실패: {String(r.register_excluded_reason ?? '').replace(/^자동: /, '').slice(0, 140)}</div>}
                  {imgs.length > 0 && (
                    <details className="mt-2">
                      <summary className="text-xs text-blue-600 cursor-pointer select-none">상세 이미지 {imgs.length}장 보기(표시사항·내용량 확인)</summary>
                      <div className="mt-2 max-h-[70vh] overflow-y-auto border rounded">
                        {imgs.map((u, i) => (
                          /* eslint-disable-next-line @next/next/no-img-element */
                          <img key={i} src={u} alt={`상세 ${i + 1}`} loading="lazy" referrerPolicy="no-referrer" className="w-full" />
                        ))}
                      </div>
                    </details>
                  )}
                </div>
              </div>
              <div className="lg:flex-1 min-w-0">
                <SpecEditor
                  idx={r.idx}
                  view={view}
                  needAttrs={neededAttrs(r.manual_spec?.prev_reason ?? r.register_excluded_reason)}
                  defaults={{ unit: ns.unit, pieces: ns.pieces }}
                  current={r.manual_spec}
                  by={r.manual_spec_by}
                  at={r.manual_spec_at}
                />
              </div>
            </div>
          )
        })}
      </div>

      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-2 text-sm">
          {page > 1 && <Link href={buildHref(view, q, page - 1)} className="px-3 py-1 rounded border hover:bg-gray-50">← 이전</Link>}
          <span className="text-gray-500">{page} / {totalPages}</span>
          {page < totalPages && <Link href={buildHref(view, q, page + 1)} className="px-3 py-1 rounded border hover:bg-gray-50">다음 →</Link>}
        </div>
      )}
    </div>
  )
}
