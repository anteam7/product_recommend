import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

interface ProductRow {
  id: string
  canonical_name: string
  category_top: string
  category_mid: string | null
  brand: string | null
  intent_label: string | null
}

interface BundleRow {
  anchor_id: string
  complement_id: string
  score: number
  reasons: any
  cheapest_supplier_source: string | null
  cheapest_supplier_price_krw: number | null
  cheapest_supplier_moq: number | null
  computed_at: string
}

interface ScoreRow {
  product_id: string
  final_score: number
  computed_at: string
}

async function fetchAnchors() {
  const sb = createAdminClient()
  // 최신 score 기준 final_score Top 30 = anchor 후보
  const { data: scores } = await sb
    .from('jimscanner_trends_scores')
    .select('product_id, final_score, computed_at')
    .order('computed_at', { ascending: false })
    .limit(1500)

  const latest = new Map<string, ScoreRow>()
  for (const s of ((scores ?? []) as ScoreRow[])) {
    if (!latest.has(s.product_id)) latest.set(s.product_id, s)
  }
  const top = [...latest.values()].sort((a, b) => b.final_score - a.final_score).slice(0, 30)
  if (top.length === 0) return { anchors: [] as (ProductRow & { final_score: number })[] }

  const { data: products } = await sb
    .from('jimscanner_trends_products')
    .select('id, canonical_name, category_top, category_mid, brand, intent_label')
    .in('id', top.map((t) => t.product_id))

  const byId = new Map<string, ProductRow>()
  for (const p of (products ?? []) as ProductRow[]) byId.set(p.id, p)

  const anchors = top
    .map((t) => {
      const p = byId.get(t.product_id)
      if (!p) return null
      return { ...p, final_score: t.final_score }
    })
    .filter(Boolean) as (ProductRow & { final_score: number })[]

  return { anchors }
}

async function fetchBundles(anchorId: string) {
  const sb = createAdminClient()
  // 신규 테이블 — 타입 미반영, as never 캐스팅
  const { data, error } = await (sb as any)
    .from('jimscanner_trends_bundle_candidates')
    .select(
      'anchor_id, complement_id, score, reasons, cheapest_supplier_source, cheapest_supplier_price_krw, cheapest_supplier_moq, computed_at',
    )
    .eq('anchor_id', anchorId)
    .order('score', { ascending: false })
    .limit(10)

  if (error) return { bundles: [] as BundleRow[], error: error.message, complements: new Map<string, ProductRow>() }

  const bundles = (data ?? []) as BundleRow[]
  if (bundles.length === 0) return { bundles, complements: new Map<string, ProductRow>() }

  const { data: prods } = await sb
    .from('jimscanner_trends_products')
    .select('id, canonical_name, category_top, category_mid, brand, intent_label')
    .in('id', bundles.map((b) => b.complement_id))

  const complements = new Map<string, ProductRow>()
  for (const p of (prods ?? []) as ProductRow[]) complements.set(p.id, p)

  return { bundles, complements }
}

