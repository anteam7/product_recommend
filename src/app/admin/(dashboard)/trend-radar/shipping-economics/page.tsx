import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import { tierBadge } from '@/lib/trends/shipping-economics'

export const dynamic = 'force-dynamic'

interface Row {
  id: string
  canonical_name: string
  category_top: string
  dim_weight_g: number | null
  actual_weight_g: number | null
  longest_cm: number | null
  fragility: string | null
  hazard_class: string | null
  cached_unit_shipping_krw: number | null
  cached_estimated_sell_krw: number | null
  cached_burden_ratio: number | null
  cached_economics_at: string | null
}

async function fetchRows(filter: 'all' | 'red' | 'green') {
  const sb = createAdminClient()
  let q = sb
    .from('jimscanner_trends_products')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .select(
      'id, canonical_name, category_top, dim_weight_g, actual_weight_g, longest_cm, fragility, hazard_class, cached_unit_shipping_krw, cached_estimated_sell_krw, cached_burden_ratio, cached_economics_at',
    )
    .not('cached_burden_ratio', 'is', null)
    .order('cached_burden_ratio', { ascending: false })
    .limit(500)
  if (filter === 'red') q = q.gte('cached_burden_ratio', 0.15)
  if (filter === 'green') q = q.lte('cached_burden_ratio', 0.08)
  // 마이그레이션 후 타입 재생성 전 캐스팅.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data } = await (q as any)
  return (data ?? []) as Row[]
}

function tierOf(ratio: number) {
  if (ratio <= 0.08) return 'green' as const
  if (ratio >= 0.15) return 'red' as const
  return 'yellow' as const
}

function fmtKrw(v: number | null) {
  if (v == null) return '-'
  return `${v.toLocaleString()}원`
}

