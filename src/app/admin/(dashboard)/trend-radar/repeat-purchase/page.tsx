import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

// ── 재구매 주기 추정 휴리스틱 ──────────────────────────────
// supabase/trends_repeat_purchase_view.sql 의 CASE 로직과 동기화.
// 뷰 적용 전에도 페이지가 동작하도록 TS 에 내장.
const MONTHLY_RE =
  /(영양제|비타민|유산균|루테인|오메가|콜라겐|프로틴|면도날|면도|렌즈|기저귀|물티슈|세제|세정|샴푸|치약|커피|캡슐|원두|화장지|사료|간식|건기식|보충제)/
const QUARTERLY_RE = /(필터|정수기|공기청정|칫솔|면도기헤드|렌즈세정|향수리필|디퓨저)/
const INTENT_REPEAT_RE = /(소모품|예방건강|정기|구독|반복)/

type Bucket = 'consumable' | 'durable' | 'unknown'

interface Estimated {
  id: string
  canonical_name: string
  category_top: string
  category_mid: string | null
  intent_label: string | null
  alias_count: number
  last_seen_at: string
  trend_score: number
  cycleDays: number | null
  annualRepeat: number | null
  bucket: Bucket
  ltvIndex: number
  reason: string
}

function estimate(p: {
  id: string
  canonical_name: string
  category_top: string
  category_mid: string | null
  intent_label: string | null
  alias_count: number
  last_seen_at: string
  trend_score: number
}): Estimated {
  const text = `${p.category_mid ?? ''} ${p.canonical_name ?? ''} ${p.intent_label ?? ''}`.toLowerCase()

  let cycleDays: number | null
  let reason: string
  if (p.intent_label == null) {
    cycleDays = null
    reason = '미분류 — classify 우선'
  } else if (MONTHLY_RE.test(text)) {
    cycleDays = 30
    reason = '소모품 키워드 → 월 주기'
  } else if (QUARTERLY_RE.test(text)) {
    cycleDays = 90
    reason = '소모품 키워드 → 분기 주기'
  } else if (INTENT_REPEAT_RE.test(p.intent_label)) {
    cycleDays = 30
    reason = `intent "${p.intent_label}" → 월 주기`
  } else {
    cycleDays = 365
    reason = '일회성(durable)'
  }

  const annualRepeat = cycleDays == null ? null : Math.max(1, Math.round((365 / cycleDays) * 10) / 10)
  const bucket: Bucket =
    p.intent_label == null ? 'unknown' : cycleDays != null && cycleDays <= 90 ? 'consumable' : 'durable'
  const ltvIndex = annualRepeat == null ? p.trend_score : p.trend_score * annualRepeat

  return { ...p, cycleDays, annualRepeat, bucket, ltvIndex, reason }
}

interface ScoreRow {
  product_id: string
  trend_score: number
  computed_at: string
}

async function fetchData() {
  const sb = createAdminClient()

  // 최신 score → product 별 가장 최근 trend_score
  const { data: scoreData } = await sb
    .from('jimscanner_trends_scores')
    .select('product_id, trend_score, computed_at')
    .order('computed_at', { ascending: false })
    .limit(2000)

  const latestScore = new Map<string, number>()
  for (const s of (scoreData ?? []) as ScoreRow[]) {
    if (!latestScore.has(s.product_id)) latestScore.set(s.product_id, Number(s.trend_score) || 0)
  }

  // 분류 진척용 전체/미분류 카운트
  const totalCount =
    (await sb.from('jimscanner_trends_products').select('*', { count: 'exact', head: true })).count ?? 0
  const unclassifiedCount =
    (await sb
      .from('jimscanner_trends_products')
      .select('*', { count: 'exact', head: true })
      .is('llm_classified_at', null)).count ?? 0

  // 후보 product (스코어 산출된 것 우선, 충분한 모수 확보 위해 최근 본 것 포함)
  const { data: prodData } = await sb
    .from('jimscanner_trends_products')
    .select('id, canonical_name, category_top, category_mid, intent_label, alias_count, last_seen_at')
    .order('last_seen_at', { ascending: false })
    .limit(800)

  type ProdRaw = {
    id: string
    canonical_name: string
    category_top: string
    category_mid: string | null
    intent_label: string | null
    alias_count: number
    last_seen_at: string
  }

  const estimated = ((prodData ?? []) as ProdRaw[]).map((p) =>
    estimate({ ...p, trend_score: latestScore.get(p.id) ?? 0 }),
  )

  return { estimated, totalCount, unclassifiedCount }
}

