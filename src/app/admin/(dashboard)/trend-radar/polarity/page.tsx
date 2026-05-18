import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

interface PolarityRow {
  product_id: string
  day: string
  pos_count: number
  neu_count: number
  neg_count: number
  mix_count: number
  total_count: number
  sources: string[] | null
  pos_ratio: number
  neg_ratio: number
  neu_ratio: number
  mix_ratio: number
  total_7d: number
  neg_ratio_7d: number
  quality_momentum: number
}

interface ProductMeta {
  id: string
  canonical_name: string
  brand: string | null
  category_top: string
  category_mid: string | null
}

const DAYS_OPTIONS = [7, 14, 30] as const

async function fetchPolarity(days: number): Promise<{
  rows: PolarityRow[]
  meta: Map<string, ProductMeta>
  error: string | null
  hasMV: boolean
}> {
  const sb = createAdminClient()
  const since = new Date(Date.now() - days * 86400 * 1000).toISOString().slice(0, 10)

  // 머터리얼라이즈드뷰는 generated 타입에 없음 — `as never` 캐스팅.
  const { data, error } = await sb
    .from('jimscanner_trends_polarity_daily' as never)
    .select('*')
    .gte('day', since)
    .order('day', { ascending: false })
    .limit(2000)

  if (error) {
    return { rows: [], meta: new Map(), error: error.message, hasMV: false }
  }

  const rows = ((data ?? []) as unknown as PolarityRow[]) || []
  const productIds = [...new Set(rows.map((r) => r.product_id))]
  let meta = new Map<string, ProductMeta>()
  if (productIds.length > 0) {
    const { data: prods } = await sb
      .from('jimscanner_trends_products')
      .select('id, canonical_name, brand, category_top, category_mid')
      .in('id', productIds)
    for (const p of (prods ?? []) as ProductMeta[]) meta.set(p.id, p)
  }
  return { rows, meta, error: null, hasMV: true }
}

interface AggBucket {
  product_id: string
  total: number
  pos: number
  neu: number
  neg: number
  mix: number
  qmSum: number
  days: number
  sources: Set<string>
  recentNegRatio: number  // 최신 day 기준
  prevNegRatio: number    // 그 전 day 기준
}

function aggregate(rows: PolarityRow[]): {
  byProduct: AggBucket[]
  trapRows: AggBucket[]
} {
  const map = new Map<string, AggBucket>()
  // day 순으로 그룹핑 (이미 desc 정렬되어 있음)
  for (const r of rows) {
    let b = map.get(r.product_id)
    if (!b) {
      b = {
        product_id: r.product_id,
        total: 0,
        pos: 0,
        neu: 0,
        neg: 0,
        mix: 0,
        qmSum: 0,
        days: 0,
        sources: new Set(),
        recentNegRatio: 0,
        prevNegRatio: 0,
      }
      map.set(r.product_id, b)
    }
    b.total += r.total_count
    b.pos += r.pos_count
    b.neu += r.neu_count
    b.neg += r.neg_count
    b.mix += r.mix_count
    b.qmSum += Number(r.quality_momentum) || 0
    b.days++
    for (const s of r.sources ?? []) b.sources.add(s)
  }

  // recent vs prev neg_ratio: per product 최신 2 days 비교
  const byProductDays = new Map<string, PolarityRow[]>()
  for (const r of rows) {
    const arr = byProductDays.get(r.product_id) ?? []
    arr.push(r)
    byProductDays.set(r.product_id, arr)
  }
  for (const [pid, arr] of byProductDays) {
    arr.sort((a, b) => b.day.localeCompare(a.day))
    const b = map.get(pid)
    if (!b) continue
    b.recentNegRatio = Number(arr[0]?.neg_ratio) || 0
    b.prevNegRatio = Number(arr[1]?.neg_ratio) || 0
  }

  const byProduct = [...map.values()].sort((a, b) => b.qmSum - a.qmSum)

  // 함정 트렌드: 부정 비율 ≥ 0.4 이고 멘션 ≥ 5
  const trapRows = byProduct
    .filter((b) => b.total >= 5 && b.neg / Math.max(1, b.total) >= 0.4)
    .sort((a, b) => b.total - a.total)

  return { byProduct, trapRows }
}

function ratio(part: number, whole: number): string {
  if (whole === 0) return '0%'
  return `${Math.round((part / whole) * 100)}%`
}

