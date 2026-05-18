import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import ChannelPnLMatrix, {
  type PnlRow,
  type PnlCell,
  type ChannelCode,
} from './ChannelPnLMatrix'

export const dynamic = 'force-dynamic'
export const metadata = { title: '채널 P&L 매트릭스 · 트렌드 레이더' }

interface ProductRow {
  id: string
  canonical_name: string
  category_top: string
  category_mid: string | null
  alias_count: number
  last_seen_at: string
}

// 채널 마스터 (DB 미적용 fallback)
const CHANNELS: {
  code: ChannelCode
  label: string
  fee: number
  cpc: number
  ctr: number
  cr: number
  natural: boolean
}[] = [
  { code: 'smartstore', label: 'Smartstore', fee: 0.07, cpc: 300,  ctr: 0.030, cr: 0.025, natural: true },
  { code: 'coupang',    label: 'Coupang',    fee: 0.14, cpc: 900,  ctr: 0.025, cr: 0.030, natural: false },
  { code: '11st',       label: '11번가',     fee: 0.10, cpc: 500,  ctr: 0.022, cr: 0.020, natural: true },
  { code: 'self',       label: '자사몰',     fee: 0.03, cpc: 1200, ctr: 0.015, cr: 0.025, natural: false },
]

const CATEGORY_OVERRIDES: Record<
  string,
  Partial<Record<ChannelCode, { fee?: number; cpc?: number; ctr?: number; cr?: number; seo: number }>>
> = {
  health: {
    smartstore: { fee: 0.07, cpc: 450,  ctr: 0.028, cr: 0.022, seo: 0.75 },
    coupang:    { fee: 0.14, cpc: 1200, ctr: 0.024, cr: 0.030, seo: 0.85 },
    '11st':     { fee: 0.10, cpc: 600,  ctr: 0.020, cr: 0.018, seo: 0.50 },
    self:       { fee: 0.03, cpc: 1500, ctr: 0.012, cr: 0.024, seo: 0.40 },
  },
  living: {
    smartstore: { fee: 0.07, cpc: 280,  ctr: 0.032, cr: 0.028, seo: 0.55 },
    coupang:    { fee: 0.13, cpc: 750,  ctr: 0.026, cr: 0.032, seo: 0.65 },
    '11st':     { fee: 0.10, cpc: 400,  ctr: 0.024, cr: 0.020, seo: 0.40 },
    self:       { fee: 0.03, cpc: 1000, ctr: 0.018, cr: 0.026, seo: 0.30 },
  },
  digital: {
    smartstore: { fee: 0.07, cpc: 380,  ctr: 0.025, cr: 0.020, seo: 0.70 },
    coupang:    { fee: 0.14, cpc: 950,  ctr: 0.022, cr: 0.028, seo: 0.80 },
    '11st':     { fee: 0.10, cpc: 550,  ctr: 0.020, cr: 0.018, seo: 0.55 },
    self:       { fee: 0.03, cpc: 1400, ctr: 0.014, cr: 0.022, seo: 0.40 },
  },
}

const ASSUMED_PRICE = 25000

function computeCells(product: ProductRow): PnlCell[] {
  const weeklySearch = Math.max(product.alias_count, 1) * 1500
  const overrides = CATEGORY_OVERRIDES[product.category_top] ?? {}

  return CHANNELS.map((ch) => {
    const o = overrides[ch.code] ?? { seo: 0.6 }
    const fee = o.fee ?? ch.fee
    const cpc = o.cpc ?? ch.cpc
    const ctr = o.ctr ?? ch.ctr
    const cr = o.cr ?? ch.cr
    const clicks = weeklySearch * ctr
    const gmv = clicks * cr * ASSUMED_PRICE
    const adSpend = clicks * cpc
    // net_margin = 1 - fee - (CPC / (CR × price))
    const netMargin = gmv > 0 ? 1 - fee - cpc / (cr * ASSUMED_PRICE) : null

    return {
      channel_code: ch.code,
      channel_label: ch.label,
      natural_traffic_possible: ch.natural,
      fee_pct: fee,
      cpc_krw: cpc,
      seo_difficulty: o.seo,
      weekly_gmv_krw: Math.round(gmv),
      weekly_ad_spend_krw: Math.round(adSpend),
      weekly_clicks: Math.round(clicks),
      net_margin_pct: netMargin,
      assumed_price_krw: ASSUMED_PRICE,
    }
  })
}

async function fetchTopProducts(): Promise<{ rows: ProductRow[]; error: string | null }> {
  const sb = createAdminClient()
  // jimscanner_trends_products 가 generated types 에 미반영이라 캐스팅
  const { data, error } = await (sb.from('jimscanner_trends_products' as never) as any)
    .select('id, canonical_name, category_top, category_mid, alias_count, last_seen_at')
    .order('last_seen_at', { ascending: false })
    .limit(50)

  if (error) {
    return { rows: [], error: error.message }
  }
  return { rows: (data ?? []) as ProductRow[], error: null }
}

export default async function ChannelPnLPage() {
  const { rows: products, error } = await fetchTopProducts()

  const rows: PnlRow[] = products.map((p) => ({
    product_id: p.id,
    canonical_name: p.canonical_name,
    category_top: p.category_top,
    category_mid: p.category_mid,
    alias_count: p.alias_count,
    cells: computeCells(p),
  }))

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold">💰 채널별 진입 P&amp;L 매트릭스</h1>
          <p className="text-sm text-gray-500 mt-1">
            핀 후보 × Smartstore / Coupang / 11번가 / 자사몰 4채널의 순마진·CPC·SEO 비교 보드.
            셀 클릭 시 P&amp;L breakdown.
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      <div className="rounded border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-900">
        <strong>V0 가정</strong> · 판매가 25,000원 고정 · 주간 검색량 = alias_count × 1500.
        ggsan 도매가 / 실측 CR 연동은 V1. 룩업 룰은{' '}
        <code className="font-mono">supabase/channel_pnl_lookup.sql</code> 적용 시 DB 시드로 대체.
      </div>

      {error && (
        <div className="rounded border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800">
          상품 조회 에러: <code className="font-mono text-xs">{error}</code>
          <p className="text-xs mt-2 text-red-700">
            <code>jimscanner_trends_products</code> 가 비었거나 supabase/trends_v4_seller_tools.sql
            미적용일 가능성.
          </p>
        </div>
      )}

      {!error && rows.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500 space-y-2">
          <div className="text-base font-medium">핀 후보 없음</div>
          <div className="text-xs text-gray-400">
            jimscanner_trends_products 가 비어있습니다. trends LLM 분류 cron 이 돌면 자동 채워집니다.
          </div>
        </div>
      ) : (
        <ChannelPnLMatrix rows={rows} />
      )}

      <section className="text-xs text-gray-500 border-t border-gray-200 pt-4 space-y-1">
        <div className="font-semibold text-gray-700">📐 P&amp;L 공식</div>
        <code className="block bg-gray-50 px-3 py-2 rounded font-mono text-[11px] leading-relaxed">
          net_margin = 1 - channel_fee_pct - (CPC / (CR × price))
          <br />
          weekly_gmv = weekly_search × CTR × CR × price
          <br />
          weekly_ad_spend = weekly_search × CTR × CPC
        </code>
        <div className="pt-2">
          <strong>다음 버전 보강:</strong> ggsan 도매가 연동 → 실제 cost 사용 · naver_shopping_hot
          경쟁밀도로 SEO 난이도 자동 계산 · 카테고리별 평균 판매가 룩업 · BEP 손익분기 검색량 컬럼 추가
        </div>
      </section>
    </div>
  )
}
