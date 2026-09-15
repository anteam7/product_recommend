import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import { MspEditor } from './MspEditor'

export const dynamic = 'force-dynamic'

// 웰루트B2B MSP(최저판매가) 확인·입력 — scripts/wellroot-collect.mjs 적재분 (docs/plan-wellroot-collect.md).
// 유효 MSP가 없는 상품은 쿠팡 등록 대상에서 제외(coupang_eligible=false).
// 사람이 웰루트에 확인한 값을 입력하면 msp_source='manual' 로 저장 → 등록 대상 편입, 수집기가 덮어쓰지 않음.
// 이미지 MSP 표를 판독한 값은 msp_source='ocr' (이미지 해시가 바뀌면 수집기가 해제) — OCR 탭에서 이미지와 대조 검수.

const TABLE = 'jimscanner_wellroot_products'
const PAGE_SIZE = 40

type View = 'missing' | 'image' | 'review' | 'ocr' | 'manual' | 'eligible' | 'all'
const VIEWS: { v: View; label: string; hint: string }[] = [
  { v: 'missing', label: '❓ MSP 없음', hint: '상세페이지에 MSP 문구·표가 없는 상품 — 웰루트에 확인 후 입력하세요.' },
  { v: 'image', label: '🖼️ 이미지 MSP', hint: 'MSP가 표 이미지로만 제공되고 아직 판독·입력되지 않은 상품 — 이미지를 보고 입력하세요.' },
  { v: 'review', label: '⚠️ 검수 필요', hint: '파싱 이상·옵션그룹별 MSP·상세페이지 MSP가 입력값과 달라진 상품.' },
  { v: 'ocr', label: '🤖 OCR 판독', hint: 'MSP 표 이미지를 판독해 넣은 값 — 이미지와 대조해 틀리면 [수정]으로 사람 입력하세요.' },
  { v: 'manual', label: '✍️ 입력 완료', hint: '사람이 확인·입력한 MSP.' },
  { v: 'eligible', label: '✅ 등록 대상', hint: '재판매 가능 · 판매중 · 폐쇄몰 전용 아님 · 유효 MSP 있음.' },
  { v: 'all', label: '전체 후보', hint: '재판매 가능한 전체 상품.' },
]

interface Row {
  product_no: string
  product_code: string | null
  detail_url: string | null
  title: string | null
  name_tags: string[] | null
  cate_labels: string[] | null
  is_health_functional: boolean
  supply_price_krw: number | null
  list_price_krw: number | null
  msp_price_krw: number | null
  tiered_msp: Record<string, number> | null
  msp_source: string | null
  msp_detected_krw: number | null
  msp_detected_tiers: Record<string, number> | null
  msp_detected_source: string | null
  msp_raw_text: string | null
  msp_image_url: string | null
  msp_image_b64?: string | null
  msp_review_needed: boolean
  msp_manual_note: string | null
  msp_verified_by: string | null
  msp_verified_at: string | null
  shipping_fee_krw: number | null
  shipping_text: string | null
  status: string
  closed_mall_only: boolean
  coupang_eligible: boolean
  thumb_url: string | null
}
const COLS =
  'product_no, product_code, detail_url, title, name_tags, cate_labels, is_health_functional, supply_price_krw, list_price_krw, ' +
  'msp_price_krw, tiered_msp, msp_source, msp_detected_krw, msp_detected_tiers, msp_detected_source, msp_raw_text, msp_image_url, ' +
  'msp_review_needed, msp_manual_note, msp_verified_by, msp_verified_at, shipping_fee_krw, shipping_text, status, closed_mall_only, coupang_eligible, thumb_url'

