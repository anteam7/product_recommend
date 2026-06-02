import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import { demandQualityFromAliases, type DemandQuality } from '@/lib/trends/promo-dependency'
import PromoDependencyScatter from './PromoDependencyScatter'

export const dynamic = 'force-dynamic'

interface ScoreRow {
  product_id: string
  final_score: number
  trend_score: number
  computed_at: string
  score_components: any
}

export interface PromoRow {
  id: string
  name: string
  category: string
  final: number
  trend: number
  dq: DemandQuality
  fromRecompute: boolean // demand_quality 가 recompute 적재분인지(true) alias 계산분인지(false)
}

async function fetchData(): Promise<{ rows: PromoRow[] }> {
  const sb = createAdminClient()

  // 1) product 별 최신 score
  const { data: scores } = await sb
    .from('jimscanner_trends_scores')
    .select('product_id, final_score, trend_score, computed_at, score_components')
    .order('computed_at', { ascending: false })
    .limit(2000)

  const seen = new Set<string>()
  const latest: ScoreRow[] = []
  for (const s of (scores ?? []) as ScoreRow[]) {
    if (seen.has(s.product_id)) continue
    seen.add(s.product_id)
    latest.push(s)
  }

  const ids = latest.map((s) => s.product_id)
  if (ids.length === 0) return { rows: [] }

  // 2) product 메타 + alias source
  const [{ data: prods }, { data: aliases }] = await Promise.all([
    sb.from('jimscanner_trends_products').select('id, canonical_name, category_top').in('id', ids),
    sb.from('jimscanner_trends_aliases').select('product_id, source, confidence').in('product_id', ids),
  ])

  const byId = new Map((prods ?? []).map((p: any) => [p.id, p]))
  const aliasByProduct = new Map<string, { source: string | null; confidence: number | null }[]>()
  for (const a of (aliases ?? []) as { product_id: string; source: string | null; confidence: number | null }[]) {
    const arr = aliasByProduct.get(a.product_id) ?? []
    arr.push({ source: a.source, confidence: a.confidence })
    aliasByProduct.set(a.product_id, arr)
  }

  const rows: PromoRow[] = latest.map((s) => {
    const p = byId.get(s.product_id) ?? {}
    // recompute 가 demand_quality 를 적재했으면 그 값을 우선, 없으면 alias 로 on-the-fly 계산.
    const recomputed = (s.score_components as any)?.demand_quality as DemandQuality | undefined
    const dq =
      recomputed && typeof recomputed.dependency_index === 'number'
        ? recomputed
        : demandQualityFromAliases(aliasByProduct.get(s.product_id) ?? [])
    return {
      id: s.product_id,
      name: (p as any).canonical_name ?? '?',
      category: (p as any).category_top ?? 'all',
      final: s.final_score,
      trend: s.trend_score,
      dq,
      fromRecompute: !!(recomputed && typeof recomputed.dependency_index === 'number'),
    }
  })

  return { rows }
}

