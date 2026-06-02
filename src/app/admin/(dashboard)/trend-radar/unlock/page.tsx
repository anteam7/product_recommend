import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

// 4개 컴포넌트 키 정의 — jimscanner_trends_scores 컬럼과 1:1
const COMPONENTS = ['trend', 'commerce', 'supplier', 'competition'] as const
type ComponentKey = (typeof COMPONENTS)[number]

// 상위권 판정 퍼센타일 (3개 컴포넌트가 이 이상이어야 '거의 다 됨')
const TOP_PERCENTILE = 0.65

interface ScoreRow {
  product_id: string
  trend_score: number
  commerce_score: number
  supplier_score: number
  competition_score: number
  final_score: number
  score_components: any
  computed_at: string
}

// 병목 컴포넌트 → 버킷 메타 (라벨/색/액션)
const BUCKET: Record<
  ComponentKey,
  {
    bucket: string
    emoji: string
    accent: string
    action: string
    cta: (name: string, id: string) => { label: string; href: string; external?: boolean }
  }
> = {
  supplier: {
    bucket: '소싱공백',
    emoji: '📦',
    accent: 'border-orange-300 bg-orange-50',
    action: 'ggsan·도매 소싱검색어로 공급원 확보',
    cta: (name) => ({
      // 도매꾹 키워드 검색 — 공급원 발굴 진입
      label: '도매꾹 소싱검색 →',
      href: `https://domeggook.com/main/item/itemList.php?sf=tt&sw=${encodeURIComponent(
        sourcingKeyword(name),
      )}`,
      external: true,
    }),
  },
  commerce: {
    bucket: '마진박약',
    emoji: '💰',
    accent: 'border-amber-300 bg-amber-50',
    action: '가격·마진 재계산으로 commerce 끌어올리기',
    cta: (_name, id) => ({
      label: '상세에서 가격재계산 →',
      href: `/admin/trend-radar/products/${id}`,
    }),
  },
  competition: {
    bucket: '경쟁과열',
    emoji: '⚔️',
    accent: 'border-rose-300 bg-rose-50',
    action: '변형·묶음 구성으로 경쟁 회피 차별화',
    cta: (_name, id) => ({
      label: '변형·묶음 설계 →',
      href: `/admin/trend-radar/products/${id}`,
    }),
  },
  trend: {
    bucket: '수요미열',
    emoji: '👀',
    accent: 'border-slate-300 bg-slate-50',
    action: '수요 신호 부족 — 워치리스트 보류',
    cta: (_name, id) => ({
      label: '추이 확인 →',
      href: `/admin/trend-radar/products/${id}`,
    }),
  },
}

// 소싱 검색어 자동 생성: 괄호·수식어 제거 후 앞 2~3 토큰
function sourcingKeyword(name: string): string {
  const cleaned = name.replace(/\([^)]*\)/g, ' ').replace(/[\[\]{}]/g, ' ')
  return cleaned.trim().split(/\s+/).slice(0, 3).join(' ') || name
}

// 컴포넌트별 퍼센타일 룩업 — value → percentile(0~1)
function percentileFn(values: number[]): (v: number) => number {
  const sorted = [...values].sort((a, b) => a - b)
  const n = sorted.length
  return (v: number) => {
    if (n <= 1) return 1
    // v 미만 개수 / (n-1)
    let lt = 0
    for (const x of sorted) if (x < v) lt++
    return lt / (n - 1)
  }
}

interface UnlockRow {
  id: string
  name: string
  category: string
  final: number
  components: Record<ComponentKey, number>
  bottleneck: ComponentKey
  bottleneckValue: number
  bottleneckGap: number // 차상위 컴포넌트 − 최저 컴포넌트
  uplift: number // 잠금해제 시 예상 final_score 상승폭
}

