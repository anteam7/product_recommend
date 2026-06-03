import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import MarketSizeScatter, { type MarketRow } from './MarketSizeScatter'

export const dynamic = 'force-dynamic'

// jimscanner_trends_market_size 는 generated 타입 미반영 — 적용 후 `npm run gen:types` 시 캐스팅 제거
interface MarketSizeRow {
  product_id: string
  est_monthly_searches: number | null
  assumed_conversion: number | null
  est_avg_price_krw: number | null
  tam_krw: number | null
  competitor_count: number | null
  est_som_krw: number | null
  est_som_share: number | null
  computed_at: string
}

async function fetchData() {
  const sb = createAdminClient()

  // product_id 별 latest 한 row만
  const { data: ms, error } = await sb
    .from('jimscanner_trends_market_size' as never)
    .select(
      'product_id, est_monthly_searches, assumed_conversion, est_avg_price_krw, tam_krw, competitor_count, est_som_krw, est_som_share, computed_at',
    )
    .order('computed_at', { ascending: false })
    .limit(3000)

  if (error) return { rows: [] as MarketRow[], error: error.message }

  const seen = new Set<string>()
  const latest: MarketSizeRow[] = []
  for (const r of (ms ?? []) as unknown as MarketSizeRow[]) {
    if (seen.has(r.product_id)) continue
    seen.add(r.product_id)
    latest.push(r)
  }

  const ids = latest.map((r) => r.product_id)
  if (ids.length === 0) return { rows: [] as MarketRow[], error: null as string | null }

  const { data: prods } = await sb
    .from('jimscanner_trends_products')
    .select('id, canonical_name, category_top')
    .in('id', ids)
  const byId = new Map((prods ?? []).map((p: any) => [p.id, p]))

  const { data: scores } = await sb
    .from('jimscanner_trends_scores')
    .select('product_id, final_score, computed_at')
    .in('product_id', ids)
    .order('computed_at', { ascending: false })
    .limit(5000)
  const finalById = new Map<string, number>()
  for (const s of (scores ?? []) as any[]) {
    if (!finalById.has(s.product_id)) finalById.set(s.product_id, Number(s.final_score))
  }

  const rows: MarketRow[] = latest
    .filter((r) => Number(r.tam_krw) > 0)
    .map((r) => {
      const p = byId.get(r.product_id) ?? {}
      return {
        id: r.product_id,
        name: (p as any).canonical_name ?? '?',
        category: (p as any).category_top ?? 'all',
        tam: Number(r.tam_krw) || 0,
        som: Number(r.est_som_krw) || 0,
        somShare: (Number(r.est_som_share) || 0) * 100,
        final: finalById.get(r.product_id) ?? 50,
        searches: Number(r.est_monthly_searches) || 0,
        conversion: Number(r.assumed_conversion) || 0,
        price: Number(r.est_avg_price_krw) || 0,
        competitors: Number(r.competitor_count) || 0,
      }
    })

  return { rows, error: null as string | null }
}

export default async function MarketSizePage() {
  const { rows, error } = await fetchData()

  const totalTam = rows.reduce((s, r) => s + r.tam, 0)
  const totalSom = rows.reduce((s, r) => s + r.som, 0)
  const goldmine = rows.filter((r) => r.somShare >= 50 && r.tam >= median(rows.map((x) => x.tam))).length

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold">💰 시장규모 역산 보드 — TAM·SOM (₩/월)</h1>
          <p className="text-sm text-gray-500 mt-1">
            X = TAM(₩/월, log) · Y = SOM 점유 추정(%) · 버블 = final_score · 사분면으로 &apos;먹을 파이&apos; 추정
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      <div className="rounded border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-900">
        <strong>추정 보드</strong> · 검색 절대량은 카테고리 <code>volume_relative</code> proxy(키워드도구 절대값 연동 시 교체),
        전환율은 카테고리 base-rate 가정. 정확한 ₩가 아닌 <strong>상대 규모 줄세우기</strong>로 해석.
        슬라이더로 전환율 민감도를 확인하라.
      </div>

      {!error && rows.length > 0 && (
        <section className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Kpi label="분석 상품" value={rows.length} />
          <Kpi label="총 TAM/월" value={`${(totalTam / 1e8).toFixed(1)}억`} />
          <Kpi label="총 SOM/월" value={`${(totalSom / 1e8).toFixed(2)}억`} />
          <Kpi label="⛏ 광맥 후보" value={goldmine} highlight={goldmine > 0} />
        </section>
      )}

      {error ? (
        <div className="rounded border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800">
          조회 에러: <code className="font-mono text-xs">{error}</code>
          <p className="text-xs mt-2 text-red-700">
            테이블 <code>jimscanner_trends_market_size</code> 미적용 가능성. <code>supabase/trends_v4_market_size.sql</code> 적용 +
            <code>jimscanner_recompute_market_size()</code> 실행 필요.
          </p>
        </div>
      ) : rows.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500 space-y-2">
          <div className="text-base font-medium">아직 시장규모 데이터 없음</div>
          <div className="text-xs text-gray-400">
            <code>supabase/trends_v4_market_size.sql</code> 적용 후 <code>jimscanner_recompute_market_size()</code> 실행 →
            recompute_scores 누적 후 자동 풍부해짐.
          </div>
        </div>
      ) : (
        <MarketSizeScatter rows={rows} />
      )}

      {/* 공식 설명 */}
      <section className="text-xs text-gray-500 border-t border-gray-200 pt-4 space-y-1">
        <div className="font-semibold text-gray-700">📐 시장규모 역산 공식</div>
        <code className="block bg-gray-50 px-3 py-2 rounded font-mono text-[11px] leading-relaxed">
          TAM(₩/월) = 월추정검색량 × 카테고리 base-rate 전환율 × 추정판매가
          <br />
          추정판매가 = (도매가 + 배송비 3000) / (1 − 쿠팡수수료 0.106 − 목표마진 0.20)
          <br />
          SOM(₩/월) = TAM ÷ (경쟁추정수 + 1) × 진입타이밍보정(0.5 + final/200)
          <br />
          경쟁추정수 = round((100 − competition_score) / 5)
        </code>
        <div className="pt-2">
          <strong>보강 예정:</strong> #3 검색광고 키워드도구 절대 검색량·CPC 직접 연동 · 카테고리 전환율 실측 교체 ·
          competitor_count 를 쿠팡/스마트스토어 등록상품수 실측으로 대체
        </div>
      </section>
    </div>
  )
}

function median(arr: number[]): number {
  if (arr.length === 0) return 0
  const s = arr.slice().sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]
}

function Kpi({ label, value, highlight = false }: { label: string; value: number | string; highlight?: boolean }) {
  return (
    <div className={`rounded border p-3 ${highlight ? 'border-emerald-300 bg-emerald-50' : 'border-gray-200'}`}>
      <div className="text-xs text-gray-500">{label}</div>
      <div className={`text-2xl font-bold mt-1 ${highlight ? 'text-emerald-700' : ''}`}>
        {typeof value === 'number' ? value.toLocaleString() : value}
      </div>
    </div>
  )
}
