import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

type ScoreKind = 'final' | 'trend' | 'commerce' | 'supplier' | 'competition'
type Quadrant = 'accel_up' | 'decel_up' | 'accel_down' | 'decel_down' | 'flat'

interface InflectionRow {
  product_id: string
  score_kind: ScoreKind
  latest_score: number
  slope_7d: number
  accel_7d: number
  sample_count: number
  quadrant: Quadrant
  rank_score: number
  computed_at: string
}

interface ProductRow {
  id: string
  canonical_name: string
  category_top: string
}

const SCORE_KINDS: ScoreKind[] = ['final', 'trend', 'commerce', 'supplier', 'competition']
const SUB_KINDS: ScoreKind[] = ['trend', 'commerce', 'supplier', 'competition']

const QUADRANT_META: Record<
  Quadrant,
  { title: string; subtitle: string; accent: string; border: string; text: string }
> = {
  accel_up: {
    title: '🚀 가속·상승',
    subtitle: '즉시 진입 큐 — 가장 일찍 잡히는 entry 시그널',
    accent: 'bg-emerald-50',
    border: 'border-emerald-300',
    text: 'text-emerald-800',
  },
  decel_up: {
    title: '⚠️ 감속·상승',
    subtitle: '정점 임박 — final 50+ 라도 진입 지각 위험',
    accent: 'bg-amber-50',
    border: 'border-amber-300',
    text: 'text-amber-800',
  },
  accel_down: {
    title: '🔻 가속·하락',
    subtitle: '손절 구간 — 보유 중이면 정리',
    accent: 'bg-rose-50',
    border: 'border-rose-300',
    text: 'text-rose-800',
  },
  decel_down: {
    title: '🌱 감속·하락',
    subtitle: '반등 후보 — 바닥 다지기',
    accent: 'bg-sky-50',
    border: 'border-sky-300',
    text: 'text-sky-800',
  },
  flat: {
    title: '➖ 정체',
    subtitle: '시그널 없음',
    accent: 'bg-gray-50',
    border: 'border-gray-200',
    text: 'text-gray-700',
  },
}

async function fetchInflection(kind: ScoreKind) {
  const sb = createAdminClient()

  // 해당 score_kind 의 inflection row 만 가져온 후 product 정보 join
  const { data: infRows } = await sb
    .from('jimscanner_trends_inflection' as never)
    .select(
      'product_id, score_kind, latest_score, slope_7d, accel_7d, sample_count, quadrant, rank_score, computed_at',
    )
    .order('rank_score', { ascending: false })
    .limit(2000)

  const rows = ((infRows ?? []) as unknown as InflectionRow[]) ?? []

  // 모든 sub-kind row 도 함께 (mini 사분면 dot 용)
  const productIds = Array.from(new Set(rows.map((r) => r.product_id)))
  if (productIds.length === 0) {
    return { primary: [] as InflectionRow[], subByProduct: new Map<string, Record<ScoreKind, InflectionRow | undefined>>(), products: new Map<string, ProductRow>() }
  }

  const { data: prods } = await sb
    .from('jimscanner_trends_products')
    .select('id, canonical_name, category_top')
    .in('id', productIds)

  const products = new Map<string, ProductRow>(
    ((prods ?? []) as ProductRow[]).map((p) => [p.id, p]),
  )

  const subByProduct = new Map<string, Record<ScoreKind, InflectionRow | undefined>>()
  for (const r of rows) {
    let bucket = subByProduct.get(r.product_id)
    if (!bucket) {
      bucket = {} as Record<ScoreKind, InflectionRow | undefined>
      subByProduct.set(r.product_id, bucket)
    }
    bucket[r.score_kind] = r
  }

  const primary = rows.filter((r) => r.score_kind === kind)
  return { primary, subByProduct, products }
}

