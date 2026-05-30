import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

// ── 점수 임계 ──────────────────────────────────────────────
// 각 축 0~100. competition_score 는 "높을수록 경쟁이 약함"(opportunity matrix 규칙과 동일).
const HI = 60
const LO = 40
type Level = 'hi' | 'mid' | 'lo'
function lvl(v: number): Level {
  if (v >= HI) return 'hi'
  if (v < LO) return 'lo'
  return 'mid'
}

interface ScoreRow {
  product_id: string
  trend_score: number
  commerce_score: number
  supplier_score: number
  competition_score: number
  final_score: number
  computed_at: string
}

interface Item {
  id: string
  name: string
  category: string
  trend: number
  commerce: number
  supplier: number
  competition: number
  final: number
}

// ── 아키타입 정의 (우선순위 순 — 첫 매칭 승) ──────────────────
type ActionTone = 'go' | 'source' | 'watch' | 'skip'
interface Archetype {
  id: string
  label: string
  emoji: string
  desc: string
  playbook: string
  action: string
  tone: ActionTone
  match: (i: Item) => boolean
}

const TONE_STYLE: Record<ActionTone, { card: string; chip: string }> = {
  go: { card: 'border-emerald-300 bg-emerald-50/60', chip: 'bg-emerald-600 text-white' },
  source: { card: 'border-sky-300 bg-sky-50/60', chip: 'bg-sky-600 text-white' },
  watch: { card: 'border-amber-300 bg-amber-50/60', chip: 'bg-amber-600 text-white' },
  skip: { card: 'border-gray-300 bg-gray-50', chip: 'bg-gray-500 text-white' },
}

const ARCHETYPES: Archetype[] = [
  {
    id: 'balanced',
    label: '균형 — 즉시등록',
    emoji: '🚀',
    desc: '4축 모두 양호 (trend·commerce·supplier·competition ↑)',
    playbook: '바로 ggsan 소싱 → 쿠팡 등록. 더 볼 것 없음.',
    action: '즉시등록',
    tone: 'go',
    match: (i) =>
      lvl(i.trend) === 'hi' && lvl(i.supplier) === 'hi' &&
      lvl(i.competition) !== 'lo' && lvl(i.commerce) !== 'lo',
  },
  {
    id: 'sourcing_gap',
    label: '수요폭발 — 소싱공백',
    emoji: '🔍',
    desc: '수요(trend) 높은데 공급(supplier) 비어 있음',
    playbook: 'ggsan/알리에서 도매처부터 확보. 찾으면 황금 틈새.',
    action: '소싱 먼저',
    tone: 'source',
    match: (i) => lvl(i.trend) === 'hi' && lvl(i.supplier) === 'lo',
  },
  {
    id: 'red_ocean',
    label: '레드오션 — 고수요/고경쟁',
    emoji: '🩸',
    desc: '수요는 크지만 경쟁이 치열(competition ↓)',
    playbook: '가격·배송 차별화 없으면 진입 보류. 마진 방어 어려움.',
    action: '관망',
    tone: 'watch',
    match: (i) => lvl(i.trend) === 'hi' && lvl(i.competition) === 'lo',
  },
  {
    id: 'ready_to_list',
    label: '고수요 — 등록후보',
    emoji: '✅',
    desc: '수요 높고 공급도 받쳐줌 (경쟁 보통)',
    playbook: '소싱 확보돼 있으면 등록 진행. 마진만 확인.',
    action: '즉시등록',
    tone: 'go',
    match: (i) => lvl(i.trend) === 'hi' && lvl(i.supplier) !== 'lo',
  },
  {
    id: 'niche',
    label: '저경쟁 — 틈새',
    emoji: '🪴',
    desc: '경쟁 약함(competition ↑) · 수요는 중간',
    playbook: '소량 테스트 등록. 수요 더 오르면 선점 효과.',
    action: '테스트등록',
    tone: 'source',
    match: (i) => lvl(i.competition) === 'hi' && lvl(i.trend) === 'mid',
  },
  {
    id: 'spec_no_demand',
    label: '사양만족 — 수요부족',
    emoji: '📦',
    desc: '공급(supplier) 좋은데 수요(trend) 약함',
    playbook: '서두를 이유 없음. 수요 시그널 뜨면 즉시 전환.',
    action: '관망',
    tone: 'watch',
    match: (i) => lvl(i.supplier) === 'hi' && lvl(i.trend) === 'lo',
  },
  {
    id: 'immature',
    label: '미성숙 — 보류',
    emoji: '🌫️',
    desc: '전축이 중하위 — 아직 신호 약함',
    playbook: '누적 데이터 더 쌓일 때까지 스킵. 30일 후 재평가.',
    action: '스킵',
    tone: 'skip',
    match: () => true, // catch-all
  },
]

