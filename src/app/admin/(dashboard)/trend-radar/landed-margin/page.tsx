import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

interface MarginRow {
  goods_no: string
  title: string
  ggsan_cate_cd: string | null
  ggsan_cate_label: string | null
  ggsan_price_krw: number | null
  is_imminent: boolean
  image_url: string | null
  detail_url: string | null
  manifest_category_tag: string | null
  manifest_sample_n: number
  manifest_p10_krw: number | string | null
  manifest_p50_krw: number | string | null
  manifest_p90_krw: number | string | null
  volumetric_cost_krw: number | string | null
  margin_krw: number | string | null
  margin_pct: number | string | null
  gmv_expected_krw: number | string | null
}

const DAYS_OPTIONS = [
  { v: 60, label: '60일' },
  { v: 180, label: '180일 (기본)' },
  { v: 365, label: '365일' },
] as const

const CATEGORIES: { code: string; label: string }[] = [
  { code: '001', label: '장건강' },
  { code: '002', label: '눈건강' },
  { code: '003', label: '간건강' },
  { code: '005', label: '혈행건강' },
  { code: '006', label: '관절건강' },
  { code: '007', label: '면역건강' },
  { code: '008', label: '체지방' },
  { code: '009', label: '건기식기타' },
  { code: '010', label: '전통건강식품' },
  { code: '011', label: '전립선' },
  { code: '012', label: '식품분말' },
  { code: '013', label: '가공식품기타' },
  { code: '014', label: '신선식품' },
  { code: '020', label: '임박특가' },
]

function n(v: number | string | null | undefined): number {
  if (v == null) return NaN
  const x = typeof v === 'number' ? v : parseFloat(v)
  return Number.isFinite(x) ? x : NaN
}

function fmtKrw(v: number | string | null | undefined, opts: { signed?: boolean } = {}): string {
  const x = n(v)
  if (!Number.isFinite(x)) return '-'
  const rounded = Math.round(x)
  const sign = opts.signed && rounded > 0 ? '+' : ''
  return `${sign}${rounded.toLocaleString()}원`
}

function fmtPct(v: number | string | null | undefined): string {
  const x = n(v)
  if (!Number.isFinite(x)) return '-'
  return `${(x * 100).toFixed(1)}%`
}

function marginColor(pct: number): string {
  if (!Number.isFinite(pct)) return 'bg-gray-200 text-gray-600'
  if (pct >= 1.5) return 'bg-emerald-600 text-white'
  if (pct >= 0.8) return 'bg-emerald-400 text-white'
  if (pct >= 0.3) return 'bg-lime-300 text-lime-900'
  if (pct >= 0.0) return 'bg-yellow-200 text-yellow-900'
  if (pct >= -0.3) return 'bg-orange-300 text-orange-900'
  return 'bg-red-400 text-white'
}

async function fetchMargin(opts: { days: number; cate: string }) {
  const sb = createAdminClient()
  const { data, error } = await sb.rpc('jimscanner_customs_anchor_margin' as never, {
    p_category: opts.cate || null,
    p_days_window: opts.days,
  } as never)
  if (error) return { rows: [] as MarginRow[], error: error.message }
  return { rows: (data ?? []) as MarginRow[], error: null as string | null }
}

function buildHref(current: Record<string, string>, override: Record<string, string | null>): string {
  const params = new URLSearchParams()
  for (const [k, v] of Object.entries(current)) if (v) params.set(k, v)
  for (const [k, v] of Object.entries(override)) {
    if (v == null || v === '') params.delete(k)
    else params.set(k, v)
  }
  const qs = params.toString()
  return '/admin/trend-radar/landed-margin' + (qs ? `?${qs}` : '')
}

interface BoxStats {
  cate_cd: string
  cate_label: string
  n: number
  p10: number
  p50: number
  p90: number
  min: number
  max: number
}