async function fetchData() {
  const sb = createAdminClient()

  const { data: latestScores } = await sb
    .from('jimscanner_trends_scores')
    .select(
      'product_id, trend_score, commerce_score, supplier_score, competition_score, final_score, score_components, computed_at',
    )
    .order('computed_at', { ascending: false })
    .limit(2000)

  // product_id 별 가장 최근 row 만
  const seen = new Set<string>()
  const latest: ScoreRow[] = []
  for (const s of (latestScores ?? []) as ScoreRow[]) {
    if (seen.has(s.product_id)) continue
    seen.add(s.product_id)
    latest.push(s)
  }
  if (latest.length === 0) return { rows: [] as UnlockRow[], total: 0 }

  // 컴포넌트별 퍼센타일 함수 (횡단면)
  const pct: Record<ComponentKey, (v: number) => number> = {
    trend: percentileFn(latest.map((s) => s.trend_score)),
    commerce: percentileFn(latest.map((s) => s.commerce_score)),
    supplier: percentileFn(latest.map((s) => s.supplier_score)),
    competition: percentileFn(latest.map((s) => s.competition_score)),
  }

  const ids = latest.map((s) => s.product_id)
  const { data: prods } = await sb
    .from('jimscanner_trends_products')
    .select('id, canonical_name, category_top')
    .in('id', ids)
  const byId = new Map((prods ?? []).map((p: any) => [p.id, p]))

  const rows: UnlockRow[] = []
  for (const s of latest) {
    const components: Record<ComponentKey, number> = {
      trend: s.trend_score,
      commerce: s.commerce_score,
      supplier: s.supplier_score,
      competition: s.competition_score,
    }

    // 상위권(≥TOP_PERCENTILE) 컴포넌트 / 그 외
    const below = COMPONENTS.filter((c) => pct[c](components[c]) < TOP_PERCENTILE)
    // '원-레버': 정확히 하나만 임계 이하
    if (below.length !== 1) continue
    const bottleneck = below[0]
    const bottleneckValue = components[bottleneck]

    // 차상위(=최저 다음으로 낮은) 컴포넌트 값
    const sortedVals = COMPONENTS.map((c) => components[c]).sort((a, b) => a - b)
    const secondLowest = sortedVals[1]
    const bottleneckGap = Math.max(0, secondLowest - bottleneckValue)

    // 잠금해제 시 예상 상승폭: 병목을 '나머지 3개 평균' 수준으로 끌어올린다고 가정.
    // final ≈ 4컴포넌트 동일가중(0.25) 근사 → uplift = (목표 − 현재) * 0.25
    const others = COMPONENTS.filter((c) => c !== bottleneck).map((c) => components[c])
    const target = Math.round(others.reduce((a, b) => a + b, 0) / others.length)
    const uplift = Math.max(0, Math.round((target - bottleneckValue) * 0.25 * 10) / 10)

    const p = byId.get(s.product_id) ?? {}
    rows.push({
      id: s.product_id,
      name: (p as any).canonical_name ?? '?',
      category: (p as any).category_top ?? 'all',
      final: s.final_score,
      components,
      bottleneck,
      bottleneckValue,
      bottleneckGap,
      uplift,
    })
  }

  // ROI 정렬: 예상 상승폭 desc, 동률이면 병목 갭 작은 순(=거의 다 됨)
  rows.sort((a, b) => b.uplift - a.uplift || a.bottleneckGap - b.bottleneckGap)

  return { rows, total: latest.length }
}

