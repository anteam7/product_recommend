import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

const SCORE_FLOOR = 50
const NO_SALE_DAYS = 30

// jimscanner_trends_funnel_join RPC 한 행 (supabase/trends_funnel.sql)
interface FunnelRow {
  product_id: string
  canonical_name: string
  category_top: string
  final_score: number
  supplier_score: number
  has_supplier: boolean
  ggsan_goods_no: string | null
  ggsan_title: string | null
  ggsan_price_krw: number | null
  ggsan_sim: number | null
  listing_id: string | null
  listing_status: string | null
  listing_sold: number | null
  listing_margin_pct: number | null
  listing_sim: number | null
}

interface StaleListing {
  id: string
  registered_title: string
  status: string
  estimated_margin_pct: number | null
  list_price_krw: number | null
  registered_at: string | null
}

const SELLING_STATES = new Set(['SELLING', 'APPROVED'])

async function fetchFunnel() {
  const sb = createAdminClient()

  // 발굴→소싱→등록 fuzzy 조인 (신규 RPC — generated types 갱신 전까지 any 캐스팅)
  const { data: rpcData, error } = await (sb as any).rpc('jimscanner_trends_funnel_join', {
    score_floor: SCORE_FLOOR,
    min_sim: 0.25,
    result_limit: 400,
  })
  const rows = ((rpcData ?? []) as FunnelRow[])

  // 전체 발굴 canonical 상품 수 (퍼널 최상단 컨텍스트)
  const totalDiscovered =
    (await sb.from('jimscanner_trends_products').select('*', { count: 'exact', head: true })).count ?? 0

  // 등록 후 30일 무판매 listing (판매 누수 — coupang_listings 직접 조회)
  const sinceIso = new Date(Date.now() - NO_SALE_DAYS * 86400_000).toISOString()
  const { data: staleData } = await (sb as any)
    .from('jimscanner_coupang_listings')
    .select('id, registered_title, status, estimated_margin_pct, list_price_krw, registered_at')
    .in('status', ['SELLING', 'APPROVED'])
    .or('sold_count.is.null,sold_count.eq.0')
    .lte('registered_at', sinceIso)
    .order('registered_at', { ascending: true })
    .limit(50)
  const staleListings = ((staleData ?? []) as StaleListing[])

  return { rows, totalDiscovered, staleListings, rpcError: error?.message ?? null }
}

