import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

const INTENT_CLASSES = ['transactional', 'comparison', 'informational', 'navigational'] as const
type IntentClass = (typeof INTENT_CLASSES)[number]

const INTENT_LABEL: Record<IntentClass, string> = {
  transactional: '거래',
  comparison: '비교',
  informational: '정보',
  navigational: '브랜드',
}

const INTENT_COLOR: Record<IntentClass, string> = {
  transactional: 'bg-red-500',
  comparison: 'bg-amber-500',
  informational: 'bg-gray-400',
  navigational: 'bg-blue-500',
}

const CATEGORIES = ['health', 'living', 'digital', 'other'] as const
type Category = (typeof CATEGORIES)[number]

const CATEGORY_LABEL: Record<Category, string> = {
  health: '건강식품',
  living: '생활/리빙',
  digital: '디지털/가전',
  other: '기타',
}

interface IntentRow {
  product_id: string
  intent_class: IntentClass
  intent_probs: Record<string, number> | null
  is_pin_eligible: boolean
  classified_at: string
}

interface ProductRow {
  id: string
  canonical_name: string
  category_top: string
  alias_count: number
}

interface ScoreRow {
  product_id: string
  final_score: number
  computed_at: string
}

async function fetchIntentData() {
  const sb = createAdminClient()

  // 1) 의도 분류 row 전체 (서비스 롤)
  const { data: intentData } = await (sb as any)
    .from('jimscanner_trends_intent')
    .select('product_id, intent_class, intent_probs, is_pin_eligible, classified_at')
    .order('classified_at', { ascending: false })
    .limit(2000)

  const intents = (intentData ?? []) as IntentRow[]

  if (intents.length === 0) {
    return {
      intents: [],
      productMap: new Map<string, ProductRow>(),
      scoreMap: new Map<string, ScoreRow>(),
      heatmap: emptyHeatmap(),
      pinCandidates: [],
      stats: { total: 0, eligible: 0, byClass: zeroByClass() },
    }
  }

  const productIds = [...new Set(intents.map((i) => i.product_id))]

  // 2) product 메타
  const { data: prodData } = await sb
    .from('jimscanner_trends_products')
    .select('id, canonical_name, category_top, alias_count')
    .in('id', productIds)

  const productMap = new Map<string, ProductRow>()
  for (const p of (prodData ?? []) as ProductRow[]) productMap.set(p.id, p)

  // 3) 최신 스코어 (있으면)
  const { data: scoreData } = await sb
    .from('jimscanner_trends_scores')
    .select('product_id, final_score, computed_at')
    .in('product_id', productIds)
    .order('computed_at', { ascending: false })
    .limit(productIds.length * 3)

  const scoreMap = new Map<string, ScoreRow>()
  for (const s of (scoreData ?? []) as ScoreRow[]) {
    if (!scoreMap.has(s.product_id)) scoreMap.set(s.product_id, s)
  }

  // 4) 의도×카테고리 히트맵 (셀-stack)
  const heatmap = emptyHeatmap()
  let eligible = 0
  const byClass = zeroByClass()

  for (const it of intents) {
    const p = productMap.get(it.product_id)
    if (!p) continue
    const cat = (CATEGORIES.includes(p.category_top as Category) ? p.category_top : 'other') as Category
    heatmap[cat][it.intent_class] += 1
    byClass[it.intent_class] += 1
    if (it.is_pin_eligible) eligible++
  }

  // 5) transactional Top-50 핀 후보 (transactional 확률 내림차순)
  const pinCandidates = intents
    .filter((it) => productMap.has(it.product_id))
    .map((it) => {
      const probs = it.intent_probs ?? {}
      const t = Number(probs.transactional ?? 0)
      const c = Number(probs.comparison ?? 0)
      return {
        intent: it,
        product: productMap.get(it.product_id)!,
        score: scoreMap.get(it.product_id) ?? null,
        transactional: t,
        comparison: c,
      }
    })
    .sort((a, b) => b.transactional - a.transactional)
    .slice(0, 50)

  return {
    intents,
    productMap,
    scoreMap,
    heatmap,
    pinCandidates,
    stats: { total: intents.length, eligible, byClass },
  }
}

function emptyHeatmap(): Record<Category, Record<IntentClass, number>> {
  const o: any = {}
  for (const cat of CATEGORIES) {
    o[cat] = { transactional: 0, comparison: 0, informational: 0, navigational: 0 }
  }
  return o
}

