import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import { ARCHETYPES, archetypeMeta, durabilityColor, type Archetype } from './archetypes'

export const dynamic = 'force-dynamic'

const FILTERS = ['all', 'tv', 'news', 'community', 'search', 'season'] as const
type Filter = (typeof FILTERS)[number]

interface TriggerRow {
  product_id: string
  canonical_name: string
  category_top: string
  final_score: number
  trend_score: number
  tv_signal: number
  news_signal: number
  community_signal: number
  search_signal: number
  season_signal: number
  alias_count: number
  alias_sources: string[] | null
  trigger_archetype: string
  durability: number
  durability_label: string
  sourcing_posture: string
  top_evidence: string | null
}

async function fetchTriggers(): Promise<TriggerRow[]> {
  const sb = createAdminClient()
  // RPC 는 마이그레이션(supabase/trend_trigger_classify.sql) 후 존재. 타입 미생성 → as any.
  const { data, error } = await (sb as any).rpc('jimscanner_trend_trigger_classify', {
    days_window: 30,
    min_sim: 0.3,
    min_final_score: 0,
    result_limit: 300,
  })
  if (error) {
    console.error('[triggers] rpc error', error.message)
    return []
  }
  return (data ?? []) as TriggerRow[]
}

export default async function TriggersPage({
  searchParams,
}: {
  searchParams: Promise<{ a?: string }>
}) {
  const sp = await searchParams
  const filter = (FILTERS.includes(sp.a as Filter) ? sp.a : 'all') as Filter

  const all = await fetchTriggers()
  const rows = filter === 'all' ? all : all.filter((r) => r.trigger_archetype === filter)

  // 아키타입별 그룹 카운트
  const counts: Record<string, number> = {}
  for (const r of all) counts[r.trigger_archetype] = (counts[r.trigger_archetype] ?? 0) + 1

  // 아키타입별 그룹 카드용 묶음
  const grouped = (Object.keys(ARCHETYPES) as Archetype[]).map((key) => ({
    key,
    meta: ARCHETYPES[key],
    items: rows
      .filter((r) => r.trigger_archetype === key)
      .sort((a, b) => b.final_score - a.final_score),
  }))

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold">촉발원인 · 지속성 보드</h1>
          <p className="text-sm text-gray-500 mt-1">
            왜 뜨며 얼마나 갈까 — 근거 출처 믹스로 촉발 아키타입을 분류하고 소싱 포스처를 권장
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      {/* 아키타입 필터 */}
      <nav className="flex gap-2 border-b border-gray-200 flex-wrap">
        {FILTERS.map((f) => {
          const m = f === 'all' ? null : ARCHETYPES[f as Archetype]
          const label = f === 'all' ? `전체 (${all.length})` : `${m!.emoji} ${m!.label} (${counts[f] ?? 0})`
          return (
            <Link
              key={f}
              href={`/admin/trend-radar/triggers?a=${f}`}
              className={`px-3 py-2 text-sm ${
                filter === f
                  ? 'border-b-2 border-black font-semibold text-black'
                  : 'text-gray-500 hover:text-black'
              }`}
            >
              {label}
            </Link>
          )
        })}
      </nav>

      {all.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500">
          <p className="text-base font-medium">분류 결과 없음</p>
          <p className="text-sm mt-2">
            RPC <code className="px-1 bg-gray-100 rounded">jimscanner_trend_trigger_classify</code> 마이그레이션
            (supabase/trend_trigger_classify.sql) 적용 후, 누적된 alias·시그널이 쌓이면 표시됩니다.
          </p>
        </div>
      ) : (
        <div className="space-y-8">
          {grouped
            .filter((g) => g.items.length > 0)
            .map((g) => (
              <section key={g.key}>
                <div className="flex items-center gap-2 mb-3">
                  <span className={`inline-flex items-center gap-1 rounded border px-2 py-1 text-sm font-semibold ${g.meta.badgeClass}`}>
                    {g.meta.emoji} {g.meta.label}
                  </span>
                  <span className="text-xs text-gray-500">
                    지속성 <b>{g.meta.durabilityLabel}</b> · 권장 소싱 <b>{g.meta.posture}</b>
                  </span>
                  <span className="text-xs text-gray-400 ml-auto">{g.items.length}건</span>
                </div>
                <p className="text-xs text-gray-500 mb-2">{g.meta.postureHint}</p>
                <div className="grid gap-2">
                  {g.items.slice(0, 30).map((r) => (
                    <Link
                      key={r.product_id}
                      href={`/admin/trend-radar/products/${r.product_id}`}
                      className="grid grid-cols-12 items-center gap-2 px-3 py-2 rounded border border-gray-200 hover:bg-gray-50 transition-colors"
                    >
                      <div className="col-span-5 min-w-0">
                        <div className="font-medium truncate">{r.canonical_name}</div>
                        <div className="text-xs text-gray-500">
                          {r.category_top}
                          {r.top_evidence ? ` · 근거: ${r.top_evidence.slice(0, 28)}` : ''}
                        </div>
                      </div>
                      <div className="col-span-2">
                        <DurabilityBar value={r.durability} />
                      </div>
                      <div className="col-span-3 text-xs text-gray-500 truncate">
                        {(r.alias_sources ?? []).slice(0, 3).join(', ') || '—'}
                      </div>
                      <div className="col-span-1 text-right font-mono font-bold">{Math.round(r.final_score)}</div>
                      <div className="col-span-1 text-right font-mono text-gray-500 text-xs">{r.alias_count}al</div>
                    </Link>
                  ))}
                </div>
              </section>
            ))}
        </div>
      )}
    </div>
  )
}

function DurabilityBar({ value }: { value: number }) {
  return (
    <div className="flex items-center gap-0.5" title={`지속성 ${value}/4`}>
      {[1, 2, 3, 4].map((i) => (
        <div
          key={i}
          className={`h-2 flex-1 rounded-sm ${i <= value ? durabilityColor(value) : 'bg-gray-200'}`}
        />
      ))}
    </div>
  )
}
