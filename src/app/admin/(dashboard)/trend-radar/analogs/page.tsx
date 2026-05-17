import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

const LABELS = ['all', 'winner', 'sideways', 'decay', 'dead', 'unknown'] as const
type Label = (typeof LABELS)[number]

const LABEL_TEXT: Record<Label, string> = {
  all: '전체',
  winner: '✅ winner',
  sideways: '➖ sideways',
  decay: '📉 decay',
  dead: '💀 dead',
  unknown: '? unknown',
}

interface OutcomeRow {
  product_id: string
  peak_final: number
  days_to_peak: number
  post_peak_drawdown_pct: number
  outcome_label: Label
  history_days: number
  computed_at: string
}

interface ProductMini {
  id: string
  canonical_name: string
  category_top: string
  alias_count: number
}

async function fetchOutcomes(label: Label) {
  const sb = createAdminClient() as any
  let q = sb
    .from('jimscanner_trends_analog_outcomes')
    .select(
      'product_id, peak_final, days_to_peak, post_peak_drawdown_pct, outcome_label, history_days, computed_at',
    )
    .order('peak_final', { ascending: false })
    .limit(500)

  if (label !== 'all') q = q.eq('outcome_label', label)

  const { data: outcomes, error } = await q
  if (error || !outcomes || outcomes.length === 0) {
    return {
      rows: [] as Array<OutcomeRow & ProductMini>,
      counts: { all: 0, winner: 0, sideways: 0, decay: 0, dead: 0, unknown: 0 },
    }
  }

  const ids = (outcomes as OutcomeRow[]).map((o) => o.product_id)
  const { data: prods } = await sb
    .from('jimscanner_trends_products')
    .select('id, canonical_name, category_top, alias_count')
    .in('id', ids)

  const prodMap = new Map<string, ProductMini>(
    ((prods ?? []) as ProductMini[]).map((p) => [p.id, p]),
  )

  const rows = (outcomes as OutcomeRow[])
    .map((o) => {
      const p = prodMap.get(o.product_id)
      if (!p) return null
      return { ...o, ...p }
    })
    .filter((x): x is OutcomeRow & ProductMini => x !== null)

  const allCount =
    (
      await sb
        .from('jimscanner_trends_analog_outcomes')
        .select('*', { count: 'exact', head: true })
    ).count ?? 0
  async function countOf(l: Exclude<Label, 'all'>) {
    const { count } = await sb
      .from('jimscanner_trends_analog_outcomes')
      .select('*', { count: 'exact', head: true })
      .eq('outcome_label', l)
    return count ?? 0
  }
  const [winner, sideways, decay, dead, unknown] = await Promise.all([
    countOf('winner'),
    countOf('sideways'),
    countOf('decay'),
    countOf('dead'),
    countOf('unknown'),
  ])

  return {
    rows,
    counts: { all: allCount, winner, sideways, decay, dead, unknown },
  }
}

export default async function AnalogsArchivePage({
  searchParams,
}: {
  searchParams: Promise<{ label?: string }>
}) {
  const sp = await searchParams
  const label = (LABELS.includes(sp.label as Label) ? sp.label : 'all') as Label
  const { rows, counts } = await fetchOutcomes(label)

  return (
    <div className="space-y-6 p-6">
      <header>
        <h1 className="text-2xl font-bold">🪞 Analog 아카이브</h1>
        <p className="text-sm text-gray-500 mt-1">
          모든 canonical 상품의 누적 시계열을 보고 산출한 결말 라벨 라이브러리.
          개별 후보 상세 페이지에서 ‘유사 과거 케이스 5건’ 매칭의 origin.
        </p>
        <p className="text-[11px] text-gray-400 mt-1 font-mono">
          야간 재산출: <code>node --env-file=.env.local scripts/recompute-analog-outcomes.mjs</code>
        </p>
      </header>

      <nav className="flex gap-2 border-b border-gray-200 flex-wrap">
        {LABELS.map((l) => (
          <Link
            key={l}
            href={`/admin/trend-radar/analogs?label=${l}`}
            className={`px-3 py-2 text-sm ${
              label === l
                ? 'border-b-2 border-black font-semibold text-black'
                : 'text-gray-500 hover:text-black'
            }`}
          >
            {LABEL_TEXT[l]}{' '}
            <span className="text-xs text-gray-400 ml-1">
              ({counts[l].toLocaleString()})
            </span>
          </Link>
        ))}
      </nav>

      {rows.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500 text-sm">
          이 라벨에 해당하는 outcome 이 없습니다. cron 이 한 번도 안 돌았다면 위 명령으로 산출하세요.
        </div>
      ) : (
        <section>
          <div className="grid grid-cols-12 text-xs text-gray-500 px-3 py-1">
            <div className="col-span-1">#</div>
            <div className="col-span-5">상품명</div>
            <div className="col-span-1 text-right">peak</div>
            <div className="col-span-1 text-right">days→peak</div>
            <div className="col-span-1 text-right">drawdown</div>
            <div className="col-span-1 text-right">history</div>
            <div className="col-span-2 text-right">outcome</div>
          </div>
          <div className="rounded border border-gray-200 divide-y divide-gray-100">
            {rows.map((r, i) => (
              <Link
                key={r.product_id}
                href={`/admin/trend-radar/products/${r.product_id}`}
                className="grid grid-cols-12 px-3 py-2 text-sm hover:bg-gray-50"
              >
                <div className="col-span-1 font-mono text-gray-400">{i + 1}</div>
                <div className="col-span-5">
                  <div className="font-medium truncate">{r.canonical_name}</div>
                  <div className="text-xs text-gray-500">
                    {r.category_top} · alias {r.alias_count}
                  </div>
                </div>
                <div className="col-span-1 text-right font-mono font-bold">
                  {Math.round(Number(r.peak_final))}
                </div>
                <div className="col-span-1 text-right font-mono text-gray-600">
                  {r.days_to_peak}d
                </div>
                <div className="col-span-1 text-right font-mono text-gray-600">
                  -{Math.round(Number(r.post_peak_drawdown_pct))}%
                </div>
                <div className="col-span-1 text-right font-mono text-gray-500">
                  {r.history_days}d
                </div>
                <div className="col-span-2 text-right">
                  <OutcomeBadge label={r.outcome_label} />
                </div>
              </Link>
            ))}
          </div>
        </section>
      )}
    </div>
  )
}

const OUTCOME_STYLE: Record<string, { label: string; cls: string }> = {
  winner: { label: '✅ winner', cls: 'bg-green-100 text-green-700' },
  sideways: { label: '➖ sideways', cls: 'bg-gray-100 text-gray-700' },
  decay: { label: '📉 decay', cls: 'bg-amber-100 text-amber-700' },
  dead: { label: '💀 dead', cls: 'bg-red-100 text-red-700' },
  unknown: { label: '? unknown', cls: 'bg-gray-50 text-gray-400' },
}

function OutcomeBadge({ label }: { label: string }) {
  const s = OUTCOME_STYLE[label] ?? OUTCOME_STYLE.unknown
  return (
    <span className={`text-[10px] px-2 py-0.5 rounded font-medium ${s.cls}`}>
      {s.label}
    </span>
  )
}
