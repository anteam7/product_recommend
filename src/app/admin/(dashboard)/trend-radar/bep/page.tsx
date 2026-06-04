import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

// ─────────────────────────────────────────────────────────────
// 광고비 회수 손익분기 판매량(BEP) 게이트
//
//   단위 순마진  = 판매가 − 도매원가 − 쿠팡수수료 − 부가세
//   단위 획득비  = CPC ÷ 전환율            (검색광고 클릭→구매 환산)
//   BEP 유닛     = (초기광고예산 + 고정비) ÷ (단위 순마진 − 단위 획득비)
//   도달여유배수 = 추정 월수요 ÷ BEP 유닛
//
//   단위 순마진 ≤ 0  → 광고 자체 불가, 즉시 컷
//   여유배수 < 1 적색(회수불가) · 1~2 황색 · 2~3 라임 · ≥3 녹색
//
// 어드민 입력 상수는 query param 으로 받아 즉시 시뮬레이션한다.
// (판매가는 도매원가 × 마크업 가정. 카테고리 수수료율은 아래 FEE_BY_CATEGORY.)
// ─────────────────────────────────────────────────────────────

// 뷰 jimscanner_trends_bep_gate (supabase/trends_bep_gate.sql) — generated 타입 미반영, `as any`
interface BepGateRow {
  product_id: string
  canonical_name: string
  category_top: string
  category_mid: string | null
  brand: string | null
  trend_score: number
  commerce_score: number
  competition_score: number
  final_score: number
  volume_relative: number | null
  supplier_price_krw: number
  supplier_source: string | null
  supplier_moq: number | null
  supplier_lead_time_days: number | null
}

// 카테고리 top 별 쿠팡 판매수수료율 (결제비 포함). 기본 0.106 = 기타영양제(73137).
const FEE_BY_CATEGORY: Record<string, number> = {
  health: 0.106,
  living: 0.108,
  digital: 0.078,
}
const DEFAULT_FEE_RATE = 0.106
const VAT_DIVISOR = 11 // 부가세 = 판매가 / 11 (10/110)

interface Constants {
  adBudget: number // 초기 광고예산 (원)
  fixedCost: number // 고정비 (원, 상세이미지·등록 인건비 등)
  cpc: number // 클릭당비용 (원)
  convRate: number // 전환율 (0~1)
  markup: number // 판매가 = 도매원가 × markup
  demandAt100: number // trend_score 100 일 때 추정 월수요(개)
}

const DEFAULTS: Constants = {
  adBudget: 100_000,
  fixedCost: 50_000,
  cpc: 400,
  convRate: 0.025,
  markup: 2.6,
  demandAt100: 300,
}

interface Computed extends BepGateRow {
  sellPrice: number
  feeRate: number
  unitFee: number
  unitVat: number
  unitNetMargin: number
  unitAcqCost: number
  bepUnits: number | null // null = 마진 음수 또는 획득비≥마진 → 회수 불가
  estMonthlyDemand: number
  reachMultiple: number | null
  verdict: 'cut' | 'unreachable' | 'red' | 'yellow' | 'lime' | 'green'
}