export default async function PromoDependencyPage() {
  const { rows } = await fetchData()

  const red = rows.filter((r) => r.dq.verdict === 'red')
  const green = rows.filter((r) => r.dq.verdict === 'green')
  const amber = rows.filter((r) => r.dq.verdict === 'amber')

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold">프로모션 의존도 게이트</h1>
          <p className="text-sm text-gray-500 mt-1">
            할인이 만든 가짜 수요 거르기 · 빨강(딥할인 의존) 회피 · 초록(오가닉 주도)만 소싱 큐로
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      {/* KPI 3종 */}
      <section className="grid grid-cols-3 gap-4">
        <VerdictCard label="🟢 오가닉 주도" value={green.length} hint="정가에서도 수요 — 소싱 권장" tone="green" />
        <VerdictCard label="🟡 혼재" value={amber.length} hint="딜+오가닉 섞임 — 추가 검토" tone="amber" />
        <VerdictCard label="🔴 프로모션 의존" value={red.length} hint="딥할인 없으면 안 뜸 — 회피" tone="red" />
      </section>

      {rows.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500">
          아직 데이터 없음. cron 누적 후 다시 방문.
        </div>
      ) : (
        <>
          <PromoDependencyScatter rows={rows} />

          {/* 빨강 경고 리스트 */}
          <section className="rounded border border-red-200 bg-red-50/50 p-4">
            <h2 className="text-sm font-semibold text-red-800 mb-1">
              🔴 소싱 회피 후보 ({red.length}) — 프로모션 의존 상품
            </h2>
            <p className="text-xs text-red-700/80 mb-3">
              딜·특가 바이럴(ppomppu·quasarzone 등)이 오가닉/커뮤니티 수요보다 우세. 위탁은 딥할인 경쟁이
              불가능하므로 정가에서 안 팔릴 위험.
            </p>
            {red.length === 0 ? (
              <div className="text-xs text-gray-500">프로모션 의존 후보 없음 — 건강한 풀.</div>
            ) : (
              <div className="space-y-1">
                <div className="grid grid-cols-12 text-xs text-red-700/70 px-2 py-1">
                  <div className="col-span-5">상품명</div>
                  <div className="col-span-2 text-right">의존지수</div>
                  <div className="col-span-1 text-right">딜</div>
                  <div className="col-span-1 text-right">오가닉</div>
                  <div className="col-span-1 text-right">커뮤</div>
                  <div className="col-span-2 text-right">final</div>
                </div>
                {red
                  .sort((a, b) => b.dq.dependency_index - a.dq.dependency_index)
                  .slice(0, 30)
                  .map((r) => (
                    <Link
                      key={r.id}
                      href={`/admin/trend-radar/products/${r.id}`}
                      className="grid grid-cols-12 px-2 py-1.5 text-sm rounded hover:bg-white items-center"
                    >
                      <div className="col-span-5 truncate">
                        {r.name}
                        <span className="text-xs text-gray-400 ml-1">{r.category}</span>
                      </div>
                      <div className="col-span-2 text-right font-mono font-bold text-red-700">
                        {r.dq.dependency_index.toFixed(2)}
                      </div>
                      <div className="col-span-1 text-right font-mono text-gray-600">{r.dq.deal_heat}</div>
                      <div className="col-span-1 text-right font-mono text-gray-600">{r.dq.organic_heat}</div>
                      <div className="col-span-1 text-right font-mono text-gray-600">{r.dq.community_heat}</div>
                      <div className="col-span-2 text-right font-mono text-gray-500">{r.final}</div>
                    </Link>
                  ))}
              </div>
            )}
          </section>

          {/* 초록 소싱 큐 */}
          <section className="rounded border border-green-200 bg-green-50/50 p-4">
            <h2 className="text-sm font-semibold text-green-800 mb-3">
              🟢 오가닉 주도 — 소싱 큐 권장 ({green.length}) · final 상위 20
            </h2>
            {green.length === 0 ? (
              <div className="text-xs text-gray-500">오가닉 주도 후보 없음. 30일 누적 후 자연 등장.</div>
            ) : (
              <div className="space-y-1">
                {green
                  .sort((a, b) => b.final - a.final)
                  .slice(0, 20)
                  .map((r) => (
                    <Link
                      key={r.id}
                      href={`/admin/trend-radar/products/${r.id}`}
                      className="grid grid-cols-12 px-2 py-1.5 text-sm rounded hover:bg-white items-center"
                    >
                      <div className="col-span-7 truncate">
                        {r.name}
                        <span className="text-xs text-gray-400 ml-1">{r.category}</span>
                      </div>
                      <div className="col-span-2 text-right font-mono text-green-700">
                        {r.dq.dependency_index.toFixed(2)}
                      </div>
                      <div className="col-span-1 text-right font-mono text-gray-500">{r.dq.organic_heat}</div>
                      <div className="col-span-2 text-right font-mono font-bold">{r.final}</div>
                    </Link>
                  ))}
              </div>
            )}
          </section>

          <section className="text-xs text-gray-400">
            의존지수 = 딜계열 heat / max(오가닉+커뮤니티 heat, 1) · heat 는 alias.source 를 confidence
            가중 집계 (recompute 가 score_components.demand_quality 를 적재하면 그 값 우선).
            빨강 ≥ 1.5 · 초록 ≤ 0.5.
          </section>
        </>
      )}
    </div>
  )
}

function VerdictCard({
  label,
  value,
  hint,
  tone,
}: {
  label: string
  value: number
  hint: string
  tone: 'red' | 'amber' | 'green'
}) {
  const toneCls =
    tone === 'red'
      ? 'border-red-200 bg-red-50'
      : tone === 'green'
        ? 'border-green-200 bg-green-50'
        : 'border-amber-200 bg-amber-50'
  return (
    <div className={`rounded border p-4 ${toneCls}`}>
      <div className="text-xs text-gray-600">{label}</div>
      <div className="text-3xl font-bold mt-1">{value.toLocaleString()}</div>
      <div className="text-xs text-gray-500 mt-1">{hint}</div>
    </div>
  )
}