export default async function ShippingEconomicsPage({
  searchParams,
}: {
  searchParams: Promise<{ filter?: string }>
}) {
  const sp = await searchParams
  const filter = (['all', 'red', 'green'].includes(sp.filter as string)
    ? sp.filter
    : 'all') as 'all' | 'red' | 'green'

  const rows = await fetchRows(filter)

  const totals = {
    n: rows.length,
    red: rows.filter((r) => (r.cached_burden_ratio ?? 0) >= 0.15).length,
    green: rows.filter((r) => (r.cached_burden_ratio ?? 1) <= 0.08).length,
  }
  const avgRatio =
    rows.length === 0
      ? 0
      : rows.reduce((a, r) => a + (r.cached_burden_ratio ?? 0), 0) / rows.length

  // 산점도용 좌표 (가격 vs 부담률) — SVG 직접 렌더.
  const MAX_PRICE = Math.max(
    20000,
    ...rows.map((r) => r.cached_estimated_sell_krw ?? 0),
  )
  const points = rows
    .filter((r) => r.cached_estimated_sell_krw && r.cached_burden_ratio != null)
    .map((r) => ({
      x: Math.min(1, (r.cached_estimated_sell_krw ?? 0) / MAX_PRICE),
      y: Math.min(0.6, r.cached_burden_ratio ?? 0),
      tier: tierOf(r.cached_burden_ratio ?? 0),
      name: r.canonical_name,
    }))

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <Link href="/admin/trend-radar" className="text-sm text-gray-500 hover:text-black">
            ← 대시보드
          </Link>
          <h1 className="text-2xl font-bold mt-1">📦 택배 경제성 게이트</h1>
          <p className="text-sm text-gray-500 mt-1">
            국내 택배 단가 / 추정 소비자가 = 부담률. ≥15% = 🔴 마진 킬러, ≤8% = 🟢 녹색 핀.
          </p>
        </div>
      </header>

      <section className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Kpi label="평가된 상품" value={totals.n} hint="물리속성+ggsan 매칭" />
        <Kpi label="🔴 마진 킬러" value={totals.red} hint="≥15% 부담" />
        <Kpi label="🟢 녹색 핀" value={totals.green} hint="≤8% 부담" />
        <Kpi
          label="평균 부담률"
          value={`${(avgRatio * 100).toFixed(1)}%`}
          hint="현재 필터 기준"
        />
      </section>

      <nav className="flex gap-2 border-b border-gray-200">
        {(['all', 'red', 'green'] as const).map((f) => (
          <Link
            key={f}
            href={`/admin/trend-radar/shipping-economics?filter=${f}`}
            className={`px-3 py-2 text-sm ${
              filter === f
                ? 'border-b-2 border-black font-semibold text-black'
                : 'text-gray-500 hover:text-black'
            }`}
          >
            {f === 'all' ? '전체' : f === 'red' ? '🔴 마진 킬러' : '🟢 녹색 핀'}
          </Link>
        ))}
      </nav>

      {/* 산점도 (가격 X · 부담률 Y) */}
      <section className="rounded border border-gray-200 p-4 bg-white">
        <h2 className="text-sm font-semibold text-gray-700 mb-3">
          가격 × 부담률 산점도{' '}
          <span className="text-xs font-normal text-gray-500 ml-2">
            X축: 추정 판매가 (0 ~ {MAX_PRICE.toLocaleString()}원) · Y축: 부담률 (0 ~ 60%)
          </span>
        </h2>
        <Scatter points={points} />
      </section>

      {/* 리스트 */}
      <section>
        {rows.length === 0 ? (
          <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500 text-sm">
            아직 부담률 캐시가 없습니다.
            <br />
            로컬에서{' '}
            <code className="px-1 bg-gray-100 rounded">
              node --env-file=.env.local scripts/compute-shipping-burden.mjs
            </code>{' '}
            먼저 실행하세요.
          </div>
        ) : (
          <div className="grid gap-2">
            <div className="grid grid-cols-12 text-xs text-gray-500 px-3 py-1">
              <div className="col-span-3">상품명</div>
              <div className="col-span-1 text-right">부담률</div>
              <div className="col-span-1 text-right">단가배송</div>
              <div className="col-span-1 text-right">추정가</div>
              <div className="col-span-1 text-right">실무게</div>
              <div className="col-span-1 text-right">부피무게</div>
              <div className="col-span-1 text-right">최장변</div>
              <div className="col-span-1 text-center">취급</div>
              <div className="col-span-1 text-center">위험</div>
              <div className="col-span-1 text-right">티어</div>
            </div>
            {rows.map((r) => {
              const tier = tierOf(r.cached_burden_ratio ?? 0)
              const badge = tierBadge(tier)
              return (
                <Link
                  key={r.id}
                  href={`/admin/trend-radar/products/${r.id}`}
                  className="grid grid-cols-12 px-3 py-2 rounded border border-gray-200 hover:bg-gray-50 text-sm"
                >
                  <div className="col-span-3">
                    <div className="font-medium truncate">{r.canonical_name}</div>
                    <div className="text-xs text-gray-500">{r.category_top}</div>
                  </div>
                  <div
                    className={`col-span-1 text-right font-mono font-bold ${
                      tier === 'red'
                        ? 'text-red-700'
                        : tier === 'green'
                          ? 'text-green-700'
                          : 'text-amber-700'
                    }`}
                  >
                    {((r.cached_burden_ratio ?? 0) * 100).toFixed(1)}%
                  </div>
                  <div className="col-span-1 text-right font-mono text-gray-600">
                    {fmtKrw(r.cached_unit_shipping_krw)}
                  </div>
                  <div className="col-span-1 text-right font-mono text-gray-600">
                    {fmtKrw(r.cached_estimated_sell_krw)}
                  </div>
                  <div className="col-span-1 text-right font-mono text-gray-500">
                    {r.actual_weight_g != null ? `${r.actual_weight_g}g` : '-'}
                  </div>
                  <div className="col-span-1 text-right font-mono text-gray-500">
                    {r.dim_weight_g != null ? `${r.dim_weight_g}g` : '-'}
                  </div>
                  <div className="col-span-1 text-right font-mono text-gray-500">
                    {r.longest_cm != null ? `${r.longest_cm}cm` : '-'}
                  </div>
                  <div className="col-span-1 text-center text-xs text-gray-500">
                    {r.fragility ?? '-'}
                  </div>
                  <div className="col-span-1 text-center text-xs text-gray-500">
                    {r.hazard_class ?? '-'}
                  </div>
                  <div className="col-span-1 text-right">
                    <span
                      className={`text-xs px-2 py-0.5 rounded font-semibold ${
                        tier === 'red'
                          ? 'bg-red-100 text-red-700'
                          : tier === 'green'
                            ? 'bg-green-100 text-green-700'
                            : 'bg-amber-100 text-amber-700'
                      }`}
                    >
                      {badge.emoji} {badge.label}
                    </span>
                  </div>
                </Link>
              )
            })}
          </div>
        )}
      </section>
    </div>
  )
}

