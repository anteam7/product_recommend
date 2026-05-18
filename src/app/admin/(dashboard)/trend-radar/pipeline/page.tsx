import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import PipelineBoard from './PipelineBoard'
import type { Stage } from './actions'

export const dynamic = 'force-dynamic'

const STAGE_ORDER: Stage[] = ['discovery', 'sourcing', 'listing', 'live', 'profitable', 'rejected']

// 단계별 SLA (일). 초과 시 빨간 배지.
const STAGE_SLA_DAYS: Record<Stage, number> = {
  discovery: 7,
  sourcing: 14,
  listing: 7,
  live: 30,
  profitable: 999,
  rejected: 999,
}

interface StageRow {
  product_id: string
  stage: Stage
  entered_at: string
  owner_email: string | null
  notes: string | null
}
interface ScoreRow {
  product_id: string
  final_score: number
  computed_at: string
}
interface ProductRow {
  id: string
  canonical_name: string
  category_top: string
}

export interface PipelineCard {
  productId: string
  canonicalName: string
  categoryTop: string
  stage: Stage
  enteredAt: string
  dwellDays: number
  ownerEmail: string | null
  notes: string | null
  scoreHistory: number[]   // 최근 14일 final_score sparkline
  latestScore: number | null
  slaBreached: boolean
}

async function fetchData() {
  // generated 타입에 없음 → 캐스팅
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sb = createAdminClient() as any

  const [stagesRes, scoresRes] = await Promise.all([
    sb.from('jimscanner_trends_pipeline_stages')
      .select('product_id, stage, entered_at, owner_email, notes')
      .order('entered_at', { ascending: true }),
    sb.from('jimscanner_trends_scores')
      .select('product_id, final_score, computed_at')
      .gte('computed_at', new Date(Date.now() - 14 * 86400_000).toISOString())
      .order('computed_at', { ascending: true })
      .limit(5000),
  ])
  const stages = (stagesRes.data ?? []) as StageRow[]
  const scores = (scoresRes.data ?? []) as ScoreRow[]

  const ids = [...new Set(stages.map((s) => s.product_id))]
  let products: ProductRow[] = []
  if (ids.length > 0) {
    const { data } = await sb
      .from('jimscanner_trends_products')
      .select('id, canonical_name, category_top')
      .in('id', ids)
    products = (data ?? []) as ProductRow[]
  }
  const byId = new Map(products.map((p) => [p.id, p]))

  const scoresByProd = new Map<string, number[]>()
  for (const s of scores) {
    const arr = scoresByProd.get(s.product_id) ?? []
    arr.push(Number(s.final_score) || 0)
    scoresByProd.set(s.product_id, arr)
  }

  const now = Date.now()
  const cards: PipelineCard[] = stages.map((st) => {
    const dwellDays = (now - new Date(st.entered_at).getTime()) / 86400_000
    const history = scoresByProd.get(st.product_id) ?? []
    const prod = byId.get(st.product_id)
    return {
      productId: st.product_id,
      canonicalName: prod?.canonical_name ?? '(이름 없음)',
      categoryTop: prod?.category_top ?? '?',
      stage: st.stage,
      enteredAt: st.entered_at,
      dwellDays,
      ownerEmail: st.owner_email,
      notes: st.notes,
      scoreHistory: history.slice(-14),
      latestScore: history.length > 0 ? history[history.length - 1] : null,
      slaBreached: dwellDays > STAGE_SLA_DAYS[st.stage],
    }
  })

  // KPI: 단계별 평균 체류일 · 카드 수 · 정체(SLA 초과) 수
  const kpis = STAGE_ORDER.map((stage) => {
    const inStage = cards.filter((c) => c.stage === stage)
    const avgDwell = inStage.length > 0
      ? inStage.reduce((sum, c) => sum + c.dwellDays, 0) / inStage.length
      : 0
    const stuck = inStage.filter((c) => c.slaBreached).length
    return { stage, count: inStage.length, avgDwell, stuck, sla: STAGE_SLA_DAYS[stage] }
  })

  // 전환율: 직전 30일 stage_transitions 에서 to_stage 별 카운트
  const since = new Date(now - 30 * 86400_000).toISOString()
  const { data: txData } = await sb
    .from('jimscanner_trends_stage_transitions')
    .select('to_stage')
    .gte('transitioned_at', since)
  const txCounts = new Map<Stage, number>()
  for (const t of (txData ?? []) as { to_stage: Stage }[]) {
    txCounts.set(t.to_stage, (txCounts.get(t.to_stage) ?? 0) + 1)
  }

  return { cards, kpis, txCounts: Object.fromEntries(txCounts) as Record<Stage, number> }
}

export default async function PipelinePage() {
  const { cards, kpis, txCounts } = await fetchData()

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold">발굴 → 수익화 파이프라인</h1>
          <p className="text-sm text-gray-500 mt-1">
            5단계 칸반으로 운영자 워크플로 진척을 추적. 카드를 드래그해서 단계 전환.
            <br />
            정체 카드 (SLA 초과) 는 빨간 배지. 단계별 평균 체류일·전환 수는 상단 KPI 참고.
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      <section className="grid grid-cols-2 md:grid-cols-6 gap-2">
        {kpis.map((k) => (
          <div
            key={k.stage}
            className={`rounded border p-3 ${
              k.stuck > 0 ? 'border-red-400 bg-red-50' : 'border-gray-200 bg-white'
            }`}
          >
            <div className="text-xs text-gray-500 uppercase">{stageLabel(k.stage)}</div>
            <div className="text-2xl font-bold mt-1">{k.count}</div>
            <div className="text-[11px] text-gray-500 mt-1">
              평균 체류 {k.avgDwell.toFixed(1)}d
              {k.sla < 999 && <> / SLA {k.sla}d</>}
            </div>
            <div className="text-[11px] mt-1">
              <span className={k.stuck > 0 ? 'text-red-600 font-semibold' : 'text-gray-400'}>
                정체 {k.stuck}
              </span>
              {' · '}
              <span className="text-gray-500">유입 30d {txCounts[k.stage] ?? 0}</span>
            </div>
          </div>
        ))}
      </section>

      <PipelineBoard cards={cards} stages={STAGE_ORDER} />
    </div>
  )
}

function stageLabel(s: Stage) {
  return {
    discovery: '발굴',
    sourcing: '소싱',
    listing: '리스팅',
    live: '판매중',
    profitable: '수익화',
    rejected: '반려',
  }[s]
}