function compute(row: BepGateRow, c: Constants): Computed {
  const cost = Number(row.supplier_price_krw)
  const sellPrice = Math.round((cost * c.markup) / 10) * 10
  const feeRate = FEE_BY_CATEGORY[row.category_top] ?? DEFAULT_FEE_RATE
  const unitFee = sellPrice * feeRate
  const unitVat = sellPrice / VAT_DIVISOR
  const unitNetMargin = sellPrice - cost - unitFee - unitVat
  const unitAcqCost = c.convRate > 0 ? c.cpc / c.convRate : Infinity

  // 추정 월수요: volume_relative(0~100) 있으면 우선, 없으면 trend_score 로 대체. 선형 스케일.
  const demandSignal = row.volume_relative != null ? Number(row.volume_relative) : Number(row.trend_score)
  const estMonthlyDemand = Math.max(0, (demandSignal / 100) * c.demandAt100)

  const contributionPerUnit = unitNetMargin - unitAcqCost

  let bepUnits: number | null = null
  let reachMultiple: number | null = null
  let verdict: Computed['verdict']

  if (unitNetMargin <= 0) {
    verdict = 'cut' // 광고 이전에 단위마진부터 음수 → 진입 불가
  } else if (contributionPerUnit <= 0) {
    verdict = 'unreachable' // 마진은 있으나 1개 팔 때마다 손해 → 회수 수학적 불가
  } else {
    bepUnits = (c.adBudget + c.fixedCost) / contributionPerUnit
    reachMultiple = bepUnits > 0 ? estMonthlyDemand / bepUnits : null
    if (reachMultiple == null || reachMultiple < 1) verdict = 'red'
    else if (reachMultiple < 2) verdict = 'yellow'
    else if (reachMultiple < 3) verdict = 'lime'
    else verdict = 'green'
  }

  return {
    ...row,
    sellPrice,
    feeRate,
    unitFee,
    unitVat,
    unitNetMargin,
    unitAcqCost,
    bepUnits,
    estMonthlyDemand,
    reachMultiple,
    verdict,
  }
}

async function fetchRows(): Promise<{ rows: BepGateRow[]; error: string | null }> {
  const sb = createAdminClient()
  const { data, error } = await sb
    .from('jimscanner_trends_bep_gate' as never)
    .select('*')
    .order('trend_score', { ascending: false })
    .limit(500)
  if (error) return { rows: [], error: error.message }
  return { rows: (data ?? []) as unknown as BepGateRow[], error: null }
}