function Kpi({
  label,
  value,
  hint,
}: {
  label: string
  value: number | string
  hint: string
}) {
  return (
    <div className="rounded border border-gray-200 p-4">
      <div className="text-xs text-gray-500">{label}</div>
      <div className="text-3xl font-bold mt-1">
        {typeof value === 'number' ? value.toLocaleString() : value}
      </div>
      <div className="text-xs text-gray-400 mt-1">{hint}</div>
    </div>
  )
}

function Scatter({
  points,
}: {
  points: { x: number; y: number; tier: 'green' | 'yellow' | 'red'; name: string }[]
}) {
  const W = 720
  const H = 260
  const PAD = 32
  // Y축 기준선 (15%, 8%)
  const y15 = PAD + (1 - 0.15 / 0.6) * (H - PAD * 2)
  const y08 = PAD + (1 - 0.08 / 0.6) * (H - PAD * 2)

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto" role="img" aria-label="scatter">
      <rect x={0} y={0} width={W} height={H} fill="#fafafa" />
      {/* 위험존 (≥15%) — red tint */}
      <rect x={PAD} y={PAD} width={W - PAD * 2} height={y15 - PAD} fill="#fee2e2" opacity={0.5} />
      {/* 녹색존 (≤8%) — green tint */}
      <rect
        x={PAD}
        y={y08}
        width={W - PAD * 2}
        height={H - PAD - y08}
        fill="#dcfce7"
        opacity={0.5}
      />
      {/* 기준선 */}
      <line x1={PAD} y1={y15} x2={W - PAD} y2={y15} stroke="#dc2626" strokeDasharray="4 3" />
      <line x1={PAD} y1={y08} x2={W - PAD} y2={y08} stroke="#16a34a" strokeDasharray="4 3" />
      <text x={W - PAD - 4} y={y15 - 4} textAnchor="end" fontSize="10" fill="#dc2626">
        15% (마진 킬러)
      </text>
      <text x={W - PAD - 4} y={y08 - 4} textAnchor="end" fontSize="10" fill="#16a34a">
        8% (녹색)
      </text>
      {/* 축 */}
      <line x1={PAD} y1={H - PAD} x2={W - PAD} y2={H - PAD} stroke="#9ca3af" />
      <line x1={PAD} y1={PAD} x2={PAD} y2={H - PAD} stroke="#9ca3af" />
      {/* 점 */}
      {points.map((p, i) => {
        const cx = PAD + p.x * (W - PAD * 2)
        const cy = PAD + (1 - p.y / 0.6) * (H - PAD * 2)
        const fill =
          p.tier === 'red' ? '#dc2626' : p.tier === 'green' ? '#16a34a' : '#f59e0b'
        return (
          <circle key={i} cx={cx} cy={cy} r={4} fill={fill} opacity={0.7}>
            <title>{`${p.name} · ${(p.y * 100).toFixed(1)}%`}</title>
          </circle>
        )
      })}
    </svg>
  )
}