function categoryLabel(top: string | undefined): string {
  switch (top) {
    case 'health':
      return '건강'
    case 'living':
      return '생활'
    case 'digital':
      return '디지털'
    default:
      return top ?? '기타'
  }
}

export default async function PolarityPage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string }>
}) {
  const sp = await searchParams
  const reqDays = parseInt(sp.days ?? '7', 10)
  const days = (DAYS_OPTIONS as readonly number[]).includes(reqDays) ? reqDays : 7

  const { rows, meta, error, hasMV } = await fetchPolarity(days)
  const { byProduct, trapRows } = aggregate(rows)

  // KPI
  const totalMentions = byProduct.reduce((s, b) => s + b.total, 0)
  const totalPos = byProduct.reduce((s, b) => s + b.pos, 0)
  const totalNeg = byProduct.reduce((s, b) => s + b.neg, 0)
  const trapCount = trapRows.length

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold">🎭 감성 극성 게이트</h1>
          <p className="text-sm text-gray-500 mt-1">
            forum / news / blog raw 의 LLM 감성 분류 누적 — 호평/혹평 균형 모멘텀 보드
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      {/* 기간 필터 */}
      <div className="rounded border border-gray-200 px-4 py-3 flex items-center gap-3">
        <span className="text-xs text-gray-500">기간</span>
        {DAYS_OPTIONS.map((d) => (
          <Link
            key={d}
            href={`/admin/trend-radar/polarity?days=${d}`}
            className={`px-2 py-1 text-xs rounded ${days === d ? 'bg-emerald-100 text-emerald-700 font-semibold' : 'text-gray-500 hover:text-black'}`}
          >
            {d}일
          </Link>
        ))}
        <span className="ml-auto text-xs text-gray-400">
          quality_momentum = mention_velocity × (pos_ratio − 0.8·neg_ratio)
        </span>
      </div>

      {!hasMV || error ? (
        <div className="rounded border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <strong>머터리얼라이즈드뷰 미적용</strong>
          <p className="mt-1 text-xs">
            supabase/trends_v4_sentiment.sql 적용이 필요합니다. 분류 cron 이 돌기 전까지는 빈 화면이
            정상입니다.
          </p>
          {error && (
            <p className="mt-2 text-xs font-mono break-all">{error}</p>
          )}
        </div>
      ) : null}

      {/* KPI */}
      <section className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Kpi label="누적 멘션" value={totalMentions} />
        <Kpi label="🟢 호평" value={totalPos} />
        <Kpi label="🔴 혹평" value={totalNeg} />
        <Kpi label="⚠️ 함정 트렌드" value={trapCount} highlight={trapCount > 0} />
      </section>

      {/* 함정 트렌드 — 부정 비율 급등인데 멘션 급등 */}
      {trapRows.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold text-red-700">
            ⚠️ 함정 트렌드 ({trapRows.length}건) — 멘션 급등 + 부정 비율 ≥ 40%
          </h2>
          <div className="space-y-2">
            {trapRows.slice(0, 10).map((b) => {
              const m = meta.get(b.product_id)
              const dd = b.recentNegRatio - b.prevNegRatio
              return (
                <div
                  key={b.product_id}
                  className="rounded border border-red-300 bg-red-50 px-4 py-3"
                >
                  <div className="flex items-baseline justify-between gap-3">
                    <div className="font-medium text-red-900">
                      {m?.canonical_name ?? b.product_id.slice(0, 8)}
                      <span className="text-xs text-red-600 ml-2">
                        {m?.brand ?? '브랜드?'} · {categoryLabel(m?.category_top)}
                      </span>
                    </div>
                    <div className="text-xs text-red-700 font-mono">
                      멘션 {b.total} · 혹평 {ratio(b.neg, b.total)}
                      {dd !== 0 && (
                        <span className="ml-2">
                          (D-D {dd > 0 ? '+' : ''}
                          {(dd * 100).toFixed(0)}%)
                        </span>
                      )}
                    </div>
                  </div>
                  <PolarityBar
                    pos={b.pos}
                    neu={b.neu}
                    neg={b.neg}
                    mix={b.mix}
                    total={b.total}
                  />
                </div>
              )
            })}
          </div>
        </section>
      )}

      {/* 모멘텀 보드 */}
      <section className="space-y-2">
        <h2 className="text-sm font-semibold text-gray-700">
          📊 quality_momentum 보드 (상위 {Math.min(byProduct.length, 30)})
        </h2>
        {byProduct.length === 0 ? (
          <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500 text-sm">
            아직 분류된 감성 데이터가 없습니다. cron 이 돈 뒤 채워집니다.
          </div>
        ) : (
          <div className="space-y-2">
            {byProduct.slice(0, 30).map((b, i) => {
              const m = meta.get(b.product_id)
              return (
                <div key={b.product_id} className="rounded border border-gray-200 px-4 py-3">
                  <div className="flex items-baseline justify-between gap-3">
                    <div className="flex items-baseline gap-3">
                      <span className="text-xs text-gray-400 font-mono w-6">{i + 1}</span>
                      <div>
                        <div className="font-medium">
                          {m?.canonical_name ?? b.product_id.slice(0, 8)}
                        </div>
                        <div className="text-xs text-gray-500">
                          {m?.brand ?? '브랜드?'} · {categoryLabel(m?.category_top)} ·{' '}
                          {[...b.sources].slice(0, 4).join(', ')}
                        </div>
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="text-2xl font-bold font-mono text-emerald-700">
                        {b.qmSum.toFixed(2)}
                      </div>
                      <div className="text-[10px] text-gray-500 font-mono">
                        멘션 {b.total} · {b.days}일
                      </div>
                    </div>
                  </div>
                  <PolarityBar
                    pos={b.pos}
                    neu={b.neu}
                    neg={b.neg}
                    mix={b.mix}
                    total={b.total}
                  />
                </div>
              )
            })}
          </div>
        )}
      </section>

      <section className="text-xs text-gray-500 border-t border-gray-200 pt-4 space-y-1">
        <div className="font-semibold text-gray-700">📐 공식</div>
        <code className="block bg-gray-50 px-3 py-2 rounded font-mono text-[11px] leading-relaxed">
          quality_momentum = mention_velocity × (pos_ratio − 0.8 · neg_ratio)
          <br />
          mention_velocity = day_total / (7d_total / 7)
          <br />
          함정 트렌드 게이트 = total ≥ 5 AND neg_ratio ≥ 0.4
        </code>
        <div className="pt-2">
          forum (82cook · ppomppu · dcinside · natepan · clien · quasarzone) + news/blog (daum_news ·
          naver_news · naver_blog) raw 를 LLM 1패스로 분류. 동일 raw 를 추천 점수의 polarity_gate 가중치로
          재사용.
        </div>
      </section>
    </div>
  )
}