export default async function BundlesPage({
  searchParams,
}: {
  searchParams: Promise<{ anchor?: string }>
}) {
  const sp = await searchParams
  const { anchors } = await fetchAnchors()
  const anchorId = sp.anchor && anchors.find((a) => a.id === sp.anchor) ? sp.anchor : anchors[0]?.id
  const anchor = anchorId ? anchors.find((a) => a.id === anchorId) : undefined

  const { bundles, complements, error } = anchorId
    ? await fetchBundles(anchorId)
    : { bundles: [] as BundleRow[], complements: new Map<string, ProductRow>(), error: undefined as string | undefined }

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <Link href="/admin/trend-radar" className="text-sm text-gray-500 hover:text-black">
            ← 대시보드
          </Link>
          <h1 className="text-2xl font-bold mt-1">🎁 객단가 부스터 — 보완재 번들</h1>
          <p className="text-sm text-gray-500 mt-1">
            anchor 상품 1개 기준 '함께 팔면 객단가가 오르는' 보완재 Top 10.
            <br />
            매칭: 임베딩 유사도 0.55~0.80 (보완재 구간) + 카테고리 + 페르소나 + 자동완성 co-occurrence.
          </p>
        </div>
        <span className="text-xs text-gray-400">
          배치: <code className="px-1 bg-gray-100 rounded">scripts/compute-bundle-candidates.mjs</code>
        </span>
      </header>

      {/* anchor 선택 */}
      <section>
        <h2 className="text-sm font-semibold mb-2">앵커 상품 선택 (final_score 상위 30)</h2>
        {anchors.length === 0 ? (
          <div className="rounded border border-dashed border-gray-300 p-8 text-center text-gray-500 text-sm">
            아직 score 가 산출된 product 가 없습니다. cron recompute 후 다시 보세요.
          </div>
        ) : (
          <div className="flex flex-wrap gap-2">
            {anchors.map((a) => (
              <Link
                key={a.id}
                href={`/admin/trend-radar/bundles?anchor=${a.id}`}
                className={`text-xs px-3 py-1.5 rounded border transition-colors ${
                  a.id === anchorId
                    ? 'border-black bg-black text-white font-semibold'
                    : 'border-gray-200 hover:bg-gray-50 text-gray-700'
                }`}
              >
                <span className="font-mono mr-1 opacity-60">{a.final_score}</span>
                {a.canonical_name}
                <span className="opacity-60 ml-1">· {a.category_top}</span>
              </Link>
            ))}
          </div>
        )}
      </section>

      {/* 선택된 앵커 요약 */}
      {anchor && (
        <section className="rounded border border-gray-200 p-4 bg-amber-50/40">
          <div className="text-xs text-gray-500">앵커</div>
          <div className="text-lg font-bold mt-1">{anchor.canonical_name}</div>
          <div className="text-xs text-gray-600 mt-1">
            {anchor.brand ? `${anchor.brand} · ` : ''}
            카테고리 {anchor.category_top}
            {anchor.category_mid ? ` / ${anchor.category_mid}` : ''}
            {anchor.intent_label ? ` · 의도: ${anchor.intent_label}` : ''}
            {' · '}final_score <span className="font-mono">{anchor.final_score}</span>
          </div>
        </section>
      )}

      {/* 보완재 Top 10 */}
      <section>
        <div className="flex items-baseline justify-between mb-2">
          <h2 className="text-sm font-semibold">보완재 Top 10 + 묶음 마진/공급사/MOQ</h2>
          {anchor && (
            <span className="text-xs text-gray-500">
              ({bundles.length}건 매칭됨)
            </span>
          )}
        </div>

        {error && (
          <div className="rounded border border-red-300 bg-red-50 p-3 text-xs text-red-700">
            로딩 실패: {error}
            <div className="text-gray-500 mt-1">
              테이블이 아직 적용되지 않았을 수 있습니다 (supabase/trends_v4_bundle_candidates.sql).
            </div>
          </div>
        )}

        {!error && bundles.length === 0 && anchor && (
          <div className="rounded border border-dashed border-gray-300 p-8 text-center text-gray-500 text-sm">
            <p>아직 매칭된 보완재가 없습니다.</p>
            <p className="text-xs mt-2">
              <code className="px-1 bg-gray-100 rounded">
                node scripts/compute-bundle-candidates.mjs --anchor={anchor.id}
              </code>{' '}
              로 배치 산출 필요.
            </p>
          </div>
        )}

        {bundles.length > 0 && (
          <div className="rounded border border-gray-200 overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-gray-500 text-xs">
                <tr>
                  <th className="px-3 py-2 text-left w-8">#</th>
                  <th className="px-3 py-2 text-left">보완재</th>
                  <th className="px-3 py-2 text-left">매칭 근거</th>
                  <th className="px-3 py-2 text-right">score</th>
                  <th className="px-3 py-2 text-right">최저 공급가</th>
                  <th className="px-3 py-2 text-right">MOQ</th>
                  <th className="px-3 py-2 text-left">공급사</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {bundles.map((b, i) => {
                  const comp = complements.get(b.complement_id)
                  const r = b.reasons ?? {}
                  const tags: string[] = []
                  if (typeof r.cosine === 'number') tags.push(`코사인 ${r.cosine.toFixed(2)}`)
                  if (r.category_match) tags.push('동일 카테고리')
                  if (r.persona_match) tags.push('페르소나 공유')
                  if (Array.isArray(r.cooccurrence) && r.cooccurrence.length > 0) {
                    tags.push(`자동완성 ${r.cooccurrence.length}건`)
                  }
                  return (
                    <tr key={b.complement_id} className="hover:bg-gray-50">
                      <td className="px-3 py-2 font-mono text-gray-400">{i + 1}</td>
                      <td className="px-3 py-2">
                        {comp ? (
                          <Link
                            href={`/admin/trend-radar/products/${comp.id}`}
                            className="font-medium hover:underline"
                          >
                            {comp.canonical_name}
                          </Link>
                        ) : (
                          <span className="text-gray-400 font-mono text-xs">{b.complement_id.slice(0, 8)}…</span>
                        )}
                        {comp && (
                          <div className="text-xs text-gray-500">
                            {comp.category_top}
                            {comp.category_mid ? ` / ${comp.category_mid}` : ''}
                          </div>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex flex-wrap gap-1">
                          {tags.map((t, idx) => (
                            <span
                              key={idx}
                              className="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-700"
                            >
                              {t}
                            </span>
                          ))}
                          {tags.length === 0 && <span className="text-xs text-gray-400">—</span>}
                        </div>
                      </td>
                      <td className="px-3 py-2 text-right font-mono font-bold">
                        {b.score.toFixed(2)}
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-gray-700">
                        {b.cheapest_supplier_price_krw != null
                          ? `${Math.round(b.cheapest_supplier_price_krw).toLocaleString()}원`
                          : '—'}
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-gray-700">
                        {b.cheapest_supplier_moq ?? '—'}
                      </td>
                      <td className="px-3 py-2 text-xs text-gray-600">
                        {b.cheapest_supplier_source ?? '—'}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="text-xs text-gray-500 pt-4 border-t border-gray-100">
        💡 매칭 기준:
        <ul className="mt-1 ml-4 list-disc space-y-0.5">
          <li>임베딩 코사인 유사도 0.55 ~ 0.80 (같지도 다르지도 않음 = 보완재 구간)</li>
          <li>동일 category_top + 다른 canonical_name</li>
          <li>동일 intent_label (페르소나 락온 공유)</li>
          <li>자동완성 'X 같이', 'X 세트', 'X 추천' co-occurrence</li>
        </ul>
      </section>
    </div>
  )
}