export default async function InflectionPage({
  searchParams,
}: {
  searchParams: Promise<{ kind?: string }>
}) {
  const sp = await searchParams
  const kind: ScoreKind = (SCORE_KINDS.includes(sp.kind as ScoreKind)
    ? sp.kind
    : 'final') as ScoreKind

  const { primary, subByProduct, products } = await fetchInflection(kind)

  const grouped: Record<Quadrant, InflectionRow[]> = {
    accel_up: [],
    decel_up: [],
    accel_down: [],
    decel_down: [],
    flat: [],
  }
  for (const r of primary) grouped[r.quadrant].push(r)
  for (const q of Object.keys(grouped) as Quadrant[]) {
    grouped[q].sort((a, b) => b.rank_score - a.rank_score)
  }

  const totalSignal = primary.length - grouped.flat.length

  return (
    <div className="space-y-6 p-6">
      <header>
        <Link href="/admin/trend-radar" className="text-sm text-gray-500 hover:text-black">
          ← 대시보드
        </Link>
        <h1 className="text-2xl font-bold mt-1">🔺 변곡점 4사분면</h1>
        <p className="text-sm text-gray-500 mt-1">
          score 시계열 1차(slope)·2차(accel) 미분 — &lsquo;rising&rsquo; 과
          &lsquo;accelerating-into-rising&rsquo; 분리, 정점 임박 진입 지각 차단.
        </p>
      </header>

      {/* score_kind 탭 */}
      <nav className="flex gap-2 border-b border-gray-200">
        {SCORE_KINDS.map((k) => (
          <Link
            key={k}
            href={`/admin/trend-radar/inflection?kind=${k}`}
            className={`px-3 py-2 text-sm capitalize ${
              kind === k
                ? 'border-b-2 border-black font-semibold text-black'
                : 'text-gray-500 hover:text-black'
            }`}
          >
            {k}
          </Link>
        ))}
      </nav>

      <div className="text-xs text-gray-500">
        기준 score_kind = <span className="font-mono font-semibold">{kind}</span> · 시그널{' '}
        {totalSignal}건 / 전체 {primary.length}건 (flat {grouped.flat.length}건 제외)
      </div>

      {/* 2x2 사분면 그리드 */}
      <section className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <QuadrantPanel
          q="accel_up"
          rows={grouped.accel_up}
          subByProduct={subByProduct}
          products={products}
        />
        <QuadrantPanel
          q="decel_up"
          rows={grouped.decel_up}
          subByProduct={subByProduct}
          products={products}
        />
        <QuadrantPanel
          q="decel_down"
          rows={grouped.decel_down}
          subByProduct={subByProduct}
          products={products}
        />
        <QuadrantPanel
          q="accel_down"
          rows={grouped.accel_down}
          subByProduct={subByProduct}
          products={products}
        />
      </section>

      {primary.length === 0 && <EmptyState />}

      <footer className="text-xs text-gray-400">
        cron <code className="px-1 bg-gray-100 rounded">scripts/compute-trend-inflection.mjs</code>{' '}
        실행 후 갱신 · 정렬 = |slope| × |accel|
      </footer>
    </div>
  )
}