export default async function FunnelPage() {
  const { rows, totalDiscovered, staleListings, rpcError } = await fetchFunnel()

  const isSourced = (r: FunnelRow) => !!r.ggsan_goods_no || r.has_supplier
  const isListed = (r: FunnelRow) => !!r.listing_id
  const isSelling = (r: FunnelRow) => !!r.listing_status && SELLING_STATES.has(r.listing_status)
  const isSold = (r: FunnelRow) => (r.listing_sold ?? 0) > 0

  const nDiscovered = rows.length
  const nSourced = rows.filter(isSourced).length
  const nListed = rows.filter(isListed).length
  const nSelling = rows.filter(isSelling).length
  const nSold = rows.filter(isSold).length

  const stages = [
    { key: 'discovered', label: '발굴 (고점수 ≥50)', value: nDiscovered, color: 'bg-indigo-500' },
    { key: 'sourced', label: '소싱 가능 (ggsan/공급원)', value: nSourced, color: 'bg-sky-500' },
    { key: 'listed', label: '쿠팡 등록', value: nListed, color: 'bg-emerald-500' },
    { key: 'selling', label: '판매중', value: nSelling, color: 'bg-green-500' },
    { key: 'sold', label: '판매 발생', value: nSold, color: 'bg-amber-500' },
  ]
  const maxVal = Math.max(nDiscovered, 1)

  // 액션 큐 3종
  const queueUnsourced = rows.filter((r) => !isSourced(r)).slice(0, 40)
  const queueUnlisted = rows.filter((r) => isSourced(r) && !isListed(r)).slice(0, 40)
  // 큐3은 registered_at 30일 기준 — staleListings (직접 조회)

  return (
    <div className="space-y-6 p-6">
      <header>
        <h1 className="text-2xl font-bold">전환 퍼널 보드</h1>
        <p className="text-sm text-gray-500 mt-1">
          발굴 → 소싱 → 등록 → 판매 전환을 닫힌 루프로 검증. 단계별 정체 상품을 즉시 액션으로 연결.
          <span className="ml-2 text-gray-400">
            (전체 발굴 canonical {totalDiscovered.toLocaleString()}개 · 고점수 ≥{SCORE_FLOOR} 코호트 {nDiscovered}개 기준)
          </span>
        </p>
        {rpcError && (
          <div className="mt-2 rounded border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800">
            RPC 미적용: <code>supabase/trends_funnel.sql</code> 를 Supabase 에 실행하세요. ({rpcError})
          </div>
        )}
      </header>

      {/* 퍼널 막대 + 단계별 전환율/누수율 */}
      <section className="rounded border border-gray-200 p-4 space-y-3">
        <h2 className="text-sm font-semibold text-gray-700">전환 퍼널</h2>
        {stages.map((s, i) => {
          const prev = i === 0 ? null : stages[i - 1].value
          const conv = prev && prev > 0 ? Math.round((s.value / prev) * 100) : null
          const leak = prev && prev > 0 ? prev - s.value : null
          return (
            <div key={s.key} className="flex items-center gap-3">
              <div className="w-44 shrink-0 text-sm text-gray-700">{s.label}</div>
              <div className="flex-1 h-7 bg-gray-100 rounded overflow-hidden">
                <div
                  className={`h-full ${s.color} flex items-center justify-end pr-2 text-xs font-mono font-bold text-white`}
                  style={{ width: `${Math.max((s.value / maxVal) * 100, 3)}%` }}
                >
                  {s.value}
                </div>
              </div>
              <div className="w-40 shrink-0 text-right text-xs">
                {conv !== null ? (
                  <>
                    <span className={conv >= 50 ? 'text-emerald-600 font-semibold' : 'text-rose-600 font-semibold'}>
                      {conv}% 전환
                    </span>
                    {leak !== null && leak > 0 && (
                      <span className="text-gray-400 ml-1">· 누수 {leak}</span>
                    )}
                  </>
                ) : (
                  <span className="text-gray-300">—</span>
                )}
              </div>
            </div>
          )
        })}
      </section>

      {/* 액션 큐 3종 */}
      <ActionQueue
        title="① 고점수인데 미소싱"
        hint="ggsan 도매·공급원 매칭이 없는 고점수 발굴 상품 — 소싱 추격 대상"
        count={queueUnsourced.length}
        empty="미소싱 고점수 상품 없음 — 발굴이 모두 소싱으로 연결됨 ✅"
        accent="border-rose-200 bg-rose-50/40"
      >
        {queueUnsourced.map((r) => (
          <div key={r.product_id} className="grid grid-cols-12 px-2 py-1.5 text-sm rounded hover:bg-white">
            <div className="col-span-7 truncate">
              <Link href={`/admin/trend-radar/products/${r.product_id}`} className="hover:underline">
                {r.canonical_name}
              </Link>
              <span className="text-xs text-gray-400 ml-2">{r.category_top}</span>
            </div>
            <div className="col-span-2 text-right font-mono font-bold">{Math.round(r.final_score)}</div>
            <div className="col-span-3 text-right">
              <Link
                href={`/admin/trend-radar/tv-ggsan-match`}
                className="text-xs text-sky-700 hover:underline"
              >
                ggsan 매칭 →
              </Link>
            </div>
          </div>
        ))}
      </ActionQueue>

      <ActionQueue
        title="② 소싱 가능한데 미등록"
        hint="ggsan/공급원 매칭이 있으나 아직 쿠팡 미등록 — 등록 대기열"
        count={queueUnlisted.length}
        empty="소싱된 상품이 모두 등록됨 ✅"
        accent="border-sky-200 bg-sky-50/40"
      >
        {queueUnlisted.map((r) => (
          <div key={r.product_id} className="grid grid-cols-12 px-2 py-1.5 text-sm rounded hover:bg-white">
            <div className="col-span-6 truncate">
              <Link href={`/admin/trend-radar/products/${r.product_id}`} className="hover:underline">
                {r.canonical_name}
              </Link>
              <span className="text-xs text-gray-400 ml-2">{r.category_top}</span>
            </div>
            <div className="col-span-2 text-right font-mono font-bold">{Math.round(r.final_score)}</div>
            <div className="col-span-2 text-right text-xs text-gray-500 truncate">
              {r.ggsan_goods_no ? `ggsan ${r.ggsan_goods_no}` : '공급원'}
              {r.ggsan_price_krw ? ` · ${r.ggsan_price_krw.toLocaleString()}원` : ''}
            </div>
            <div className="col-span-2 text-right">
              <Link
                href={`/admin/trend-radar/ggsan${r.ggsan_goods_no ? `?q=${encodeURIComponent(r.canonical_name)}` : ''}`}
                className="text-xs text-emerald-700 hover:underline"
              >
                등록 →
              </Link>
            </div>
          </div>
        ))}
      </ActionQueue>

      <ActionQueue
        title={`③ 등록했지만 ${NO_SALE_DAYS}일 무판매`}
        hint={`판매중/승인 상태로 ${NO_SALE_DAYS}일 이상 경과 + 판매 0건 — 가격 재조정 또는 정리 대상`}
        count={staleListings.length}
        empty={`${NO_SALE_DAYS}일 무판매 listing 없음 ✅`}
        accent="border-amber-200 bg-amber-50/40"
      >
        {staleListings.map((l) => (
          <div key={l.id} className="grid grid-cols-12 px-2 py-1.5 text-sm rounded hover:bg-white">
            <div className="col-span-6 truncate">{l.registered_title}</div>
            <div className="col-span-2 text-right text-xs text-gray-500">
              {l.estimated_margin_pct != null ? `${Math.round(l.estimated_margin_pct)}% 마진` : '—'}
            </div>
            <div className="col-span-2 text-right text-xs text-gray-400">
              {l.registered_at ? l.registered_at.slice(0, 10) : '—'}
            </div>
            <div className="col-span-2 text-right">
              <Link
                href={`/admin/coupang-publish?q=${encodeURIComponent(l.registered_title)}`}
                className="text-xs text-amber-700 hover:underline"
              >
                정리/조정 →
              </Link>
            </div>
          </div>
        ))}
      </ActionQueue>
    </div>
  )
}

function ActionQueue({
  title,
  hint,
  count,
  empty,
  accent,
  children,
}: {
  title: string
  hint: string
  count: number
  empty: string
  accent: string
  children: React.ReactNode
}) {
  return (
    <section className={`rounded border p-4 ${accent}`}>
      <div className="flex items-baseline justify-between mb-2">
        <h2 className="text-sm font-semibold text-gray-800">
          {title} <span className="ml-1 font-mono text-gray-500">({count})</span>
        </h2>
        <span className="text-xs text-gray-500">{hint}</span>
      </div>
      {count === 0 ? (
        <div className="text-sm text-gray-500 text-center py-4">{empty}</div>
      ) : (
        <div className="space-y-0.5">{children}</div>
      )}
    </section>
  )
}
