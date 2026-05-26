import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import CatalogCrowdingScatter from './CatalogCrowdingScatter'

export const dynamic = 'force-dynamic'

interface CrowdRow {
  product_id: string
  ggsan_sku: string | null
  sellers_count: number | null
  winner_price: number | null
  winner_badge_type: string | null
  winner_churn_30d: number | null
  canonical_review_count: number | null
  snapshot_at: string
}

async function fetchData() {
  const sb = createAdminClient()
  // latest snapshot per product_id
  const { data } = await sb
    .from('jimscanner_coupang_catalog_crowding' as any)
    .select(
      'product_id, ggsan_sku, sellers_count, winner_price, winner_badge_type, winner_churn_30d, canonical_review_count, snapshot_at',
    )
    .order('snapshot_at', { ascending: false })
    .limit(2000)

  const seen = new Set<string>()
  const latest: CrowdRow[] = []
  for (const r of (data ?? []) as unknown as CrowdRow[]) {
    if (seen.has(r.product_id)) continue
    seen.add(r.product_id)
    latest.push(r)
  }

  // ggsan title 매핑
  const skus = latest.map((r) => r.ggsan_sku).filter((s): s is string => !!s)
  let titleBySku = new Map<string, string>()
  if (skus.length > 0) {
    const { data: prods } = await sb
      .from('jimscanner_ggsan_products')
      .select('goods_no, title')
      .in('goods_no', skus)
    titleBySku = new Map((prods ?? []).map((p: any) => [p.goods_no, p.title]))
  }

  return {
    rows: latest.map((r) => ({
      ...r,
      title: r.ggsan_sku ? titleBySku.get(r.ggsan_sku) ?? null : null,
    })),
  }
}

function quadrantOf(r: CrowdRow): 'NO_ENTRY' | 'ENTRY_OK' | 'WATCH' | 'GREY' {
  const sellers = r.sellers_count ?? 0
  const churn = r.winner_churn_30d ?? 0
  const badge = r.winner_badge_type ?? 'normal'
  const rocketDominant = badge === 'rocket_wow' || badge === 'rocket' || badge === 'rocket_fresh'
  if (sellers >= 5 && rocketDominant) return 'NO_ENTRY'
  if (sellers <= 3 && badge === 'normal') return 'ENTRY_OK'
  if (churn >= 4) return 'WATCH'
  return 'GREY'
}

const QUADRANT_META = {
  NO_ENTRY: { label: '진입 불가 (혼잡 + 로켓독점)', color: '#ef4444' },
  ENTRY_OK: { label: '진입 가능 (저혼잡 + 일반 winner)', color: '#10b981' },
  WATCH: { label: '관망 (높은 churn)', color: '#f59e0b' },
  GREY: { label: '판단 보류', color: '#9ca3af' },
}

export default async function CatalogCrowdingPage() {
  const { rows } = await fetchData()
  const withQ = rows.map((r) => ({ ...r, quadrant: quadrantOf(r) }))
  const counts = {
    NO_ENTRY: withQ.filter((r) => r.quadrant === 'NO_ENTRY').length,
    ENTRY_OK: withQ.filter((r) => r.quadrant === 'ENTRY_OK').length,
    WATCH: withQ.filter((r) => r.quadrant === 'WATCH').length,
    GREY: withQ.filter((r) => r.quadrant === 'GREY').length,
  }

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold">Coupang 아이템위너 카탈로그 혼잡도</h1>
          <p className="text-sm text-gray-500 mt-1">
            X = sellers_count (아이템위너 합류 셀러 수) · Y = winner_churn_30d (30일 winner 교체 횟수) · 색 = 진입 사분면
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      {/* 사분면 카운트 */}
      <section className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {(Object.keys(QUADRANT_META) as Array<keyof typeof QUADRANT_META>).map((k) => (
          <div
            key={k}
            className="rounded border p-3"
            style={{ borderColor: QUADRANT_META[k].color, background: QUADRANT_META[k].color + '15' }}
          >
            <div className="text-xs text-gray-600">{QUADRANT_META[k].label}</div>
            <div className="text-2xl font-bold mt-1" style={{ color: QUADRANT_META[k].color }}>
              {counts[k]}
            </div>
          </div>
        ))}
      </section>

      {withQ.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500">
          <p className="text-base font-medium">아직 데이터 없음</p>
          <p className="text-sm mt-2">
            먼저{' '}
            <code className="bg-gray-100 px-1 py-0.5 rounded">
              node scripts/coupang-catalog-crowding.mjs
            </code>{' '}
            실행하여 캐노니컬 페이지 스냅샷을 적재해주세요.
          </p>
        </div>
      ) : (
        <CatalogCrowdingScatter rows={withQ} />
      )}

      {/* 상세 테이블 */}
      {withQ.length > 0 && (
        <section>
          <h2 className="text-sm font-semibold mb-2">상세 ({withQ.length}건)</h2>
          <div className="rounded border border-gray-200 overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-gray-50 text-gray-500">
                <tr>
                  <th className="px-3 py-2 text-left">사분면</th>
                  <th className="px-3 py-2 text-left">product_id</th>
                  <th className="px-3 py-2 text-left">ggsan SKU</th>
                  <th className="px-3 py-2 text-left">title</th>
                  <th className="px-3 py-2 text-right">sellers</th>
                  <th className="px-3 py-2 text-right">winner ₩</th>
                  <th className="px-3 py-2 text-left">badge</th>
                  <th className="px-3 py-2 text-right">churn 30d</th>
                  <th className="px-3 py-2 text-right">리뷰</th>
                  <th className="px-3 py-2 text-left">snapshot</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {withQ
                  .sort((a, b) => {
                    const order = { ENTRY_OK: 0, WATCH: 1, GREY: 2, NO_ENTRY: 3 } as const
                    return order[a.quadrant] - order[b.quadrant]
                  })
                  .map((r) => (
                    <tr key={r.product_id}>
                      <td className="px-3 py-1">
                        <span
                          className="inline-block px-1.5 py-0.5 rounded text-[10px] font-medium"
                          style={{
                            background: QUADRANT_META[r.quadrant].color + '22',
                            color: QUADRANT_META[r.quadrant].color,
                          }}
                        >
                          {r.quadrant}
                        </span>
                      </td>
                      <td className="px-3 py-1 font-mono">
                        <a
                          href={`https://www.coupang.com/vp/products/${r.product_id}`}
                          target="_blank"
                          rel="noreferrer"
                          className="text-blue-600 hover:underline"
                        >
                          {r.product_id}
                        </a>
                      </td>
                      <td className="px-3 py-1 font-mono">{r.ggsan_sku ?? '—'}</td>
                      <td className="px-3 py-1">{(r as any).title?.slice(0, 38) ?? '—'}</td>
                      <td className="px-3 py-1 text-right">{r.sellers_count ?? '—'}</td>
                      <td className="px-3 py-1 text-right">
                        {r.winner_price?.toLocaleString() ?? '—'}
                      </td>
                      <td className="px-3 py-1">{r.winner_badge_type ?? '—'}</td>
                      <td className="px-3 py-1 text-right">{r.winner_churn_30d ?? 0}</td>
                      <td className="px-3 py-1 text-right">
                        {r.canonical_review_count?.toLocaleString() ?? '—'}
                      </td>
                      <td className="px-3 py-1 font-mono text-gray-500">
                        {r.snapshot_at?.slice(5, 16)}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  )
}