const SOURCE_META: Record<string, { label: string; cls: string }> = {
  text_tier: { label: '텍스트·수량별', cls: 'bg-emerald-100 text-emerald-700' },
  text_single: { label: '텍스트·단일', cls: 'bg-emerald-100 text-emerald-700' },
  img_file: { label: '이미지', cls: 'bg-sky-100 text-sky-700' },
  img_b64: { label: '이미지(내장)', cls: 'bg-sky-100 text-sky-700' },
  manual: { label: '사람 입력', cls: 'bg-violet-100 text-violet-700' },
  ocr: { label: 'OCR', cls: 'bg-indigo-100 text-indigo-700' },
  none: { label: '표기 없음', cls: 'bg-rose-100 text-rose-700' },
}
const STATUS_META: Record<string, { label: string; cls: string }> = {
  active: { label: '판매중', cls: 'bg-emerald-100 text-emerald-700' },
  soldout: { label: '품절', cls: 'bg-rose-100 text-rose-700' },
  restock_wait: { label: '입고대기', cls: 'bg-amber-100 text-amber-700' },
  discontinued: { label: '단종', cls: 'bg-zinc-200 text-zinc-600' },
  gone: { label: '내려감', cls: 'bg-zinc-200 text-zinc-600' },
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function applyView(q: any, view: View) {
  const base = q.eq('resellable', true)
  switch (view) {
    case 'missing':
      return base.is('msp_price_krw', null).eq('msp_detected_source', 'none').eq('closed_mall_only', false).not('status', 'in', '(discontinued,gone)')
    case 'image':
      return base.is('msp_price_krw', null).in('msp_detected_source', ['img_file', 'img_b64']).eq('closed_mall_only', false).not('status', 'in', '(discontinued,gone)')
    case 'review':
      return base.eq('msp_review_needed', true)
    case 'ocr':
      return base.eq('msp_source', 'ocr')
    case 'manual':
      return base.eq('msp_source', 'manual')
    case 'eligible':
      return base.eq('coupang_eligible', true)
    default:
      return base
  }
}

async function fetchData(view: View, q: string, page: number) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sb = createAdminClient() as any
  const withImage = view === 'image' || view === 'review' || view === 'ocr' || view === 'manual'
  let query = applyView(sb.from(TABLE).select(COLS + (withImage ? ', msp_image_b64' : ''), { count: 'exact' }), view)
  const safe = q.replace(/[,()%]/g, ' ').trim()
  if (safe) query = query.ilike('title', `%${safe}%`)
  const offset = (page - 1) * PAGE_SIZE
  const [{ data, count, error }, countResults, { data: last }] = await Promise.all([
    query.order('title', { ascending: true }).range(offset, offset + PAGE_SIZE - 1),
    Promise.all(VIEWS.map((v) => applyView(sb.from(TABLE).select('product_no', { count: 'exact', head: true }), v.v))),
    sb.from(TABLE).select('last_seen_at').order('last_seen_at', { ascending: false }).limit(1),
  ])
  const counts = Object.fromEntries(VIEWS.map((v, i) => [v.v, (countResults[i] as { count: number | null }).count ?? 0])) as Record<View, number>
  return {
    rows: (data ?? []) as Row[],
    total: (count as number | null) ?? 0,
    counts,
    lastSeen: ((last ?? []) as Array<{ last_seen_at: string }>)[0]?.last_seen_at ?? null,
    error: (error as { message: string } | null)?.message ?? null,
  }
}

function buildHref(view: View, q: string, page?: number) {
  const params = new URLSearchParams()
  if (view !== 'missing') params.set('view', view)
  if (q) params.set('q', q)
  if (page && page > 1) params.set('page', String(page))
  const qs = params.toString()
  return '/admin/wellroot-msp' + (qs ? `?${qs}` : '')
}
const fmt = (n: number | null) => (n == null ? '—' : n.toLocaleString())

