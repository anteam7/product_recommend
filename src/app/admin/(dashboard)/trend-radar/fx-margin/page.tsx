import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import { SHIP, FEE_RATE, VAT_DIVISOR, computeMargin } from '@/lib/coupang/price'

export const dynamic = 'force-dynamic'

// ─────────────────────────────────────────────────────────────
// 환율 연동 착지원가 리프레시 + 마진 FX민감도 스트레스 보드
//
// jimscanner_trends_supplier.price_krw 는 '수집 시점 환율'로 박제된 스냅샷.
// 환율이 움직이면 그 위에서 내린 마진/위탁 결정이 조용히 틀어진다.
// 이 보드는 price_original × 현재 환율로 착지원가를 실시간 재계산하고,
// 손익분기 환율 / ±10% FX 스트레스에서 순마진이 음수로 뒤집히는 후보를 게이팅한다.
//
// SQL: supabase/trends_v4_fx_margin_rpc.sql (jimscanner_trends_fx_margin / jimscanner_fx_volatility_30d)
// 마진 상수는 src/lib/coupang/price.ts 단일 출처 — 여기서 SQL 로 중복 박제하지 않음.
// ─────────────────────────────────────────────────────────────

// 발굴 단계엔 확정 판매가가 없으므로 '착지원가 × 목표배수' 를 가정 판매가로 본다.
// (실제 등록 시 coupang-register 가 별도 계산. 여기선 FX 민감도 비교가 목적이라 일관된 가정이면 충분)
const TARGET_MARKUP = 2.5
const STRESS_LEVELS = [0.05, 0.1] // KRW ±5% / ±10%
const VOLATILITY_HIGH_COV = 1.5 // 30일 변동계수(%) 이 값 초과 시 '변동성 큰 통화 의존' 감점

interface FxRow {
  supplier_id: string
  product_id: string
  canonical_name: string | null
  category_top: string | null
  supplier_source: string
  supplier_url: string | null
  title: string | null
  price_currency: string
  price_original: number | null
  price_krw_snapshot: number | null
  current_rate_krw: number | null
  snapshot_rate_krw: number | null
  landed_cost_now: number | null
  stale_delta_pct: number | null
  collected_at: string
}

interface VolRow {
  currency: string
  sample_count: number
  avg_rate: number | null
  stddev_rate: number | null
  cov_pct: number | null
  min_rate: number | null
  max_rate: number | null
}

interface Computed extends FxRow {
  landedNow: number | null
  listPrice: number | null
  marginNow: number | null
  marginPctNow: number | null
  breakevenRate: number | null
  rateHeadroomPct: number | null // (breakeven - current)/current — 양수일수록 안전
  stress: { level: number; landed: number; margin: number; negative: boolean }[]
  fxVulnerable: boolean
  covPct: number | null
  highVolatility: boolean
  riskScore: number // 0(안전)~100(위험)
}

// 손익분기 착지원가: margin=0 → land = list − ship − fee − vat
// fee = list×FEE_RATE, vat = list/VAT_DIVISOR
function breakevenLandedCost(listPrice: number): number {
  return listPrice * (1 - FEE_RATE - 1 / VAT_DIVISOR) - SHIP
}

