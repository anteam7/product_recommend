import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import {
  playbookFor,
  nextStageEtaDays,
  stageLabel,
  type LifecycleStage,
} from '@/scoring/lifecycle'

export const dynamic = 'force-dynamic'

interface ProductRow {
  id: string
  canonical_name: string
  category_top: string
  alias_count: number
  lifecycle_stage: LifecycleStage | null
  lifecycle_velocity: number | null
  lifecycle_evidence: Record<string, unknown> | null
  lifecycle_stage_entered_at: string | null
  lifecycle_computed_at: string | null
}

const STAGES: LifecycleStage[] = [
  'introduction',
  'growth',
  'maturity',
  'decline',
  'extinct',
]

const STAGE_COLORS: Record<LifecycleStage, { bg: string; border: string; chip: string }> = {
  introduction: { bg: 'bg-sky-50', border: 'border-sky-200', chip: 'bg-sky-100 text-sky-800' },
  growth:       { bg: 'bg-emerald-50', border: 'border-emerald-200', chip: 'bg-emerald-100 text-emerald-800' },
  maturity:     { bg: 'bg-amber-50', border: 'border-amber-200', chip: 'bg-amber-100 text-amber-800' },
  decline:      { bg: 'bg-orange-50', border: 'border-orange-200', chip: 'bg-orange-100 text-orange-800' },
  extinct:      { bg: 'bg-gray-100', border: 'border-gray-300', chip: 'bg-gray-200 text-gray-700' },
}

async function fetchProducts() {
  const sb = createAdminClient()
  const { data } = await (sb as any)
    .from('jimscanner_trends_products')
    .select(
      'id, canonical_name, category_top, alias_count, lifecycle_stage, lifecycle_velocity, lifecycle_evidence, lifecycle_stage_entered_at, lifecycle_computed_at',
    )
    .not('lifecycle_stage', 'is', null)
    .order('lifecycle_computed_at', { ascending: false })
    .limit(500)
  return (data ?? []) as ProductRow[]
}

function daysSince(iso: string | null | undefined): number | null {
  if (!iso) return null
  const ms = Date.now() - new Date(iso).getTime()
  return Math.max(0, Math.floor(ms / 86400_000))
}

function formatEvidenceChips(evidence: Record<string, unknown> | null): Array<{ k: string; v: string }> {
  if (!evidence) return []
  const candidates: Array<[string, string]> = [
    ['volume_slope', 'vol·slope'],
    ['volume_curvature', 'vol·curv'],
    ['review_slope', 'review'],
    ['seller_growth', 'sellers'],
    ['price_trend', 'price'],
    ['restock_freq', 'restock'],
  ]
  const out: Array<{ k: string; v: string }> = []
  for (const [key, label] of candidates) {
    const raw = (evidence as any)[key]
    if (typeof raw !== 'number') continue
    out.push({ k: label, v: formatNum(raw) })
    if (out.length >= 5) break
  }
  return out
}

function formatNum(n: number): string {
  if (!Number.isFinite(n)) return '—'
  const sign = n > 0 ? '+' : ''
  return `${sign}${n.toFixed(2)}`
}