export default async function WellrootMspPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string; q?: string; page?: string }>
}) {
  const sp = await searchParams
  const view = (VIEWS.some((v) => v.v === sp.view) ? sp.view : 'missing') as View
  const q = (sp.q ?? '').trim()
  const page = Math.max(1, parseInt(sp.page ?? '1', 10) || 1)
  const { rows, total, counts, lastSeen, error } = await fetchData(view, q, page)
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const hint = VIEWS.find((v) => v.v === view)?.hint

  return (
    <div className="space-y-5 p-6">
      <header>
        <h1 className="text-2xl font-bold">🌿 웰루트 MSP 확인</h1>
        <p className="text-sm text-gray-500 mt-1">
          최저판매가(MSP)가 없는 상품은 <strong>쿠팡 등록에서 제외</strong>됩니다. 웰루트에 확인한 값을 입력하면 등록 대상에 포함되고, 수집기가 덮어쓰지 않습니다.
        </p>
        <p className="text-[11px] text-gray-400 mt-0.5">
          MSP는 <b>배송비 포함 금액</b> · 공급가는 VAT 포함 · 수집: <code>node scripts/wellroot-collect.mjs</code>
          {lastSeen && <> · 마지막 수집 {lastSeen.slice(0, 16).replace('T', ' ')}</>}
        </p>
      </header>

      {error && (
        <div className="rounded border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">
          데이터 조회 실패: {error} — <code>supabase/wellroot_products.sql</code> 적용과 수집 실행 여부를 확인하세요.
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
        <form className="ml-auto w-full max-w-xs" action="/admin/wellroot-msp">
          {view !== 'missing' && <input type="hidden" name="view" value={view} />}
          <input type="text" name="q" defaultValue={q} placeholder="상품명 검색" className="w-full px-3 py-1 text-sm border border-gray-300 rounded" />
        </form>
      </div>

      <div className="overflow-x-auto bg-white border rounded">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-gray-600 text-xs">
            <tr>
              <th className="px-2 py-2 text-left font-semibold w-[30%]">상품</th>
              <th className="px-2 py-2 text-right font-semibold">공급가</th>
              <th className="px-2 py-2 text-left font-semibold">상세페이지 MSP 근거</th>
              <th className="px-2 py-2 text-center font-semibold">상태</th>
              <th className="px-2 py-2 text-right font-semibold">유효 MSP / 입력</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr><td colSpan={5} className="px-3 py-12 text-center text-gray-400 text-sm">해당 상품이 없습니다.</td></tr>
            )}
            {rows.map((r) => {
              const src = SOURCE_META[r.msp_detected_source ?? 'none'] ?? SOURCE_META.none
              const st = STATUS_META[r.status] ?? { label: r.status, cls: 'bg-gray-100 text-gray-600' }
              const img = r.msp_image_url || r.msp_image_b64 || null
              const detTiers = Object.entries(r.msp_detected_tiers ?? {}).sort((a, b) => Number(a[0]) - Number(b[0]))
              return (
                <tr key={r.product_no} className="border-t align-top hover:bg-emerald-50/30">
                  <td className="px-2 py-2">
                    <div className="flex items-start gap-2">
                      <div className="w-12 h-12 bg-gray-100 rounded overflow-hidden flex-shrink-0">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        {r.thumb_url && <img src={r.thumb_url} alt="" loading="lazy" className="w-full h-full object-cover" />}
                      </div>
                      <div className="min-w-0">
                        <a href={r.detail_url ?? '#'} target="_blank" rel="noreferrer noopener" className="font-medium text-gray-900 hover:text-blue-700 leading-snug block">
                          {r.title} <span className="text-[10px] text-blue-500">↗</span>
                        </a>
                        <div className="mt-0.5 flex flex-wrap gap-1 items-center">
                          {r.is_health_functional && <span className="text-[10px] px-1 rounded bg-teal-100 text-teal-700">건기식</span>}
                          {r.closed_mall_only && <span className="text-[10px] px-1 rounded bg-zinc-200 text-zinc-700">폐쇄몰 전용</span>}
                          {r.msp_review_needed && <span className="text-[10px] px-1 rounded bg-amber-100 text-amber-700">검수 필요</span>}
                          <span className="text-[10px] text-gray-400">
                            #{r.product_no} · {[...new Set(r.cate_labels ?? [])].join(', ')}
                          </span>
                        </div>
                      </div>
                    </div>
                  </td>
                  <td className="px-2 py-2 text-right tabular-nums whitespace-nowrap">
                    <div className="font-semibold">{fmt(r.supply_price_krw)}</div>
                    {r.list_price_krw != null && <div className="text-[10px] text-gray-400">소비자가 {fmt(r.list_price_krw)}</div>}
                    <div className="text-[10px] text-gray-400">
                      배송 {fmt(r.shipping_fee_krw)}{/차등/.test(r.shipping_text ?? '') ? ' (수량차등)' : ''}
                    </div>
                  </td>
                  <td className="px-2 py-2 text-xs">
                    <span className={`inline-block text-[10px] px-1.5 py-0.5 rounded font-semibold ${src.cls}`}>{src.label}</span>
                    {r.msp_detected_krw != null && (
                      <span className="ml-1 tabular-nums text-gray-700">
                        {fmt(r.msp_detected_krw)}
                        {detTiers.length > 1 && <span className="text-gray-400"> · {detTiers.filter(([k]) => k !== '1').map(([k, v]) => `${k}개 ${fmt(v)}`).join(' · ')}</span>}
                      </span>
                    )}
                    {r.msp_raw_text && <div className="mt-1 text-[11px] text-gray-500 max-w-[420px] leading-snug">“{r.msp_raw_text.slice(0, 160)}”</div>}
                    {img ? (
                      /* eslint-disable-next-line @next/next/no-img-element */
                      <img src={img} alt="MSP 표" loading="lazy" className="mt-1 w-full max-w-[460px] border rounded" />
                    ) : (r.msp_detected_source === 'img_file' || r.msp_detected_source === 'img_b64') ? (
                      <div className="mt-1 text-[11px] text-gray-400">이미지는 <Link className="underline" href={buildHref('ocr', r.title ?? '')}>OCR 판독 탭</Link>에서 표시</div>
                    ) : r.msp_detected_source === 'none' ? (
                      <div className="mt-1 text-[11px] text-gray-400">상세페이지에 MSP 표기가 없습니다 — 상품 링크에서 확인하세요.</div>
                    ) : null}
                  </td>
                  <td className="px-2 py-2 text-center whitespace-nowrap">
                    <span className={`inline-block px-2 py-0.5 rounded text-xs ${st.cls}`}>{st.label}</span>
                    <div className={`mt-1 text-[10px] font-semibold ${r.coupang_eligible ? 'text-emerald-600' : 'text-gray-400'}`}>
                      {r.coupang_eligible ? '✅ 등록 대상' : '등록 제외'}
                    </div>
                  </td>
                  <td className="px-2 py-2">
                    <MspEditor
                      productNo={r.product_no}
                      msp={r.msp_price_krw}
                      tiers={r.tiered_msp}
                      source={r.msp_source}
                      detected={r.msp_detected_krw}
                      detectedTiers={r.msp_detected_tiers}
                      note={r.msp_manual_note}
                      verifiedBy={r.msp_verified_by}
                      verifiedAt={r.msp_verified_at}
                    />
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
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
