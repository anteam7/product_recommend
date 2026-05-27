import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import PlateauScatter, { type PlateauRow } from './PlateauScatter'

export const dynamic = 'force-dynamic'

interface RpcRow {
  product_id: string
  canonical_name: string
  category_top: string | null
  category_mid: string | null
  trend_score: number
  commerce_score: number
  supplier_score: number
  competition_score: number
  final_score: number
  trend_stddev: number
  trend_velocity_stddev: number | null
  trend_sample_count: number
  supplier_price_cv: number | null
  supplier_count: number
  ggsan_goods_no: string | null
  ggsan_title: string | null
  ggsan_sim: number | null
  latest_computed_at: string
}

const STDDEV_OPTIONS = [
  { v: 3, label: '≤3 (엄격)' },
  { v: 5, label: '≤5 (기본)' },
  { v: 8, label: '≤8 (느슨)' },
  { v: 12, label: '≤12 (탐색)' },
] as const

const COMMERCE_OPTIONS = [60, 70, 80] as const
const COMPETITION_OPTIONS = [50, 60, 70] as const

const CATEGORIES = ['health', 'living', 'digital', 'community', 'shopping_tv'] as const

function buildHref(
  current: Record<string, string>,
  override: Record<string, string | null>,
): string {
  const params = new URLSearchParams()
  for (const [k, v] of Object.entries(current)) if (v) params.set(k, v)
  for (const [k, v] of Object.entries(override)) {
    if (v == null || v === '') params.delete(k)
    else params.set(k, v)
  }
  const qs = params.toString()
  return '/admin/trend-radar/plateau' + (qs ? `?${qs}` : '')
}

async function fetchPlateau(opts: {
  days: number
  stddev: number
  commerce: number
  competition: number
  category: string
}): Promise<{ rows: PlateauRow[]; error: string | null }> {
  const sb = createAdminClient()
  // RPC는 supabase/trends_v4_plateau_goldmine.sql 에 존재. generated 타입 미반영 — 캐스팅 필요.
  const { data, error } = await sb.rpc(
    'jimscanner_trends_plateau_goldmine' as never,
    {
      days_window: opts.days,
      max_trend_stddev: opts.stddev,
      min_commerce: opts.commerce,
      min_competition: opts.competition,
      result_limit: 300,
    } as never,
  )
  if (error) return { rows: [], error: error.message }
  let rpcRows = (data ?? []) as RpcRow[]
  if (opts.category) {
    rpcRows = rpcRows.filter((r) => r.category_top === opts.category)
  }
  const rows: PlateauRow[] = rpcRows.map((r) => ({
    id: r.product_id,
    name: r.canonical_name,
    category: r.category_top ?? 'all',
    trend: Number(r.trend_score),
    commerce: Number(r.commerce_score),
    competition: Number(r.competition_score),
    supplier: Number(r.supplier_score),
    final: Number(r.final_score),
    trendStddev: Number(r.trend_stddev ?? 0),
    trendVelocityStddev:
      r.trend_velocity_stddev == null ? null : Number(r.trend_velocity_stddev),
    trendSampleCount: r.trend_sample_count,
    supplierPriceCv:
      r.supplier_price_cv == null ? null : Number(r.supplier_price_cv),
    supplierCount: r.supplier_count,
    ggsanGoodsNo: r.ggsan_goods_no,
    ggsanTitle: r.ggsan_title,
    ggsanSim: r.ggsan_sim == null ? null : Number(r.ggsan_sim),
  }))
  return { rows, error: null }
}