function zeroByClass(): Record<IntentClass, number> {
  return { transactional: 0, comparison: 0, informational: 0, navigational: 0 }
}

export default async function TrendRadarIntentPage() {
  const { heatmap, pinCandidates, stats } = await fetchIntentData()

  // backtest 게이지: pin_eligible 비중 — 실제 위탁 전환 데이터가 들어오면 RPC 로 대체
  const eligibilityPct = stats.total > 0 ? Math.round((stats.eligible / stats.total) * 100) : 0

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold">의도 게이트 — Intent Routing</h1>
          <p className="text-sm text-gray-500 mt-1">
            키워드별 검색 의도(transactional/comparison/informational/navigational) 분류로 핀 진입을 라우팅.
            informational-only 키워드는 후순위 큐.
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      {/* KPI */}
      <section className="grid grid-cols-2 md:grid-cols-5 gap-4">
        <KpiCard label="분류된 product" value={stats.total} hint="누적 LLM 의도분류" />
        <KpiCard
          label="핀 자격"
          value={stats.eligible}
          hint={`${eligibilityPct}% — gate 통과`}
          accent="text-red-600"
        />
        <KpiCard label="transactional" value={stats.byClass.transactional} hint="즉시 구매 의도" />
        <KpiCard label="comparison" value={stats.byClass.comparison} hint="비교쇼핑 의도" />
        <KpiCard
          label="informational"
          value={stats.byClass.informational}
          hint="정보탐색 — 후순위"
          accent="text-gray-400"
        />
      </section>

      {/* 의도→전환률 backtest 게이지 (현재는 핀 자격 비중을 proxy 로 표시) */}
      <section className="rounded border border-gray-200 p-4">
        <div className="flex items-baseline justify-between mb-2">
          <h2 className="text-sm font-semibold text-gray-700">
            의도→핀 자격 backtest 게이지
          </h2>
          <span className="text-xs text-gray-500">
            transactional ≥ 0.6 또는 comparison ≥ 0.55 통과
          </span>
        </div>
        <div className="h-3 bg-gray-100 rounded overflow-hidden">
          <div
            className="h-full bg-red-500 transition-all"
            style={{ width: `${eligibilityPct}%` }}
          />
        </div>
        <div className="flex justify-between text-xs text-gray-500 mt-1">
          <span>{stats.eligible} 핀 자격 / {stats.total} 분류</span>
          <span className="font-mono">{eligibilityPct}%</span>
        </div>
        <p className="text-xs text-gray-400 mt-3">
          실제 위탁 전환률 데이터(주문↔매입 매칭) 누적 시 RPC 로 대체 예정.
          현재는 핀 자격 통과율을 proxy 로 표시.
        </p>
      </section>

      {/* 의도×카테고리 셀-stack 히트맵 */}
      <section className="rounded border border-gray-200 p-4">
        <h2 className="text-sm font-semibold text-gray-700 mb-3">
          의도 × 카테고리 셀-stack 히트맵
        </h2>
        {stats.total === 0 ? (
          <div className="text-sm text-gray-500 text-center py-6">
            아직 의도 분류 데이터 없음.{' '}
            <code className="px-1 bg-gray-100 rounded">classify-trends-llm</code> 실행 후 확인.
          </div>
        ) : (
          <div className="space-y-2">
            <div className="grid grid-cols-12 text-xs text-gray-500 px-2">
              <div className="col-span-2">카테고리</div>
              <div className="col-span-9">의도 분포</div>
              <div className="col-span-1 text-right">합계</div>
            </div>
            {CATEGORIES.map((cat) => {
              const row = heatmap[cat]
              const total = INTENT_CLASSES.reduce((s, c) => s + row[c], 0)
              return (
                <div key={cat} className="grid grid-cols-12 items-center px-2 py-1">
                  <div className="col-span-2 text-sm font-medium">{CATEGORY_LABEL[cat]}</div>
                  <div className="col-span-9 flex h-6 rounded overflow-hidden bg-gray-50">
                    {INTENT_CLASSES.map((cls) => {
                      const count = row[cls]
                      const pct = total > 0 ? (count / total) * 100 : 0
                      if (pct === 0) return null
                      return (
                        <div
                          key={cls}
                          className={`${INTENT_COLOR[cls]} flex items-center justify-center text-[10px] text-white font-mono`}
                          style={{ width: `${pct}%` }}
                          title={`${INTENT_LABEL[cls]}: ${count} (${pct.toFixed(0)}%)`}
                        >
                          {pct >= 8 ? count : ''}
                        </div>
                      )
                    })}
                  </div>
                  <div className="col-span-1 text-right font-mono text-sm">{total}</div>
                </div>
              )
            })}
            <div className="flex gap-3 text-xs text-gray-500 mt-3 pt-2 border-t border-gray-100">
              {INTENT_CLASSES.map((cls) => (
                <span key={cls} className="flex items-center gap-1">
                  <span className={`inline-block w-3 h-3 rounded ${INTENT_COLOR[cls]}`} />
                  {INTENT_LABEL[cls]}
                </span>
              ))}
            </div>
          </div>
        )}
      </section>

      {/* transactional Top-50 핀 후보 */}
      <section>
        <div className="flex items-baseline justify-between mb-3">
          <h2 className="text-sm font-semibold text-gray-700">
            🎯 transactional Top-50 — 핀 후보
          </h2>
          <span className="text-xs text-gray-500">
            transactional 확률 내림차순 · informational-only 는 자동 제외
          </span>
        </div>
        {pinCandidates.length === 0 ? (
          <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500 text-sm">
            아직 분류 데이터 없음.
          </div>
        ) : (
          <div className="rounded border border-gray-200 divide-y divide-gray-100">
            <div className="grid grid-cols-12 text-xs text-gray-500 px-3 py-2 bg-gray-50">
              <div className="col-span-1">#</div>
              <div className="col-span-4">상품명</div>
              <div className="col-span-1">카테고리</div>
              <div className="col-span-1 text-right">trans.</div>
              <div className="col-span-1 text-right">comp.</div>
              <div className="col-span-1 text-right">info.</div>
              <div className="col-span-1 text-right">nav.</div>
              <div className="col-span-1 text-right">final</div>
              <div className="col-span-1 text-right">핀</div>
            </div>
            {pinCandidates.map((row, i) => {
              const probs = row.intent.intent_probs ?? {}
              const t = Number(probs.transactional ?? 0)
              const c = Number(probs.comparison ?? 0)
              const inf = Number(probs.informational ?? 0)
              const nav = Number(probs.navigational ?? 0)
              return (
                <Link
                  key={row.intent.product_id}
                  href={`/admin/trend-radar/products/${row.intent.product_id}`}
                  className="grid grid-cols-12 px-3 py-2 text-sm hover:bg-gray-50 transition-colors"
                >
                  <div className="col-span-1 text-gray-400 font-mono">{i + 1}</div>
                  <div className="col-span-4 truncate font-medium">
                    {row.product.canonical_name}
                  </div>
                  <div className="col-span-1 text-xs text-gray-500">
                    {row.product.category_top}
                  </div>
                  <div className="col-span-1 text-right font-mono font-bold text-red-600">
                    {t.toFixed(2)}
                  </div>
                  <div className="col-span-1 text-right font-mono text-amber-600">
                    {c.toFixed(2)}
                  </div>
                  <div className="col-span-1 text-right font-mono text-gray-400">
                    {inf.toFixed(2)}
                  </div>
                  <div className="col-span-1 text-right font-mono text-gray-400">
                    {nav.toFixed(2)}
                  </div>
                  <div className="col-span-1 text-right font-mono text-gray-600">
                    {row.score ? Math.round(row.score.final_score) : '-'}
                  </div>
                  <div className="col-span-1 text-right">
                    {row.intent.is_pin_eligible ? (
                      <span className="inline-block px-1.5 py-0.5 rounded text-xs bg-red-100 text-red-700 font-semibold">
                        OK
                      </span>
                    ) : (
                      <span className="text-xs text-gray-300">—</span>
                    )}
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

function KpiCard({
  label,
  value,
  hint,
  accent,
}: {
  label: string
  value: number
  hint: string | number
  accent?: string
}) {
  return (
    <div className="rounded border border-gray-200 p-4">
      <div className="text-xs text-gray-500">{label}</div>
      <div className={`text-3xl font-bold mt-1 ${accent ?? ''}`}>{value.toLocaleString()}</div>
      <div className="text-xs text-gray-400 mt-1">{hint}</div>
    </div>
  )
}
