import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import RepeatScatter, { type RepeatRow } from './RepeatScatter'

export const dynamic = 'force-dynamic'

interface RepeatDbRow {
  goods_no: string
  content_units: number | null
  content_per_day: number | null
  consumption_cycle_days: number | null
  est_monthly_reorder: number | null
  demand_cv: number | null
  demand_samples: number | null
  demand_stability: number | null
  demand_top_keyword: string | null
  value_per_content: number | null
  repeat_engine_score: number | null
  computed_at: string
}

interface GgsanProduct {
  goods_no: string
  title: string
  cate_label: string | null
  price_krw: number | null
  image_url: string | null
  detail_url: string | null
}

// 재구매빈도 정규화: 월 4회(=주1회 소진) 이상이면 100점에 근접.
// est_monthly_reorder 4.0 → 100, log-ish 완만 스케일.
function freqToScore(monthly: number | null): number {
  if (!monthly || monthly <= 0) return 0
  return Math.min(100, (monthly / 4) * 100)
}

async function fetchData() {
  const sb = createAdminClient()

  // jimscanner_ggsan_repeat 는 generated 타입 미반영 — 마이그레이션(supabase/ggsan_repeat_engine.sql) 후 캐스팅 제거
  const { data: repeatData, error } = await (sb as any)
    .from('jimscanner_ggsan_repeat')
    .select(
      'goods_no, content_units, content_per_day, consumption_cycle_days, est_monthly_reorder, demand_cv, demand_samples, demand_stability, demand_top_keyword, value_per_content, repeat_engine_score, computed_at',
    )
    .order('repeat_engine_score', { ascending: false })
    .limit(500)

  if (error) {
    return { rows: [] as RepeatRow[], error: error.message as string }
  }

  const repeats = (repeatData ?? []) as RepeatDbRow[]
  if (repeats.length === 0) return { rows: [] as RepeatRow[], error: null as string | null }

  const ids = repeats.map((r) => r.goods_no)
  const { data: prods } = await sb
    .from('jimscanner_ggsan_products')
    .select('goods_no, title, cate_label, price_krw, image_url, detail_url')
    .in('goods_no', ids)

  const byId = new Map(
    ((prods ?? []) as unknown as GgsanProduct[]).map((p) => [p.goods_no, p]),
  )

  const rows: RepeatRow[] = repeats.map((r) => {
    const p = byId.get(r.goods_no)
    return {
      goods_no: r.goods_no,
      title: p?.title ?? r.goods_no,
      cate_label: p?.cate_label ?? null,
      price_krw: p?.price_krw ?? null,
      image_url: p?.image_url ?? null,
      detail_url: p?.detail_url ?? null,
      consumption_cycle_days: r.consumption_cycle_days,
      est_monthly_reorder: r.est_monthly_reorder,
      demand_cv: r.demand_cv,
      demand_stability: r.demand_stability,
      demand_top_keyword: r.demand_top_keyword,
      value_per_content: r.value_per_content,
      repeat_engine_score: r.repeat_engine_score,
      x: freqToScore(r.est_monthly_reorder),
      y: r.demand_stability ?? 0,
      size: r.repeat_engine_score ?? 1,
    }
  })

  return { rows, error: null as string | null }
}

export default async function RepeatEnginePage() {
  const { rows, error } = await fetchData()

  const total = rows.length
  const cashCows = rows.filter((r) => r.x >= 50 && r.y >= 50).length
  const withCycle = rows.filter((r) => r.consumption_cycle_days != null).length
  const avgScore =
    rows.length > 0
      ? rows.reduce((s, r) => s + (r.repeat_engine_score ?? 0), 0) / rows.length
      : 0

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold">💰 재구매 엔진 점수</h1>
          <p className="text-sm text-gray-500 mt-1">
            소진주기 × 수요안정성 × 함량당가성비 — &apos;한 번 팔고 끝&apos;이 아닌 &apos;매달 재구매되는 캐시카우&apos; 발굴
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      <div className="rounded border border-indigo-200 bg-indigo-50 px-4 py-3 text-xs text-indigo-900">
        <strong>렌즈</strong> · 기존 trend/commerce/supplier/competition 스코어는 모두 &apos;신규 진입 획득&apos;만 본다.
        소모성 건기식의 본질 가치인 <strong>반복구매 LTV·수요 평활화</strong>를 측정하는 보드. 우상단(빈도↑·안정↑)이 구독형 캐시카우.
      </div>

      <section className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Kpi label="적재 상품" value={total} />
        <Kpi label="💰 캐시카우" value={cashCows} highlight={cashCows > 0} />
        <Kpi label="소진주기 추출됨" value={withCycle} />
        <Kpi label="평균 repeat_score" value={avgScore.toFixed(2)} />
      </section>

      {error && (
        <div className="rounded border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800">
          DB 에러: <code className="font-mono text-xs">{error}</code>
          <p className="text-xs mt-2 text-red-700">
            테이블 <code>jimscanner_ggsan_repeat</code> 미적용 가능성. supabase/ggsan_repeat_engine.sql 적용 →
            scripts/ggsan-repeat-engine.mjs 실행 필요.
          </p>
        </div>
      )}

      {!error && rows.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500 space-y-2">
          <div className="text-base font-medium">적재된 재구매 점수 없음</div>
          <div className="text-xs text-gray-400">
            <code>node --env-file=.env.local scripts/ggsan-repeat-engine.mjs</code> 실행 후 채워짐.
            <br />
            소진주기는 디테일 페이지 용량/정수, 수요안정성은 volume_relative 시계열 누적이 필요.
          </div>
        </div>
      ) : (
        !error && <RepeatScatter rows={rows} />
      )}

      {/* 공식 설명 */}
      <section className="text-xs text-gray-500 border-t border-gray-200 pt-4 space-y-1">
        <div className="font-semibold text-gray-700">📐 RepeatEngineScore 공식</div>
        <code className="block bg-gray-50 px-3 py-2 rounded font-mono text-[11px] leading-relaxed">
          consumption_cycle_days = content_units / content_per_day
          <br />
          est_monthly_reorder = 30 / consumption_cycle_days
          <br />
          demand_cv = stddev(volume_relative) / mean(volume_relative)
          <br />
          demand_stability = 100 × (1 − min(demand_cv, 1))
          <br />
          value_per_content = content_units / price_krw × 1000
          <br />
          repeat_engine_score = est_monthly_reorder × (demand_stability / 100) × value_factor
        </code>
        <div className="pt-2">
          1인 위탁셀러는 신규 유입보다 <strong>재구매가 운영부담 없이 복리로 쌓이는 매출원</strong>이라 ROI 가 가장 높다.
        </div>
      </section>
    </div>
  )
}

function Kpi({ label, value, highlight = false }: { label: string; value: number | string; highlight?: boolean }) {
  return (
    <div className={`rounded border p-3 ${highlight ? 'border-indigo-300 bg-indigo-50' : 'border-gray-200'}`}>
      <div className="text-xs text-gray-500">{label}</div>
      <div className={`text-2xl font-bold mt-1 ${highlight ? 'text-indigo-700' : ''}`}>
        {typeof value === 'number' ? value.toLocaleString() : value}
      </div>
    </div>
  )
}