function classify(i: Item): Archetype {
  for (const a of ARCHETYPES) {
    if (a.match(i)) return a
  }
  return ARCHETYPES[ARCHETYPES.length - 1]
}

async function fetchItems(): Promise<Item[]> {
  const sb = createAdminClient()

  const { data: scores } = await sb
    .from('jimscanner_trends_scores')
    .select('product_id, trend_score, commerce_score, supplier_score, competition_score, final_score, computed_at')
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
  if (ids.length === 0) return []

  const { data: prods } = await sb
    .from('jimscanner_trends_products')
    .select('id, canonical_name, category_top')
    .in('id', ids)
  const byId = new Map((prods ?? []).map((p: any) => [p.id, p]))

  return latest.map((s) => {
    const p = (byId.get(s.product_id) ?? {}) as any
    return {
      id: s.product_id,
      name: p.canonical_name ?? '?',
      category: p.category_top ?? 'all',
      trend: s.trend_score,
      commerce: s.commerce_score,
      supplier: s.supplier_score,
      competition: s.competition_score,
      final: s.final_score,
    }
  })
}

export default async function ArchetypesPage({
  searchParams,
}: {
  searchParams: Promise<{ type?: string }>
}) {
  const sp = await searchParams
  const items = await fetchItems()

  // 군집화
  const groups = new Map<string, Item[]>()
  for (const a of ARCHETYPES) groups.set(a.id, [])
  for (const i of items) groups.get(classify(i).id)!.push(i)

  const selected = sp.type && groups.has(sp.type) ? sp.type : null
  const selectedArch = selected ? ARCHETYPES.find((a) => a.id === selected)! : null
  const selectedItems = selected
    ? [...groups.get(selected)!].sort((a, b) => b.final - a.final)
    : []

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold">아키타입 지도</h1>
          <p className="text-sm text-gray-500 mt-1">
            4점수 벡터(trend·commerce·supplier·competition)를 전략 유형으로 압축 —{' '}
            {items.length}개 분류상품을 행동 버킷으로 라우팅
          </p>
        </div>
        <Link href="/admin/trend-radar/opportunity" className="text-sm text-gray-700 hover:text-black underline">
          기회 점수(2축) →
        </Link>
      </header>

      {items.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500">
          아직 데이터 없음. cron 누적 후 다시 방문.
        </div>
      ) : (
        <>
          {/* 액션 요약 */}
          <section className="flex flex-wrap gap-2 text-sm">
            {(['go', 'source', 'watch', 'skip'] as ActionTone[]).map((tone) => {
              const count = ARCHETYPES.filter((a) => a.tone === tone).reduce(
                (n, a) => n + groups.get(a.id)!.length,
                0,
              )
              const label = { go: '즉시등록', source: '소싱/테스트', watch: '관망', skip: '스킵' }[tone]
              return (
                <span key={tone} className={`px-3 py-1 rounded-full ${TONE_STYLE[tone].chip}`}>
                  {label} {count}
                </span>
              )
            })}
          </section>

          {/* 아키타입 카드 그리드 */}
          <section className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {ARCHETYPES.map((a) => {
              const g = groups.get(a.id)!
              const avgFinal = g.length ? Math.round(g.reduce((n, i) => n + i.final, 0) / g.length) : 0
              const top3 = [...g].sort((x, y) => y.final - x.final).slice(0, 3)
              const isSel = selected === a.id
              return (
                <Link
                  key={a.id}
                  href={isSel ? '/admin/trend-radar/archetypes' : `/admin/trend-radar/archetypes?type=${a.id}`}
                  scroll={false}
                  className={`block rounded-lg border p-4 transition-colors ${TONE_STYLE[a.tone].card} ${
                    isSel ? 'ring-2 ring-offset-1 ring-gray-900' : 'hover:brightness-[0.98]'
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="font-semibold leading-tight">
                      <span className="mr-1">{a.emoji}</span>
                      {a.label}
                    </div>
                    <span className={`shrink-0 text-xs px-2 py-0.5 rounded-full ${TONE_STYLE[a.tone].chip}`}>
                      {a.action}
                    </span>
                  </div>
                  <div className="text-xs text-gray-600 mt-1">{a.desc}</div>

                  <div className="flex items-baseline gap-3 mt-3">
                    <div className="text-3xl font-bold">{g.length}</div>
                    <div className="text-xs text-gray-500">개 · 평균 final {avgFinal}</div>
                  </div>

                  {top3.length > 0 && (
                    <ul className="mt-2 space-y-0.5">
                      {top3.map((i) => (
                        <li key={i.id} className="text-xs text-gray-700 flex justify-between gap-2">
                          <span className="truncate">{i.name}</span>
                          <span className="font-mono text-gray-500 shrink-0">{i.final}</span>
                        </li>
                      ))}
                    </ul>
                  )}

                  <div className="text-xs text-gray-500 mt-3 pt-2 border-t border-black/5">
                    👉 {a.playbook}
                  </div>
                </Link>
              )
            })}
          </section>

          {/* 드릴다운 리스트 */}
          {selectedArch && (
            <section className="rounded-lg border border-gray-200 p-4">
              <div className="flex items-baseline justify-between mb-3">
                <h2 className="font-semibold">
                  {selectedArch.emoji} {selectedArch.label}{' '}
                  <span className="text-sm font-normal text-gray-500 ml-1">
                    {selectedItems.length}개 · {selectedArch.action}
                  </span>
                </h2>
                <Link href="/admin/trend-radar/archetypes" className="text-xs text-gray-500 hover:text-black underline">
                  닫기 ✕
                </Link>
              </div>
              <div className="grid grid-cols-12 text-xs text-gray-500 px-3 py-1">
                <div className="col-span-4">상품명</div>
                <div className="col-span-1 text-right">final</div>
                <div className="col-span-1 text-right">trend</div>
                <div className="col-span-1 text-right">comm</div>
                <div className="col-span-1 text-right">supp</div>
                <div className="col-span-1 text-right">comp</div>
                <div className="col-span-3 text-right">category</div>
              </div>
              <div className="space-y-1">
                {selectedItems.map((i) => (
                  <Link
                    key={i.id}
                    href={`/admin/trend-radar/products/${i.id}`}
                    className="grid grid-cols-12 px-3 py-2 rounded border border-gray-100 hover:bg-gray-50 transition-colors text-sm"
                  >
                    <div className="col-span-4 font-medium truncate">{i.name}</div>
                    <div className="col-span-1 text-right font-mono font-bold">{i.final}</div>
                    <div className="col-span-1 text-right font-mono text-gray-600">{i.trend}</div>
                    <div className="col-span-1 text-right font-mono text-gray-600">{i.commerce}</div>
                    <div className="col-span-1 text-right font-mono text-gray-600">{i.supplier}</div>
                    <div className="col-span-1 text-right font-mono text-gray-600">{i.competition}</div>
                    <div className="col-span-3 text-right text-xs text-gray-500">{i.category}</div>
                  </Link>
                ))}
              </div>
            </section>
          )}
        </>
      )}
    </div>
  )
}
