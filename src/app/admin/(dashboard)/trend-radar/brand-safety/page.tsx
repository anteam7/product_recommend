import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import WhitelistButton from './WhitelistButton'

export const dynamic = 'force-dynamic'

type Risk = 'block' | 'warn' | 'caution'

interface HitRow {
  id: string
  product_id: string | null
  ggsan_goods_no: string | null
  term_id: string
  matched_term: string
  matched_alias: string | null
  matched_field: string
  match_kind: string
  owner_class: string
  risk_level: Risk
  is_whitelisted: boolean
  created_at: string
}

interface ProductLite {
  id: string
  canonical_name: string
  category_top: string | null
}

interface GgsanLite {
  goods_no: string
  title: string
  image_url: string | null
  detail_url: string | null
}

async function fetchAll() {
  const sb = createAdminClient()

  const { data: hits } = await (sb as any)
    .from('jimscanner_trends_brand_risk_hits')
    .select('id, product_id, ggsan_goods_no, term_id, matched_term, matched_alias, matched_field, match_kind, owner_class, risk_level, is_whitelisted, created_at')
    .order('created_at', { ascending: false })
    .limit(2000)

  const rows = (hits ?? []) as HitRow[]
  const productIds = [...new Set(rows.map((r) => r.product_id).filter((v): v is string => !!v))]
  const goodsNos = [...new Set(rows.map((r) => r.ggsan_goods_no).filter((v): v is string => !!v))]

  const [{ data: prods }, { data: ggs }] = await Promise.all([
    productIds.length
      ? sb.from('jimscanner_trends_products').select('id, canonical_name, category_top').in('id', productIds)
      : Promise.resolve({ data: [] as ProductLite[] }),
    goodsNos.length
      ? (sb as any).from('jimscanner_ggsan_products').select('goods_no, title, image_url, detail_url').in('goods_no', goodsNos)
      : Promise.resolve({ data: [] as GgsanLite[] }),
  ])

  const pMap = new Map<string, ProductLite>(((prods ?? []) as ProductLite[]).map((p) => [p.id, p]))
  const gMap = new Map<string, GgsanLite>(((ggs ?? []) as GgsanLite[]).map((g) => [g.goods_no, g]))

  return { rows, pMap, gMap }
}

function highlight(text: string | null | undefined, term: string) {
  if (!text || !term) return text ?? ''
  const idx = text.toLowerCase().indexOf(term.toLowerCase())
  if (idx < 0) return text
  const before = text.slice(0, idx)
  const hit = text.slice(idx, idx + term.length)
  const after = text.slice(idx + term.length)
  return (
    <>
      {before}
      <mark className="bg-red-200 px-0.5 rounded">{hit}</mark>
      {after}
    </>
  )
}

const RISK_META: Record<Risk, { label: string; cls: string; chip: string }> = {
  block:   { label: 'BLOCK',   cls: 'border-red-300 bg-red-50',     chip: 'bg-red-600 text-white' },
  warn:    { label: 'WARN',    cls: 'border-orange-300 bg-orange-50', chip: 'bg-orange-500 text-white' },
  caution: { label: 'CAUTION', cls: 'border-yellow-300 bg-yellow-50', chip: 'bg-yellow-400 text-black' },
}

export default async function BrandSafetyPage() {
  const { rows, pMap, gMap } = await fetchAll()

  const live = rows.filter((r) => !r.is_whitelisted)
  const grouped: Record<Risk, HitRow[]> = { block: [], warn: [], caution: [] }
  for (const r of live) grouped[r.risk_level].push(r)

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold">🚨 Brand Safety — 상표·IP 침해 게이트</h1>
          <p className="text-sm text-gray-500 mt-1">
            위탁판매 후보 SKU 의 캐릭터/명품/상표 매칭 결과. block 은 즉시 등록 차단.
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      <section className="grid grid-cols-3 gap-4">
        <Kpi risk="block"   count={grouped.block.length} />
        <Kpi risk="warn"    count={grouped.warn.length} />
        <Kpi risk="caution" count={grouped.caution.length} />
      </section>

      {(['block','warn','caution'] as Risk[]).map((risk) => (
        <section key={risk} className="space-y-2">
          <h2 className="text-sm font-semibold flex items-center gap-2">
            <span className={`px-2 py-0.5 rounded text-xs ${RISK_META[risk].chip}`}>
              {RISK_META[risk].label}
            </span>
            <span className="text-gray-600">{grouped[risk].length}건</span>
          </h2>
          {grouped[risk].length === 0 ? (
            <div className="rounded border border-dashed border-gray-200 p-6 text-sm text-gray-400 text-center">
              해당 위험도 hit 없음
            </div>
          ) : (
            <div className="grid gap-2 md:grid-cols-2">
              {grouped[risk].map((h) => {
                const p = h.product_id ? pMap.get(h.product_id) : null
                const g = h.ggsan_goods_no ? gMap.get(h.ggsan_goods_no) : null
                const title = p?.canonical_name ?? g?.title ?? '(unknown)'
                return (
                  <article
                    key={h.id}
                    className={`rounded border p-3 ${RISK_META[risk].cls}`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="text-xs uppercase tracking-wide text-gray-500">
                          {h.owner_class} · {h.match_kind} · {h.matched_field}
                        </div>
                        <div className="text-sm font-medium truncate mt-0.5">
                          {p ? (
                            <Link
                              href={`/admin/trend-radar/products/${p.id}`}
                              className="hover:underline"
                            >
                              {highlight(title, h.matched_term)}
                            </Link>
                          ) : g?.detail_url ? (
                            <a href={g.detail_url} target="_blank" rel="noreferrer" className="hover:underline">
                              {highlight(title, h.matched_term)}
                            </a>
                          ) : (
                            highlight(title, h.matched_term)
                          )}
                        </div>
                        {h.matched_alias && h.matched_field !== 'canonical_name' && h.matched_alias !== title && (
                          <div className="text-xs text-gray-600 mt-1 truncate">
                            ↳ {highlight(h.matched_alias, h.matched_term)}
                          </div>
                        )}
                        <div className="text-xs text-gray-500 mt-1">
                          hit term:{' '}
                          <code className="px-1 rounded bg-white border border-gray-200">{h.matched_term}</code>
                          {' · '}
                          {new Date(h.created_at).toLocaleString('ko-KR')}
                        </div>
                      </div>
                      {g?.image_url && (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={g.image_url}
                          alt=""
                          className="w-14 h-14 object-cover rounded border border-gray-200 flex-none"
                        />
                      )}
                    </div>
                    <div className="mt-2 flex justify-end">
                      <WhitelistButton hitId={h.id} />
                    </div>
                  </article>
                )
              })}
            </div>
          )}
        </section>
      ))}
    </div>
  )
}

function Kpi({ risk, count }: { risk: Risk; count: number }) {
  const meta = RISK_META[risk]
  return (
    <div className={`rounded border p-4 ${meta.cls}`}>
      <div className={`inline-block text-xs px-2 py-0.5 rounded ${meta.chip}`}>{meta.label}</div>
      <div className="text-3xl font-bold mt-2">{count.toLocaleString()}</div>
      <div className="text-xs text-gray-500 mt-1">
        {risk === 'block' && '즉시 등록 차단'}
        {risk === 'warn' && '검수 후 허용 가능'}
        {risk === 'caution' && '주의 — 호환·병행 케이스'}
      </div>
    </div>
  )
}