export default async function PlateauPage({
  searchParams,
}: {
  searchParams: Promise<{
    stddev?: string
    commerce?: string
    competition?: string
    cate?: string
    days?: string
  }>
}) {
  const sp = await searchParams
  const days = parseInt(sp.days ?? '30', 10) || 30
  const stddev = parseFloat(sp.stddev ?? '5')
  const validStddev = STDDEV_OPTIONS.some((s) => s.v === stddev) ? stddev : 5
  const commerce = parseInt(sp.commerce ?? '70', 10)
  const validCommerce = (COMMERCE_OPTIONS as readonly number[]).includes(commerce) ? commerce : 70
  const competition = parseInt(sp.competition ?? '60', 10)
  const validCompetition = (COMPETITION_OPTIONS as readonly number[]).includes(competition)
    ? competition
    : 60
  const category = sp.cate ?? ''

  const current: Record<string, string> = {
    stddev: String(validStddev),
    commerce: String(validCommerce),
    competition: String(validCompetition),
    cate: category,
    days: String(days),
  }

  const { rows, error } = await fetchPlateau({
    days,
    stddev: validStddev,
    commerce: validCommerce,
    competition: validCompetition,
    category,
  })

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold">💎 Plateau Goldmine</h1>
          <p className="text-sm text-gray-500 mt-1">
            정체수요(30일 trend σ ≤ {validStddev}) × 고-Commerce(≥{validCommerce}) × 저-경쟁(competition ≥ {validCompetition}) — surge 핀이 식는 사이의 '평생 매출원' 후보
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      {/* 필터 */}
      <div className="rounded border border-gray-200 px-4 py-3 space-y-3">
        <div className="flex flex-wrap items-center gap-4">
          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-500">trend σ</span>
            {STDDEV_OPTIONS.map((s) => (
              <Link
                key={s.v}
                href={buildHref(current, { stddev: String(s.v) })}
                className={`px-2 py-1 text-xs rounded ${
                  validStddev === s.v
                    ? 'bg-amber-100 text-amber-700 font-semibold'
                    : 'text-gray-500 hover:text-black'
                }`}
              >
                {s.label}
              </Link>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-500">commerce ≥</span>
            {COMMERCE_OPTIONS.map((v) => (
              <Link
                key={v}
                href={buildHref(current, { commerce: String(v) })}
                className={`px-2 py-1 text-xs rounded ${
                  validCommerce === v
                    ? 'bg-amber-100 text-amber-700 font-semibold'
                    : 'text-gray-500 hover:text-black'
                }`}
              >
                {v}
              </Link>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-500">competition ≥</span>
            {COMPETITION_OPTIONS.map((v) => (
              <Link
                key={v}
                href={buildHref(current, { competition: String(v) })}
                className={`px-2 py-1 text-xs rounded ${
                  validCompetition === v
                    ? 'bg-amber-100 text-amber-700 font-semibold'
                    : 'text-gray-500 hover:text-black'
                }`}
              >
                {v}
              </Link>
            ))}
          </div>
        </div>
        <div className="flex flex-wrap gap-1 border-t border-gray-100 pt-2">
          <Link
            href={buildHref(current, { cate: null })}
            className={`px-2 py-1 text-xs rounded ${
              category === '' ? 'bg-black text-white font-semibold' : 'text-gray-500 hover:text-black'
            }`}
          >
            전체
          </Link>
          {CATEGORIES.map((c) => (
            <Link
              key={c}
              href={buildHref(current, { cate: c })}
              className={`px-2 py-1 text-xs rounded ${
                category === c
                  ? 'bg-black text-white font-semibold'
                  : 'text-gray-500 hover:text-black'
              }`}
            >
              {c}
            </Link>
          ))}
        </div>
      </div>

      {error && (
        <div className="rounded border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800">
          RPC 에러: <code className="font-mono text-xs">{error}</code>
          <p className="text-xs mt-2 text-red-700">
            RPC <code>jimscanner_trends_plateau_goldmine</code> 미적용 가능성. supabase/trends_v4_plateau_goldmine.sql 적용 필요.
          </p>
        </div>
      )}

      {!error && (
        <PlateauScatter rows={rows} />
      )}

      <section className="text-xs text-gray-500 border-t border-gray-200 pt-4 space-y-1">
        <div className="font-semibold text-gray-700">📐 Plateau Goldmine 정의</div>
        <code className="block bg-gray-50 px-3 py-2 rounded font-mono text-[11px] leading-relaxed">
          stddev(trend_score, last {days}d) ≤ {validStddev}
          <br />
          AND latest commerce_score ≥ {validCommerce}
          <br />
          AND latest competition_score ≥ {validCompetition} (높을수록 경쟁 약함)
        </code>
        <div className="pt-2">
          surge 시그널이 식는 사이 핀 공백을 메우는 안정 수요 SKU. supplier CV% 가 낮을수록 도매가 변동성도 작음 → 마진 예측 가능.
        </div>
      </section>
    </div>
  )
}