const BUCKETS: { v: string; label: string }[] = [
  { v: '', label: '전체' },
  { v: 'consumable', label: '🔁 소모품(재구매)' },
  { v: 'durable', label: '📦 일회성' },
  { v: 'unknown', label: '❓ 미상' },
]

function buildHref(bucket: string): string {
  return '/admin/trend-radar/repeat-purchase' + (bucket ? `?bucket=${bucket}` : '')
}

export default async function RepeatPurchasePage({
  searchParams,
}: {
  searchParams: Promise<{ bucket?: string }>
}) {
  const sp = await searchParams
  const bucket = sp.bucket ?? ''

  const { estimated, totalCount, unclassifiedCount } = await fetchData()

  const consumable = estimated.filter((e) => e.bucket === 'consumable')
  const durable = estimated.filter((e) => e.bucket === 'durable')
  const unknown = estimated.filter((e) => e.bucket === 'unknown')

  let rows = estimated
  if (bucket === 'consumable') rows = consumable
  else if (bucket === 'durable') rows = durable
  else if (bucket === 'unknown') rows = unknown

  rows = [...rows].sort((a, b) => b.ltvIndex - a.ltvIndex).slice(0, 100)

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold">🔁 재구매 엔진 발굴 보드</h1>
          <p className="text-sm text-gray-500 mt-1">
            소모품·정기소비 LTV 렌즈 — intent_label × 재구매 주기 추정으로 [수요 × 연 재구매수] 재랭킹
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      <div className="rounded border border-indigo-200 bg-indigo-50 px-4 py-3 text-xs text-indigo-900">
        <strong>왜 재구매 렌즈?</strong> 위탁 경제성에서 소모품(반복주문)은 도매가·마진이 같아도 누적 실수익이
        일회성 대비 압도적이다. LLM 이 이미 분류한 <code className="font-mono">intent_label</code> 을 1차 축으로,
        category_mid·상품명 키워드로 재구매 주기를 추정해 <strong>LTV 지수 = trend_score × 연 재구매수</strong> 로
        재정렬한다. (단가·마진 곱은 ggsan join 시 절대 LTV 로 환산 — 현재는 상대 지수)
      </div>

      {/* KPI */}
      <section className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Kpi label="후보 상품" value={estimated.length} hint={`전체 ${totalCount.toLocaleString()}`} />
        <Kpi label="🔁 소모품(재구매)" value={consumable.length} hint="월·분기 주기 추정" highlight={consumable.length > 0} />
        <Kpi label="📦 일회성" value={durable.length} hint="durable" />
        <Kpi
          label="❓ 미상(classify 백로그)"
          value={unknown.length}
          hint={`미분류 ${unclassifiedCount.toLocaleString()} → 환류`}
        />
      </section>

      {/* 버킷 필터 */}
      <div className="flex flex-wrap gap-1 border-y border-gray-100 py-2">
        {BUCKETS.map((b) => (
          <Link
            key={b.v}
            href={buildHref(b.v)}
            className={`px-3 py-1 text-xs rounded ${
              bucket === b.v ? 'bg-black text-white font-semibold' : 'text-gray-500 hover:text-black'
            }`}
          >
            {b.label}
          </Link>
        ))}
      </div>

      {/* 미상 버킷 안내 */}
      {bucket === 'unknown' && (
        <div className="rounded border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-900">
          intent_label 미분류 후보 — <code className="font-mono">scripts/classify-trends-llm.mjs</code> 분류 우선순위로
          환류 대상. 분류되면 자동으로 소모품/일회성 버킷에 합류한다.
        </div>
      )}

      {/* 리더보드 */}
      {rows.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500">
          조건에 맞는 후보 없음.
        </div>
      ) : (
        <div className="space-y-2">
          <div className="grid grid-cols-12 text-xs text-gray-500 px-3 py-1">
            <div className="col-span-1">#</div>
            <div className="col-span-5">상품명</div>
            <div className="col-span-2">재구매 추정</div>
            <div className="col-span-1 text-right">trend</div>
            <div className="col-span-1 text-right">연 재구매</div>
            <div className="col-span-2 text-right">LTV 지수</div>
          </div>
          {rows.map((r, i) => (
            <Link
              key={r.id}
              href={`/admin/trend-radar/products/${r.id}`}
              className={`grid grid-cols-12 items-center px-3 py-2 rounded border transition-colors ${
                r.bucket === 'consumable'
                  ? 'border-indigo-200 bg-indigo-50/40 hover:bg-indigo-50'
                  : r.bucket === 'unknown'
                    ? 'border-gray-200 bg-gray-50/60 hover:bg-gray-100'
                    : 'border-gray-200 hover:bg-gray-50'
              }`}
            >
              <div className="col-span-1 text-gray-400 font-mono">{i + 1}</div>
              <div className="col-span-5 min-w-0">
                <div className="font-medium truncate" title={r.canonical_name}>
                  {r.canonical_name}
                </div>
                <div className="text-xs text-gray-500">
                  {r.category_top}
                  {r.category_mid ? ` / ${r.category_mid}` : ''}
                  {r.intent_label && (
                    <span className="ml-1 inline-block px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 font-medium">
                      🏷 {r.intent_label}
                    </span>
                  )}
                </div>
              </div>
              <div className="col-span-2">
                <BucketBadge bucket={r.bucket} />
                <div className="text-[10px] text-gray-400 mt-0.5">{r.reason}</div>
              </div>
              <div className="col-span-1 text-right font-mono text-gray-600">{r.trend_score.toFixed(0)}</div>
              <div className="col-span-1 text-right font-mono text-gray-600">
                {r.annualRepeat != null ? `${r.annualRepeat}회` : '—'}
              </div>
              <div className="col-span-2 text-right font-mono font-bold text-indigo-700">
                {r.ltvIndex.toFixed(0)}
              </div>
            </Link>
          ))}
        </div>
      )}

      {/* 공식 설명 */}
      <section className="text-xs text-gray-500 border-t border-gray-200 pt-4 space-y-1">
        <div className="font-semibold text-gray-700">📐 재구매 LTV 지수 공식</div>
        <code className="block bg-gray-50 px-3 py-2 rounded font-mono text-[11px] leading-relaxed">
          ltv_index = trend_score × annual_repeat
          <br />
          annual_repeat = max(1, 365 / repeat_cycle_days)
          <br />
          repeat_cycle_days = 월(30) | 분기(90) | 일회성(365) — intent_label + 키워드 휴리스틱
        </code>
        <div className="pt-2">
          <strong>다음:</strong> ggsan join 으로 단가·마진 곱 → 절대 12개월 누적 실수익(원) 환산 ·
          coupang-orders 실판매 재구매 간격으로 휴리스틱 보정
        </div>
      </section>
    </div>
  )
}

function BucketBadge({ bucket }: { bucket: Bucket }) {
  if (bucket === 'consumable')
    return (
      <span className="text-xs px-2 py-0.5 rounded bg-indigo-100 text-indigo-700 font-semibold">🔁 소모품</span>
    )
  if (bucket === 'unknown')
    return <span className="text-xs px-2 py-0.5 rounded bg-gray-200 text-gray-600 font-medium">❓ 미상</span>
  return <span className="text-xs px-2 py-0.5 rounded bg-gray-100 text-gray-500">📦 일회성</span>
}

function Kpi({
  label,
  value,
  hint,
  highlight = false,
}: {
  label: string
  value: number
  hint: string
  highlight?: boolean
}) {
  return (
    <div className={`rounded border p-3 ${highlight ? 'border-indigo-300 bg-indigo-50' : 'border-gray-200'}`}>
      <div className="text-xs text-gray-500">{label}</div>
      <div className={`text-2xl font-bold mt-1 ${highlight ? 'text-indigo-700' : ''}`}>
        {value.toLocaleString()}
      </div>
      <div className="text-xs text-gray-400 mt-1">{hint}</div>
    </div>
  )
}