function PolarityBar({
  pos,
  neu,
  neg,
  mix,
  total,
}: {
  pos: number
  neu: number
  neg: number
  mix: number
  total: number
}) {
  if (total === 0) return null
  const p = (pos / total) * 100
  const n = (neu / total) * 100
  const g = (neg / total) * 100
  const m = (mix / total) * 100
  return (
    <div className="mt-2 flex h-3 w-full overflow-hidden rounded bg-gray-100 text-[10px] text-white font-mono">
      {p > 0 && (
        <div
          className="bg-emerald-500 flex items-center justify-center"
          style={{ width: `${p}%` }}
          title={`호평 ${pos}`}
        >
          {p >= 10 ? `${Math.round(p)}` : ''}
        </div>
      )}
      {n > 0 && (
        <div
          className="bg-gray-400 flex items-center justify-center"
          style={{ width: `${n}%` }}
          title={`중립 ${neu}`}
        >
          {n >= 10 ? `${Math.round(n)}` : ''}
        </div>
      )}
      {m > 0 && (
        <div
          className="bg-amber-400 flex items-center justify-center"
          style={{ width: `${m}%` }}
          title={`혼합 ${mix}`}
        >
          {m >= 10 ? `${Math.round(m)}` : ''}
        </div>
      )}
      {g > 0 && (
        <div
          className="bg-red-500 flex items-center justify-center"
          style={{ width: `${g}%` }}
          title={`혹평 ${neg}`}
        >
          {g >= 10 ? `${Math.round(g)}` : ''}
        </div>
      )}
    </div>
  )
}

function Kpi({
  label,
  value,
  highlight = false,
}: {
  label: string
  value: number | string
  highlight?: boolean
}) {
  return (
    <div className={`rounded border p-3 ${highlight ? 'border-red-300 bg-red-50' : 'border-gray-200'}`}>
      <div className="text-xs text-gray-500">{label}</div>
      <div className={`text-2xl font-bold mt-1 ${highlight ? 'text-red-700' : ''}`}>
        {typeof value === 'number' ? value.toLocaleString() : value}
      </div>
    </div>
  )
}