function num(v: string | undefined, fallback: number): number {
  if (v == null || v === '') return fallback
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

const VERDICT_STYLE: Record<Computed['verdict'], { row: string; chip: string; label: string }> = {
  cut: { row: 'border-gray-300 bg-gray-100 opacity-70', chip: 'bg-gray-700 text-white', label: '⛔ 마진 음수 — 컷' },
  unreachable: { row: 'border-gray-400 bg-gray-100 opacity-80', chip: 'bg-gray-800 text-white', label: '⛔ 획득비>마진 — 회수불가' },
  red: { row: 'border-red-300 bg-red-50', chip: 'bg-red-600 text-white', label: '🔴 회수불가 (<1)' },
  yellow: { row: 'border-amber-300 bg-amber-50', chip: 'bg-amber-500 text-white', label: '🟡 빠듯 (1~2)' },
  lime: { row: 'border-lime-300 bg-lime-50', chip: 'bg-lime-600 text-white', label: '🟢 여유 (2~3)' },
  green: { row: 'border-emerald-300 bg-emerald-50', chip: 'bg-emerald-600 text-white', label: '✅ 충분 (≥3)' },
}

function won(n: number): string {
  return Math.round(n).toLocaleString() + '원'
}

export default async function BepGatePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const sp = await searchParams
  const c: Constants = {
    adBudget: num(sp.ad, DEFAULTS.adBudget),
    fixedCost: num(sp.fixed, DEFAULTS.fixedCost),
    cpc: num(sp.cpc, DEFAULTS.cpc),
    convRate: num(sp.conv, DEFAULTS.convRate),
    markup: num(sp.markup, DEFAULTS.markup),
    demandAt100: num(sp.demand, DEFAULTS.demandAt100),
  }

  const { rows, error } = await fetchRows()
  const computed = rows.map((r) => compute(r, c)).sort((a, b) => {
    // 도달여유배수 내림차순, null(컷/회수불가)은 맨 아래
    const av = a.reachMultiple ?? -1
    const bv = b.reachMultiple ?? -1
    return bv - av
  })

  const counts = {
    total: computed.length,
    green: computed.filter((r) => r.verdict === 'green').length,
    lime: computed.filter((r) => r.verdict === 'lime').length,
    yellow: computed.filter((r) => r.verdict === 'yellow').length,
    dead: computed.filter((r) => r.verdict === 'red' || r.verdict === 'cut' || r.verdict === 'unreachable').length,
  }
  const unitAcq = c.convRate > 0 ? c.cpc / c.convRate : Infinity

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold">🎯 광고비 회수 BEP 게이트</h1>
          <p className="text-sm text-gray-500 mt-1">
            단위 순마진으로 초기 광고비를 회수하는 데 필요한 판매량(BEP)을 역산하고, 트렌드 신호 추정 월수요로 도달 가능성을 게이팅
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      {/* 가정 입력 (query param 시뮬레이션) */}
      <form method="get" className="rounded border border-gray-200 px-4 py-3">
        <div className="text-xs font-semibold text-gray-700 mb-2">가정 상수 (어드민 입력)</div>
        <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
          <Field name="ad" label="초기 광고예산(원)" value={c.adBudget} />
          <Field name="fixed" label="고정비(원)" value={c.fixedCost} />
          <Field name="cpc" label="CPC(원)" value={c.cpc} />
          <Field name="conv" label="전환율(0~1)" value={c.convRate} step="0.005" />
          <Field name="markup" label="판매가 마크업(×)" value={c.markup} step="0.1" />
          <Field name="demand" label="월수요@score100(개)" value={c.demandAt100} />
        </div>
        <div className="flex items-center gap-3 mt-3">
          <button type="submit" className="px-3 py-1.5 text-xs rounded bg-black text-white font-semibold hover:bg-gray-800">
            적용
          </button>
          <span className="text-xs text-gray-500">
            단위 획득비 = CPC ÷ 전환율 = <strong>{Number.isFinite(unitAcq) ? won(unitAcq) : '∞'}</strong>
          </span>
        </div>
      </form>

      {/* KPI */}
      <section className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <Kpi label="후보(도매가+점수)" value={counts.total} />
        <Kpi label="✅ 충분 ≥3" value={counts.green} tone="emerald" />
        <Kpi label="🟢 여유 2~3" value={counts.lime} tone="lime" />
        <Kpi label="🟡 빠듯 1~2" value={counts.yellow} tone="amber" />
        <Kpi label="⛔ 컷/회수불가" value={counts.dead} tone="gray" />
      </section>

      {error && (
        <div className="rounded border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800">
          뷰 조회 에러: <code className="font-mono text-xs">{error}</code>
          <p className="text-xs mt-2 text-red-700">
            뷰 <code>jimscanner_trends_bep_gate</code> 미적용 가능성. <code>supabase/trends_bep_gate.sql</code> 적용 필요.
          </p>
        </div>
      )}

      {!error && computed.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500 space-y-2">
          <div className="text-base font-medium">표시할 후보 없음</div>
          <div className="text-xs text-gray-400">
            score + 도매가(price_krw)가 모두 있는 product 만 표시됨. 트렌드 cron / supplier 수집 누적 후 다시 방문.
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          {computed.map((r, i) => {
            const st = VERDICT_STYLE[r.verdict]
            return (
              <div key={r.product_id} className={`rounded border p-3 ${st.row}`}>
                <div className="flex items-start gap-3">
                  <div className="w-8 text-center text-sm font-mono text-gray-400 pt-1">{i + 1}</div>
                  <div className="flex-1 min-w-0 space-y-1">
                    <div className="text-sm font-medium leading-snug" title={r.canonical_name}>
                      {r.canonical_name}
                    </div>
                    <div className="text-xs text-gray-500">
                      {r.category_top}
                      {r.category_mid ? ` · ${r.category_mid}` : ''} · 도매 {r.supplier_source ?? '?'} {won(r.supplier_price_krw)}
                      {r.supplier_moq ? ` · MOQ ${r.supplier_moq}` : ''}
                    </div>
                    <div className="flex flex-wrap gap-2 text-[11px] pt-1 font-mono text-gray-600">
                      <span className="bg-white/60 border border-gray-200 px-2 py-0.5 rounded">
                        판매가 {won(r.sellPrice)} (×{c.markup})
                      </span>
                      <span className="bg-white/60 border border-gray-200 px-2 py-0.5 rounded">
                        수수료 {(r.feeRate * 100).toFixed(1)}% {won(r.unitFee)}
                      </span>
                      <span className="bg-white/60 border border-gray-200 px-2 py-0.5 rounded">
                        부가세 {won(r.unitVat)}
                      </span>
                      <span
                        className={`px-2 py-0.5 rounded border ${
                          r.unitNetMargin > 0 ? 'bg-white/60 border-gray-200' : 'bg-red-100 border-red-300 text-red-700'
                        }`}
                      >
                        단위순마진 {won(r.unitNetMargin)}
                      </span>
                      <span className="bg-white/60 border border-gray-200 px-2 py-0.5 rounded">
                        획득비 {Number.isFinite(r.unitAcqCost) ? won(r.unitAcqCost) : '∞'}
                      </span>
                    </div>
                  </div>

                  <div className="text-right flex-shrink-0 space-y-1 w-44">
                    <div className={`inline-block text-[10px] px-2 py-0.5 rounded font-semibold ${st.chip}`}>
                      {st.label}
                    </div>
                    <div className="text-2xl font-bold font-mono">
                      {r.reachMultiple != null ? `${r.reachMultiple.toFixed(1)}×` : '—'}
                    </div>
                    <div className="text-[10px] text-gray-500 font-mono space-y-0.5">
                      <div>BEP {r.bepUnits != null ? `${Math.ceil(r.bepUnits).toLocaleString()}개` : '∞'}</div>
                      <div>추정월수요 {Math.round(r.estMonthlyDemand).toLocaleString()}개</div>
                      <div>trend {Number(r.trend_score).toFixed(0)}</div>
                    </div>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* 공식 설명 */}
      <section className="text-xs text-gray-500 border-t border-gray-200 pt-4 space-y-1">
        <div className="font-semibold text-gray-700">📐 BEP 게이트 공식</div>
        <code className="block bg-gray-50 px-3 py-2 rounded font-mono text-[11px] leading-relaxed">
          단위순마진 = 판매가 − 도매원가 − 수수료(카테고리율) − 부가세(판매가/11)
          <br />
          단위획득비 = CPC ÷ 전환율
          <br />
          BEP유닛 = (초기광고예산 + 고정비) ÷ (단위순마진 − 단위획득비)
          <br />
          도달여유배수 = 추정월수요 ÷ BEP유닛 · (추정월수요 = (volume_relative|trend_score)/100 × 월수요@100)
        </code>
        <div className="pt-2">
          <strong>해석:</strong> 여유배수 ≥3 충분 · 2~3 여유 · 1~2 빠듯 · &lt;1 회수불가. 단위순마진이 음수면 광고 이전에 컷.
          판매가는 도매원가×마크업 가정이며 실제 등록가/실측 CPC·전환율로 보정 시 정밀도 상승.
        </div>
      </section>
    </div>
  )
}

function Field({
  name,
  label,
  value,
  step,
}: {
  name: string
  label: string
  value: number
  step?: string
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[10px] text-gray-500">{label}</span>
      <input
        type="number"
        name={name}
        defaultValue={value}
        step={step}
        className="w-full rounded border border-gray-300 px-2 py-1 text-xs font-mono"
      />
    </label>
  )
}

function Kpi({
  label,
  value,
  tone = 'gray',
}: {
  label: string
  value: number | string
  tone?: 'emerald' | 'lime' | 'amber' | 'gray'
}) {
  const toneCls: Record<string, string> = {
    emerald: 'border-emerald-300 bg-emerald-50 text-emerald-700',
    lime: 'border-lime-300 bg-lime-50 text-lime-700',
    amber: 'border-amber-300 bg-amber-50 text-amber-700',
    gray: 'border-gray-200',
  }
  return (
    <div className={`rounded border p-3 ${toneCls[tone]}`}>
      <div className="text-xs text-gray-500">{label}</div>
      <div className="text-2xl font-bold mt-1">{typeof value === 'number' ? value.toLocaleString() : value}</div>
    </div>
  )
}