async function fetchBoard(): Promise<{ rows: Computed[]; error: string | null }> {
  const sb = createAdminClient()

  // RPC 는 마이그레이션 후 존재 — 타입 생성 전이라 as any 캐스팅
  const [fxRes, volRes] = await Promise.all([
    (sb.rpc as any)('jimscanner_trends_fx_margin', { result_limit: 500 }),
    (sb.rpc as any)('jimscanner_fx_volatility_30d'),
  ])

  if (fxRes.error) return { rows: [], error: fxRes.error.message }

  const fxRows = (fxRes.data ?? []) as FxRow[]
  const volRows = (volRes.data ?? []) as VolRow[]
  const volByCurrency = new Map(volRows.map((v) => [v.currency, v]))

  const rows: Computed[] = fxRows.map((r) => {
    const landedNow = r.landed_cost_now != null ? Math.round(r.landed_cost_now) : null
    const vol = volByCurrency.get(r.price_currency)
    const covPct = vol?.cov_pct ?? null
    const highVolatility = covPct != null && covPct > VOLATILITY_HIGH_COV

    if (landedNow == null || r.price_original == null || r.price_original <= 0 || r.current_rate_krw == null) {
      return {
        ...r,
        landedNow,
        listPrice: null,
        marginNow: null,
        marginPctNow: null,
        breakevenRate: null,
        rateHeadroomPct: null,
        stress: [],
        fxVulnerable: r.current_rate_krw == null, // 환율 미설정 통화 = 판단불가 → 취약 취급
        covPct,
        highVolatility,
        riskScore: r.current_rate_krw == null ? 90 : 50,
      }
    }

    const listPrice = Math.round(landedNow * TARGET_MARKUP)
    const m = computeMargin(listPrice, landedNow)

    const beLanded = breakevenLandedCost(listPrice)
    const breakevenRate = beLanded > 0 ? +(beLanded / r.price_original).toFixed(4) : 0
    const rateHeadroomPct = +(((breakevenRate - r.current_rate_krw) / r.current_rate_krw) * 100).toFixed(2)

    // 판매가는 고정한 채 환율만 ±X% 움직였을 때의 마진 (쿠팡은 즉시 리프라이싱 불가 가정)
    const stress = STRESS_LEVELS.map((level) => {
      const stressedRate = r.current_rate_krw! * (1 + level)
      const stressedLanded = Math.round(r.price_original! * stressedRate)
      const sm = computeMargin(listPrice, stressedLanded)
      return { level, landed: stressedLanded, margin: sm.margin, negative: sm.margin < 0 }
    })

    const fxVulnerable = stress.some((s) => s.negative) || m.margin < 0

    // 위험 점수: stale gap + 손익분기 여유 부족 + 변동성
    let riskScore = 0
    riskScore += Math.min(40, Math.abs(r.stale_delta_pct ?? 0) * 4) // stale 4%당 16pt, cap 40
    if (rateHeadroomPct < 0) riskScore += 40
    else if (rateHeadroomPct < 10) riskScore += 25
    else if (rateHeadroomPct < 20) riskScore += 12
    if (fxVulnerable) riskScore += 20
    if (highVolatility) riskScore += 12
    riskScore = Math.min(100, Math.round(riskScore))

    return {
      ...r,
      landedNow,
      listPrice,
      marginNow: m.margin,
      marginPctNow: m.marginPct,
      breakevenRate,
      rateHeadroomPct,
      stress,
      fxVulnerable,
      covPct,
      highVolatility,
      riskScore,
    }
  })

  rows.sort((a, b) => b.riskScore - a.riskScore)
  return { rows, error: null }
}

function won(n: number | null | undefined): string {
  if (n == null) return '—'
  return n.toLocaleString('ko-KR') + '원'
}

function pct(n: number | null | undefined): string {
  if (n == null) return '—'
  return (n > 0 ? '+' : '') + n.toFixed(1) + '%'
}

function riskBg(score: number): string {
  if (score >= 70) return 'bg-red-50'
  if (score >= 45) return 'bg-orange-50'
  if (score >= 25) return 'bg-yellow-50'
  return 'bg-green-50'
}

function riskDot(score: number): string {
  if (score >= 70) return 'bg-red-500'
  if (score >= 45) return 'bg-orange-500'
  if (score >= 25) return 'bg-yellow-500'
  return 'bg-green-500'
}

