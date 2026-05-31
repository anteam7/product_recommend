import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

interface GapRow {
  product_id: string
  canonical_name: string
  category_top: string
  category_mid: string | null
  gap_token: string
  volume: number
  source_keywords: string[] | null
}

interface ProductGap {
  id: string
  name: string
  category_top: string
  category_mid: string | null
  totalVolume: number
  tokens: { tok: string; vol: number; src: string[] }[]
}

async function fetchGap(): Promise<ProductGap[]> {
  const sb = createAdminClient()
  // RPC: 상품 × 화이트스페이스 토큰. 마이그레이션 적용 전이면 빈 배열.
  const { data, error } = await (sb as any).rpc('jimscanner_title_keyword_gap', {
    min_volume: 0,
    result_limit: 1500,
  })
  if (error || !data) return []

  const byProduct = new Map<string, ProductGap>()
  for (const r of data as GapRow[]) {
    let p = byProduct.get(r.product_id)
    if (!p) {
      p = {
        id: r.product_id,
        name: r.canonical_name,
        category_top: r.category_top,
        category_mid: r.category_mid,
        totalVolume: 0,
        tokens: [],
      }
      byProduct.set(r.product_id, p)
    }
    const vol = Number(r.volume) || 0
    p.totalVolume += vol
    p.tokens.push({ tok: r.gap_token, vol, src: r.source_keywords ?? [] })
  }

  const products = [...byProduct.values()]
  for (const p of products) p.tokens.sort((a, b) => b.vol - a.vol)
  products.sort((a, b) => b.totalVolume - a.totalVolume || b.tokens.length - a.tokens.length)
  return products
}

export default async function TitleGapPage() {
  const products = await fetchGap()

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold">제목 키워드 화이트스페이스</h1>
          <p className="text-sm text-gray-500 mt-1">
            실제 검색어 토큰 ∖ 경쟁사 제목 토큰 = 검색은 되는데 경쟁사 제목엔 빠진 키워드.
            토큰 가중 = 네이버 상대검색량. 화이트스페이스 총검색량이 큰 상품일수록 잘 지은 제목 하나로 저비용 상위노출 여지.
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      {products.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500">
          화이트스페이스 토큰 없음. keyword/product_title alias 누적 후 다시 방문하거나
          <code className="mx-1 px-1 rounded bg-gray-100">jimscanner_title_keyword_gap</code> 마이그레이션 적용 여부를 확인하세요.
        </div>
      ) : (
        <div className="space-y-3">
          {products.map((p, rank) => (
            <article key={p.id} className="rounded border border-gray-200 p-4">
              <div className="flex items-baseline justify-between gap-3">
                <div className="flex items-baseline gap-2 min-w-0">
                  <span className="text-xs font-mono text-gray-400">#{rank + 1}</span>
                  <Link
                    href={`/admin/trend-radar/products/${p.id}`}
                    className="font-semibold hover:underline truncate"
                  >
                    {p.name}
                  </Link>
                  <span className="text-xs text-gray-400 shrink-0">
                    {p.category_top}
                    {p.category_mid ? ` / ${p.category_mid}` : ''}
                  </span>
                </div>
                <div className="text-right shrink-0">
                  <div className="text-xs text-gray-500">총검색량 / 토큰</div>
                  <div className="text-sm font-mono">
                    <span className="font-bold">{p.totalVolume.toFixed(0)}</span>
                    <span className="text-gray-400"> · {p.tokens.length}개</span>
                  </div>
                </div>
              </div>
              <div className="mt-3 flex flex-wrap gap-1.5">
                {p.tokens.map((t) => (
                  <span
                    key={t.tok}
                    title={t.src.length ? `검색어: ${t.src.join(', ')}` : undefined}
                    className="inline-flex items-center gap-1 rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-xs text-amber-800"
                  >
                    {t.tok}
                    {t.vol > 0 && <span className="text-[10px] font-mono text-amber-500">{t.vol.toFixed(0)}</span>}
                  </span>
                ))}
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  )
}