export default async function LifecyclePage() {
  const products = await fetchProducts()

  const byStage = new Map<LifecycleStage, ProductRow[]>()
  for (const s of STAGES) byStage.set(s, [])
  for (const p of products) {
    if (p.lifecycle_stage && byStage.has(p.lifecycle_stage)) {
      byStage.get(p.lifecycle_stage)!.push(p)
    }
  }

  const lastComputed = products
    .map((p) => p.lifecycle_computed_at)
    .filter(Boolean)
    .sort()
    .pop()

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold">PLC 라이프사이클 보드</h1>
          <p className="text-sm text-gray-500 mt-1">
            상품을 도입 / 성장 / 성숙 / 쇠퇴 / 소멸 5단계로 분류 · 스테이지별 액션 플레이북
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      <section className="text-xs text-gray-500">
        최근 분류: {lastComputed ? new Date(lastComputed).toLocaleString('ko-KR') : '아직 없음'}
        {' · '}대상 상품 {products.length.toLocaleString()}건
      </section>

      {products.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500">
          <p className="text-base font-medium">아직 PLC 분류 결과가 없습니다</p>
          <p className="text-sm mt-2">
            매일 KST 06:00 recompute cron 의 마지막 단계로 분류가 갱신됩니다.
            <br />
            수동 트리거:{' '}
            <code className="px-1 bg-gray-100 rounded text-xs">
              GET /api/cron/recompute-lifecycle
            </code>
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-3">
          {STAGES.map((stage) => {
            const list = byStage.get(stage) ?? []
            const colors = STAGE_COLORS[stage]
            const playbook = playbookFor(stage)
            return (
              <div
                key={stage}
                className={`rounded border ${colors.border} ${colors.bg} flex flex-col min-h-[400px]`}
              >
                <div className="px-3 py-2 border-b border-gray-200/50">
                  <div className="flex items-baseline justify-between">
                    <h2 className="text-sm font-bold">{stageLabel(stage)}</h2>
                    <span className="text-xs text-gray-500">{list.length}</span>
                  </div>
                  <div className="text-[11px] text-gray-600 mt-0.5">{playbook.title}</div>
                </div>

                {/* 스테이지 플레이북 카드 */}
                <details className="px-3 py-2 border-b border-gray-200/50 text-xs">
                  <summary className="cursor-pointer text-gray-600 hover:text-black">
                    📘 플레이북 보기
                  </summary>
                  <ul className="mt-2 space-y-1 list-disc list-inside text-gray-700">
                    {playbook.actions.map((a, i) => (
                      <li key={i}>{a}</li>
                    ))}
                  </ul>
                </details>

                <div className="flex-1 overflow-y-auto px-2 py-2 space-y-2 max-h-[600px]">
                  {list.length === 0 ? (
                    <div className="text-xs text-gray-400 text-center py-6">비어있음</div>
                  ) : (
                    list.slice(0, 50).map((p) => {
                      const daysInStage = daysSince(p.lifecycle_stage_entered_at)
                      const eta = nextStageEtaDays(p.lifecycle_stage, p.lifecycle_velocity ?? 0)
                      const chips = formatEvidenceChips(p.lifecycle_evidence)
                      const velocity = p.lifecycle_velocity ?? 0
                      const velArrow = velocity > 0.05 ? '▲' : velocity < -0.05 ? '▼' : '·'
                      const velColor =
                        velocity > 0.05
                          ? 'text-emerald-700'
                          : velocity < -0.05
                            ? 'text-orange-700'
                            : 'text-gray-500'
                      return (
                        <Link
                          key={p.id}
                          href={`/admin/trend-radar/products/${p.id}`}
                          className="block bg-white rounded border border-gray-200 px-2.5 py-2 hover:shadow-sm transition-shadow"
                        >
                          <div className="flex items-baseline justify-between gap-2">
                            <div className="font-medium text-sm truncate">{p.canonical_name}</div>
                            <span className={`text-xs font-mono ${velColor}`}>
                              {velArrow} {formatNum(velocity)}
                            </span>
                          </div>
                          <div className="text-[11px] text-gray-500 mt-0.5">
                            {p.category_top} · alias {p.alias_count}
                          </div>
                          <div className="flex items-center gap-2 mt-1 text-[11px]">
                            <span className={`px-1.5 py-0.5 rounded ${colors.chip}`}>
                              {daysInStage !== null ? `${daysInStage}일차` : '—'}
                            </span>
                            <span className="text-gray-500">
                              ETA{' '}
                              {eta !== null ? (
                                <span className="font-mono">~{eta}d</span>
                              ) : (
                                <span className="text-gray-400">—</span>
                              )}
                            </span>
                          </div>
                          {chips.length > 0 && (
                            <div className="mt-1.5 flex flex-wrap gap-1">
                              {chips.map((c) => (
                                <span
                                  key={c.k}
                                  className="text-[10px] font-mono px-1 py-0.5 rounded bg-gray-100 text-gray-700"
                                  title={c.k}
                                >
                                  {c.k}:{c.v}
                                </span>
                              ))}
                            </div>
                          )}
                        </Link>
                      )
                    })
                  )}
                  {list.length > 50 && (
                    <div className="text-[11px] text-gray-400 text-center pt-1">
                      +{list.length - 50}건 더
                    </div>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