export default async function UnlockPage() {
  const { rows, total } = await fetchData()

  // 버킷별 그룹
  const grouped: Record<ComponentKey, UnlockRow[]> = {
    supplier: [],
    commerce: [],
    competition: [],
    trend: [],
  }
  for (const r of rows) grouped[r.bottleneck].push(r)

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold">원-레버 병목 보드</h1>
          <p className="text-sm text-gray-500 mt-1">
            3개 컴포넌트는 상위 {Math.round((1 - TOP_PERCENTILE) * 100)}%권인데{' '}
            <b>딱 하나</b>가 막은 '잠금해제 후보' — 단일 액션으로 A급이 될 상품만 큐잉
          </p>
        </div>
        <Link href="/admin/trend-radar/opportunity" className="text-sm text-gray-700 hover:text-black underline">
          Opportunity Matrix →
        </Link>
      </header>

      {/* 요약 KPI */}
      <section className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <Kpi label="원-레버 후보" value={rows.length} hint={`전체 ${total}개 중`} />
        <Kpi label="📦 소싱공백" value={grouped.supplier.length} hint="supplier 병목" />
        <Kpi label="💰 마진박약" value={grouped.commerce.length} hint="commerce 병목" />
        <Kpi label="⚔️ 경쟁과열" value={grouped.competition.length} hint="competition 병목" />
        <Kpi label="👀 수요미열" value={grouped.trend.length} hint="trend 병목" />
      </section>

      {rows.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500">
          아직 원-레버 후보 없음. recompute_scores 누적 후 다시 방문.
        </div>
      ) : (
        COMPONENTS.map((c) => {
          const list = grouped[c]
          if (list.length === 0) return null
          const meta = BUCKET[c]
          return (
            <section key={c} className={`rounded border p-4 ${meta.accent}`}>
              <div className="flex items-baseline justify-between mb-3">
                <h2 className="text-sm font-semibold text-gray-800">
                  {meta.emoji} {meta.bucket}{' '}
                  <span className="text-xs font-normal text-gray-500 ml-1">
                    {c} 병목 · {list.length}건 — {meta.action}
                  </span>
                </h2>
              </div>
              <div className="space-y-1">
                <div className="grid grid-cols-12 text-xs text-gray-500 px-2 py-1">
                  <div className="col-span-4">상품명</div>
                  <div className="col-span-1 text-right">final</div>
                  <div className="col-span-1 text-right">병목값</div>
                  <div className="col-span-1 text-right">갭</div>
                  <div className="col-span-1 text-right">▲예상</div>
                  <div className="col-span-2">컴포넌트</div>
                  <div className="col-span-2 text-right">액션</div>
                </div>
                {list.slice(0, 30).map((r) => {
                  const cta = meta.cta(r.name, r.id)
                  return (
                    <div
                      key={r.id}
                      className="grid grid-cols-12 px-2 py-2 text-sm rounded bg-white/70 hover:bg-white items-center"
                      title={tooltip(r)}
                    >
                      <div className="col-span-4">
                        <Link
                          href={`/admin/trend-radar/products/${r.id}`}
                          className="font-medium hover:underline"
                        >
                          {r.name}
                        </Link>
                        <div className="text-xs text-gray-500">{r.category}</div>
                      </div>
                      <div className="col-span-1 text-right font-mono font-bold">{r.final}</div>
                      <div className="col-span-1 text-right font-mono text-red-600">
                        {r.bottleneckValue}
                      </div>
                      <div className="col-span-1 text-right font-mono text-gray-500">
                        {r.bottleneckGap}
                      </div>
                      <div className="col-span-1 text-right font-mono font-semibold text-green-700">
                        +{r.uplift}
                      </div>
                      <div className="col-span-2 text-[11px] font-mono text-gray-500">
                        {COMPONENTS.map((k) => `${k[0]}${r.components[k]}`).join(' ')}
                      </div>
                      <div className="col-span-2 text-right">
                        {cta.external ? (
                          <a
                            href={cta.href}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-xs text-blue-700 hover:underline"
                          >
                            {cta.label}
                          </a>
                        ) : (
                          <Link href={cta.href} className="text-xs text-blue-700 hover:underline">
                            {cta.label}
                          </Link>
                        )}
                      </div>
                    </div>
                  )
                })}
                {list.length > 30 && (
                  <div className="text-xs text-gray-500 px-2 pt-2">
                    … 외 {list.length - 30}건 (상위 30건만 표시)
                  </div>
                )}
              </div>
            </section>
          )
        })
      )}

      <p className="text-xs text-gray-400">
        판정: 컴포넌트별 횡단면 퍼센타일 기준 3개 ≥ 상위 {Math.round((1 - TOP_PERCENTILE) * 100)}%권 +
        정확히 1개 미달. 예상 상승폭은 병목을 나머지 평균까지 끌어올렸을 때 동일가중(0.25) 근사.
      </p>
    </div>
  )
}

function tooltip(r: UnlockRow): string {
  const lines = [
    `병목: ${r.bottleneck} = ${r.bottleneckValue} (차상위와 갭 ${r.bottleneckGap})`,
    `컴포넌트: trend ${r.components.trend} / commerce ${r.components.commerce} / supplier ${r.components.supplier} / competition ${r.components.competition}`,
    `잠금해제 시 final 예상 +${r.uplift}`,
  ]
  return lines.join('\n')
}

function Kpi({ label, value, hint }: { label: string; value: number; hint: string }) {
  return (
    <div className="rounded border border-gray-200 p-4 bg-white">
      <div className="text-xs text-gray-500">{label}</div>
      <div className="text-3xl font-bold mt-1">{value.toLocaleString()}</div>
      <div className="text-xs text-gray-400 mt-1">{hint}</div>
    </div>
  )
}