function computeBoxplots(rows: MarginRow[]): BoxStats[] {
  const byCate = new Map<string, { label: string; pcts: number[] }>()
  for (const r of rows) {
    const code = r.ggsan_cate_cd ?? '?'
    const label = r.ggsan_cate_label ?? code
    const p = n(r.margin_pct)
    if (!Number.isFinite(p)) continue
    if (!byCate.has(code)) byCate.set(code, { label, pcts: [] })
    byCate.get(code)!.pcts.push(p)
  }
  const out: BoxStats[] = []
  for (const [code, { label, pcts }] of byCate) {
    if (pcts.length === 0) continue
    const sorted = [...pcts].sort((a, b) => a - b)
    const pick = (q: number) => {
      const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(q * (sorted.length - 1))))
      return sorted[idx]
    }
    out.push({
      cate_cd: code,
      cate_label: label,
      n: pcts.length,
      p10: pick(0.1),
      p50: pick(0.5),
      p90: pick(0.9),
      min: sorted[0],
      max: sorted[sorted.length - 1],
    })
  }
  out.sort((a, b) => b.p50 - a.p50)
  return out
}

function Boxplot({ stats, xMin, xMax }: { stats: BoxStats; xMin: number; xMax: number }) {
  const range = xMax - xMin || 1
  const toX = (v: number) => ((Math.min(xMax, Math.max(xMin, v)) - xMin) / range) * 100
  const zeroX = toX(0)
  return (
    <div className="flex items-center gap-3 py-1">
      <div className="w-32 text-xs font-medium text-gray-700 truncate" title={stats.cate_label}>
        {stats.cate_label}
      </div>
      <div className="w-10 text-[10px] text-gray-400 text-right">n={stats.n}</div>
      <div className="relative flex-1 h-7 bg-gray-50 rounded">
        {/* zero line */}
        <div
          className="absolute top-0 bottom-0 w-px bg-gray-400"
          style={{ left: `${zeroX}%` }}
          title="margin = 0"
        />
        {/* whisker p10..p90 */}
        <div
          className="absolute top-1/2 -translate-y-1/2 h-px bg-gray-500"
          style={{ left: `${toX(stats.p10)}%`, width: `${toX(stats.p90) - toX(stats.p10)}%` }}
        />
        {/* box: simple — use p10..p90 as box */}
        <div
          className={`absolute top-1/2 -translate-y-1/2 h-4 rounded ${marginColor(stats.p50)}`}
          style={{ left: `${toX(stats.p10)}%`, width: `${Math.max(2, toX(stats.p90) - toX(stats.p10))}%` }}
        />
        {/* median tick */}
        <div
          className="absolute top-1/2 -translate-y-1/2 h-5 w-0.5 bg-black"
          style={{ left: `${toX(stats.p50)}%` }}
          title={`P50 = ${(stats.p50 * 100).toFixed(0)}%`}
        />
      </div>
      <div className="w-20 text-xs font-mono text-right text-gray-700">
        {(stats.p50 * 100).toFixed(0)}%
      </div>
    </div>
  )
}