export default async function FxMarginPage() {
  const { rows, error } = await fetchBoard()

  const vulnerable = rows.filter((r) => r.fxVulnerable).length
  const staleHeavy = rows.filter((r) => Math.abs(r.stale_delta_pct ?? 0) >= 5).length

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold">FX 마진 스트레스 보드</h1>
          <p className="mt-1 text-sm text-gray-500">
            착지원가 = 해외 도매가(원본) × <b>현재</b> 환율로 실시간 재계산 · stale Δ = 박제가 대비 갭 ·
            손익분기 환율 초과 / KRW ±10% 스트레스에서 마진 음수면 <b className="text-red-600">FX취약</b> 게이팅
          </p>
          <p className="mt-1 text-xs text-gray-400">
            가정 판매가 = 착지원가 × {TARGET_MARKUP} · 마진 상수 FEE {(FEE_RATE * 100).toFixed(1)}% / 배송 {won(SHIP)} (coupang/price.ts 단일 출처)
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 underline hover:text-black">
          ← 대시보드
        </Link>
      </header>

      {error ? (
        <div className="rounded border border-red-300 bg-red-50 p-4 text-sm text-red-700">
          RPC 호출 실패: {error}
          <div className="mt-1 text-xs text-red-500">
            supabase/trends_v4_fx_margin_rpc.sql 마이그레이션이 적용됐는지 확인하세요.
          </div>
        </div>
      ) : rows.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500">
          해외(1688/알리/테무) 원본통화 supplier 후보가 아직 없음. 수집 누적 후 다시 방문.
        </div>
      ) : (
        <>
          <div className="grid grid-cols-3 gap-3">
            <div className="rounded border border-gray-200 p-4">
              <div className="text-xs text-gray-500">분석 후보</div>
              <div className="text-2xl font-bold">{rows.length}</div>
            </div>
            <div className="rounded border border-red-200 bg-red-50 p-4">
              <div className="text-xs text-red-600">FX취약 (±10% 또는 현재 마진 음수)</div>
              <div className="text-2xl font-bold text-red-700">{vulnerable}</div>
            </div>
            <div className="rounded border border-orange-200 bg-orange-50 p-4">
              <div className="text-xs text-orange-600">착지원가 stale ≥ 5%</div>
              <div className="text-2xl font-bold text-orange-700">{staleHeavy}</div>
            </div>
          </div>

          <div className="overflow-x-auto rounded border border-gray-200">
            <table className="w-full min-w-[1100px] text-sm">
              <thead className="bg-gray-50 text-left text-xs text-gray-500">
                <tr>
                  <th className="px-3 py-2">후보</th>
                  <th className="px-3 py-2 text-right">원본가</th>
                  <th className="px-3 py-2 text-right">현재 착지가</th>
                  <th className="px-3 py-2 text-right">stale Δ</th>
                  <th className="px-3 py-2 text-right">가정 판매가</th>
                  <th className="px-3 py-2 text-right">현재 마진</th>
                  <th className="px-3 py-2 text-right">손익분기 환율</th>
                  <th className="px-3 py-2 text-right">+10% 스트레스</th>
                  <th className="px-3 py-2 text-right">30일 변동성</th>
                  <th className="px-3 py-2 text-center">판정</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const stress10 = r.stress.find((s) => s.level === 0.1)
                  return (
                    <tr key={r.supplier_id} className={`border-t border-gray-100 ${riskBg(r.riskScore)}`}>
                      <td className="px-3 py-2">
                        <div className="flex items-center gap-2">
                          <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${riskDot(r.riskScore)}`} />
                          <div>
                            <Link
                              href={`/admin/trend-radar/products/${r.product_id}`}
                              className="font-medium text-gray-900 hover:underline"
                            >
                              {r.canonical_name ?? r.title ?? '?'}
                            </Link>
                            <div className="text-xs text-gray-400">
                              {r.supplier_source} · {r.price_currency}
                              {r.category_top ? ` · ${r.category_top}` : ''}
                            </div>
                          </div>
                        </div>
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {r.price_original != null ? `${r.price_original.toLocaleString()} ${r.price_currency}` : '—'}
                        <div className="text-xs text-gray-400">@{r.current_rate_krw ?? '?'}</div>
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums font-medium">{won(r.landedNow)}</td>
                      <td
                        className={`px-3 py-2 text-right tabular-nums ${
                          Math.abs(r.stale_delta_pct ?? 0) >= 5 ? 'font-semibold text-orange-600' : 'text-gray-500'
                        }`}
                      >
                        {pct(r.stale_delta_pct)}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-gray-600">{won(r.listPrice)}</td>
                      <td
                        className={`px-3 py-2 text-right tabular-nums font-medium ${
                          (r.marginNow ?? 0) < 0 ? 'text-red-600' : 'text-gray-900'
                        }`}
                      >
                        {won(r.marginNow)}
                        {r.marginPctNow != null && (
                          <div className="text-xs text-gray-400">{r.marginPctNow.toFixed(1)}%</div>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {r.breakevenRate != null ? r.breakevenRate.toLocaleString() : '—'}
                        <div
                          className={`text-xs ${
                            (r.rateHeadroomPct ?? 0) < 10 ? 'text-red-500' : 'text-gray-400'
                          }`}
                        >
                          여유 {pct(r.rateHeadroomPct)}
                        </div>
                      </td>
                      <td
                        className={`px-3 py-2 text-right tabular-nums ${
                          stress10?.negative ? 'font-semibold text-red-600' : 'text-gray-600'
                        }`}
                      >
                        {stress10 ? won(stress10.margin) : '—'}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {r.covPct != null ? (
                          <span className={r.highVolatility ? 'font-semibold text-orange-600' : 'text-gray-500'}>
                            {r.covPct.toFixed(2)}%
                          </span>
                        ) : (
                          <span className="text-gray-300">—</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-center">
                        {r.fxVulnerable ? (
                          <span className="rounded bg-red-100 px-2 py-0.5 text-xs font-semibold text-red-700">
                            FX취약
                          </span>
                        ) : r.highVolatility ? (
                          <span className="rounded bg-orange-100 px-2 py-0.5 text-xs font-medium text-orange-700">
                            변동성↑
                          </span>
                        ) : (
                          <span className="rounded bg-green-100 px-2 py-0.5 text-xs text-green-700">안정</span>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          <p className="text-xs text-gray-400">
            · stale Δ = (현재환율 − 수집시점환율) / 수집시점환율. 수집시점환율은 박제가(price_krw) ÷ 원본가 근사.
            <br />· 손익분기 환율 = 마진 0 이 되는 환율. 현재 환율이 이보다 낮을수록(여유 +%) 안전.
            <br />· +10% 스트레스 = 판매가 고정 + 환율 +10% 시 마진. 음수면 환율 상승 한 번에 적자 전환.
          </p>
        </>
      )}
    </div>
  )
}