function QuadrantPanel({
  q,
  rows,
  subByProduct,
  products,
}: {
  q: Quadrant
  rows: InflectionRow[]
  subByProduct: Map<string, Record<ScoreKind, InflectionRow | undefined>>
  products: Map<string, ProductRow>
}) {
  const meta = QUADRANT_META[q]
  return (
    <div className={`rounded border ${meta.border} ${meta.accent}`}>
      <div className={`px-4 py-3 border-b ${meta.border}`}>
        <div className={`text-sm font-semibold ${meta.text}`}>{meta.title}</div>
        <div className="text-xs text-gray-600">{meta.subtitle}</div>
        <div className="text-xs text-gray-500 mt-1">{rows.length}건</div>
      </div>
      <div className="divide-y divide-white/60">
        {rows.slice(0, 12).map((r) => {
          const p = products.get(r.product_id)
          const bucket = subByProduct.get(r.product_id)
          return (
            <Link
              key={`${r.product_id}-${r.score_kind}`}
              href={`/admin/trend-radar/products/${r.product_id}?tab=trajectory`}
              className="block px-4 py-2 hover:bg-white/70"
            >
              <div className="flex items-baseline justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium truncate">
                    {p?.canonical_name ?? r.product_id.slice(0, 8)}
                  </div>
                  <div className="text-xs text-gray-500">
                    {p?.category_top ?? '?'} · score {r.latest_score}
                  </div>
                </div>
                <div className="text-right text-xs font-mono whitespace-nowrap">
                  <div>
                    slope <span className="font-semibold">{fmt(r.slope_7d)}</span>
                  </div>
                  <div>
                    accel <span className="font-semibold">{fmt(r.accel_7d)}</span>
                  </div>
                </div>
              </div>
              {/* sub-score mini 4사분면 dot — 4개 점 */}
              <div className="mt-2 flex items-center gap-2">
                <span className="text-[10px] text-gray-500">sub</span>
                <MiniQuadrant bucket={bucket} />
              </div>
            </Link>
          )
        })}
        {rows.length === 0 && (
          <div className="px-4 py-6 text-center text-xs text-gray-400">—</div>
        )}
        {rows.length > 12 && (
          <div className="px-4 py-2 text-center text-xs text-gray-500">
            +{rows.length - 12} 더 보기
          </div>
        )}
      </div>
    </div>
  )
}

function MiniQuadrant({
  bucket,
}: {
  bucket: Record<ScoreKind, InflectionRow | undefined> | undefined
}) {
  // 4개 sub-score (trend / commerce / supplier / competition) 의 (slope, accel)
  // 을 한 작은 2x2 박스 안에 dot 으로 표시.
  const items = SUB_KINDS.map((k) => ({
    kind: k,
    row: bucket?.[k],
  }))
  // 슬로프/가속 정규화 — 시각화 용. 최대 절대값으로 스케일.
  const maxSlope = Math.max(0.1, ...items.map((i) => Math.abs(i.row?.slope_7d ?? 0)))
  const maxAccel = Math.max(0.1, ...items.map((i) => Math.abs(i.row?.accel_7d ?? 0)))
  const size = 48
  const half = size / 2
  return (
    <div className="relative" style={{ width: size, height: size }}>
      <div className="absolute inset-0 border border-gray-300 rounded-sm bg-white/80" />
      <div className="absolute left-0 right-0 top-1/2 border-t border-gray-200" />
      <div className="absolute top-0 bottom-0 left-1/2 border-l border-gray-200" />
      {items.map(({ kind, row }) => {
        if (!row) return null
        const x = half + (row.slope_7d / maxSlope) * (half - 4)
        const y = half - (row.accel_7d / maxAccel) * (half - 4)
        const color = subColor(kind)
        return (
          <span
            key={kind}
            title={`${kind}: slope ${fmt(row.slope_7d)} / accel ${fmt(row.accel_7d)}`}
            className={`absolute rounded-full ${color}`}
            style={{
              width: 6,
              height: 6,
              left: x - 3,
              top: y - 3,
            }}
          />
        )
      })}
    </div>
  )
}

function subColor(kind: ScoreKind) {
  switch (kind) {
    case 'trend':
      return 'bg-emerald-500'
    case 'commerce':
      return 'bg-blue-500'
    case 'supplier':
      return 'bg-purple-500'
    case 'competition':
      return 'bg-rose-500'
    default:
      return 'bg-gray-500'
  }
}

function fmt(n: number) {
  if (!Number.isFinite(n)) return '—'
  const abs = Math.abs(n)
  const s = abs >= 10 ? n.toFixed(1) : abs >= 1 ? n.toFixed(2) : n.toFixed(3)
  return n > 0 ? `+${s}` : s
}

function EmptyState() {
  return (
    <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500">
      <p className="text-base font-medium">아직 변곡점 데이터가 없습니다</p>
      <p className="text-sm mt-2">
        <code className="px-1 bg-gray-100 rounded">
          node --env-file=.env.local scripts/compute-trend-inflection.mjs
        </code>{' '}
        실행 후 갱신됩니다.
        <br />
        (run-crons.mjs 가 매 cron 사이클 마지막에 자동 실행)
      </p>
    </div>
  )
}