export default async function LandedMarginPage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string; cate?: string }>
}) {
  const sp = await searchParams
  const days = parseInt(sp.days ?? '180', 10)
  const validDays = DAYS_OPTIONS.some((d) => d.v === days) ? days : 180
  const cate = sp.cate ?? ''
  const current: Record<string, string> = {
    days: String(validDays),
    cate,
  }

  const { rows, error } = await fetchMargin({ days: validDays, cate })

  // KPI
  const total = rows.length
  const profitable = rows.filter((r) => n(r.margin_pct) > 0).length
  const medianMargin = (() => {
    const arr = rows.map((r) => n(r.margin_pct)).filter((x) => Number.isFinite(x)).sort((a, b) => a - b)
    return arr.length ? arr[Math.floor(arr.length / 2)] : NaN
  })()
  const maxMargin = (() => {
    const arr = rows.map((r) => n(r.margin_pct)).filter((x) => Number.isFinite(x))
    return arr.length ? Math.max(...arr) : NaN
  })()

  const boxStats = computeBoxplots(rows)
  // x축 범위는 -0.5 ~ 2.0 으로 클램프
  const xMin = -0.5
  const xMax = 2.0

  const top20 = [...rows]
    .filter((r) => Number.isFinite(n(r.margin_pct)))
    .sort((a, b) => n(b.margin_pct) - n(a.margin_pct))
    .slice(0, 20)

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold">📦 Customs-Anchor 마진 보드</h1>
          <p className="text-sm text-gray-500 mt-1">
            manifest 실측 직구가(P50) − ggsan 도매가 − 부피무게비용 = <strong>위탁 마진</strong> · 카테고리별 박스플롯
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      <div className="rounded border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-900">
        <strong>해석</strong> · P50 직구 신고가는 한국인이 <em>실제 통관에서 신고한 가격</em> 이라 시장 자기보고가 아닌 실측이다.
        margin&nbsp;%&nbsp;가 0&nbsp;% 미만이면 ggsan 도매가 + 항공운임 부담만으로도 직구러보다 비싸진다 → 진입 불가.
      </div>

      {/* 필터 */}
      <div className="rounded border border-gray-200 px-4 py-3 space-y-3">
        <div className="flex flex-wrap items-center gap-4">
          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-500">manifest 윈도우</span>
            {DAYS_OPTIONS.map((d) => (
              <Link
                key={d.v}
                href={buildHref(current, { days: String(d.v) })}
                className={`px-2 py-1 text-xs rounded ${validDays === d.v ? 'bg-amber-100 text-amber-700 font-semibold' : 'text-gray-500 hover:text-black'}`}
              >
                {d.label}
              </Link>
            ))}
          </div>
        </div>
        <div className="flex flex-wrap gap-1 border-t border-gray-100 pt-2">
          <Link
            href={buildHref(current, { cate: null })}
            className={`px-2 py-1 text-xs rounded ${cate === '' ? 'bg-black text-white font-semibold' : 'text-gray-500 hover:text-black'}`}
          >
            전체
          </Link>
          {CATEGORIES.map((c) => (
            <Link
              key={c.code}
              href={buildHref(current, { cate: c.code })}
              className={`px-2 py-1 text-xs rounded ${cate === c.code ? 'bg-black text-white font-semibold' : 'text-gray-500 hover:text-black'}`}
            >
              {c.label}
            </Link>
          ))}
        </div>
      </div>

      {/* KPI */}
      <section className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Kpi label="매칭 ggsan SKU" value={total} />
        <Kpi label="흑자 SKU (margin > 0)" value={profitable} highlight={profitable > 0} />
        <Kpi label="중앙 margin %" value={Number.isFinite(medianMargin) ? `${(medianMargin * 100).toFixed(0)}%` : '-'} />
        <Kpi label="최대 margin %" value={Number.isFinite(maxMargin) ? `${(maxMargin * 100).toFixed(0)}%` : '-'} />
      </section>

      {error && (
        <div className="rounded border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800">
          RPC 에러: <code className="font-mono text-xs">{error}</code>
          <p className="text-xs mt-2 text-red-700">
            RPC <code>jimscanner_customs_anchor_margin</code> 또는 매핑 테이블 <code>jimscanner_manifest_to_ggsan_cate</code> 미적용 가능.
            <br />supabase/customs_anchor_margin.sql 을 적용하세요.
          </p>
        </div>
      )}

      {!error && rows.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500 space-y-2">
          <div className="text-base font-medium">매칭 데이터 없음</div>
          <div className="text-xs text-gray-400">
            manifest_items 가 비어있거나 카테고리 매핑이 부재할 수 있습니다.
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* 박스플롯 */}
          <section className="lg:col-span-2 rounded border border-gray-200 p-4">
            <h2 className="text-sm font-semibold text-gray-700 mb-3">
              카테고리별 margin % 분포 (P10–P50–P90)
            </h2>
            <div className="text-[10px] text-gray-400 mb-2 flex items-center gap-2">
              <span>← 손실</span>
              <div className="flex-1 h-2 rounded bg-gradient-to-r from-red-400 via-yellow-200 via-lime-300 to-emerald-600" />
              <span>이익 →</span>
            </div>
            <div className="space-y-0.5">
              {boxStats.map((b) => (
                <Boxplot key={b.cate_cd} stats={b} xMin={xMin} xMax={xMax} />
              ))}
            </div>
            <div className="text-[10px] text-gray-400 mt-3 leading-relaxed">
              x축: -50% (손실 한계) ~ +200% (3배 마진). 박스 = P10~P90 / 검정 막대 = P50.
              색상 = P50 마진 분위. zero line 왼쪽은 도매가&gt;직구가 (진입 불가).
            </div>
          </section>

          {/* Top 20 */}
          <section className="rounded border border-gray-200 p-4">
            <h2 className="text-sm font-semibold text-gray-700 mb-3">
              🏆 P50 앵커 대비 가장 깊이 들어가는 ggsan SKU Top 20
            </h2>
            <div className="space-y-2 max-h-[800px] overflow-y-auto">
              {top20.map((r, i) => {
                const pct = n(r.margin_pct)
                return (
                  <a
                    key={r.goods_no}
                    href={r.detail_url ?? '#'}
                    target="_blank"
                    rel="noopener"
                    className="block rounded border border-gray-200 hover:bg-gray-50 p-2"
                  >
                    <div className="flex items-start gap-2">
                      <div className="w-6 text-center text-xs font-mono text-gray-400 pt-1">{i + 1}</div>
                      <div className="w-12 h-12 bg-gray-100 rounded overflow-hidden flex-shrink-0">
                        {r.image_url && (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={r.image_url} alt="" loading="lazy" className="w-full h-full object-cover" />
                        )}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="text-xs font-medium leading-snug line-clamp-2" title={r.title}>
                          {r.title}
                        </div>
                        <div className="text-[10px] text-gray-500 mt-0.5">
                          {r.ggsan_cate_label} · n={r.manifest_sample_n}
                        </div>
                        <div className="text-[10px] font-mono text-gray-600 mt-0.5">
                          도매 {fmtKrw(r.ggsan_price_krw)} / P50 {fmtKrw(r.manifest_p50_krw)}
                        </div>
                      </div>
                      <div className="text-right flex-shrink-0">
                        <div className={`text-xs font-bold px-2 py-0.5 rounded ${marginColor(pct)}`}>
                          {fmtPct(pct)}
                        </div>
                        <div className="text-[10px] text-gray-500 font-mono mt-1">
                          {fmtKrw(r.margin_krw, { signed: true })}
                        </div>
                      </div>
                    </div>
                  </a>
                )
              })}
              {top20.length === 0 && (
                <div className="text-xs text-gray-400 text-center py-6">마진 계산 가능한 SKU 없음</div>
              )}
            </div>
          </section>
        </div>
      )}

      <section className="text-xs text-gray-500 border-t border-gray-200 pt-4 space-y-1">
        <div className="font-semibold text-gray-700">📐 마진 공식</div>
        <code className="block bg-gray-50 px-3 py-2 rounded font-mono text-[11px] leading-relaxed">
          margin_krw = manifest_P50_KRW − ggsan_price_krw − volumetric_cost_krw
          <br />
          manifest_P50_KRW = percentile_cont(0.5) of (manifest.unit_value_usd × USD→KRW)
          <br />
          volumetric_cost_krw = median(invoice_volumetric_weight_kg) × 10,000원/kg
          <br />
          margin_pct = margin_krw / ggsan_price_krw
        </code>
        <div className="pt-2">
          <strong>매핑:</strong> jimscanner_manifest_to_ggsan_cate (ggsan.cate_cd ↔ manifest.category_tag).
          현재 ggsan 카탈로그는 건기식·식품이라 NUTRITIONAL PRODUCTS / FOODS 두 태그에 집중. 의류·전자제품 확장 시 매핑 추가 필요.
        </div>
      </section>
    </div>
  )
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
