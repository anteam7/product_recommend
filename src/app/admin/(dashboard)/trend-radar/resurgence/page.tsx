import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import ResurgenceSparkline from './ResurgenceSparkline'

export const dynamic = 'force-dynamic'

// 튜닝 상수 — supabase/trends_v4_resurgence.sql 과 동기화
const RESURGENCE_PARAMS = {
  PEAK_THRESHOLD: 55, // trend_score 가 이 이상이면 피크
  DORMANT_THRESHOLD: 30, // trend_score 가 이 이하로 떨어지면 휴면
  MIN_GAP_WEEKS: 3, // 최소 휴면 주수
  RECENT_WINDOW: 4, // 최근 N개 row 로 재가속 기울기 판정
  MIN_POINTS: 6, // 다봉 판정에 필요한 최소 시계열 길이
}

interface ScoreRow {
  product_id: string
  trend_score: number
  final_score: number
  computed_at: string
}

interface ResurgenceRow {
  id: string
  name: string
  category: string
  series: { t: number; v: number }[] // 스파크라인용 trend_score 시계열
  prevPeak: number // 직전(현재 제외) 최고 trend_score
  prevPeakAt: string
  troughTrend: number // 휴면 골 최저점
  currentTrend: number
  gapWeeks: number // 휴면 지속 주수
  slope: number // 최근 기울기 (재가속 강도)
  peakCount: number // 누적 피크 수 → '이번이 N번째 부활'
  final: number
  hasSupplier: boolean // 소싱 커버리지 (false = 지금 비어있는 부활 후보)
}

// 단순 봉우리 검출: 양옆보다 높고 PEAK_THRESHOLD 이상인 local max 개수
function countPeaks(values: number[], threshold: number): number {
  let peaks = 0
  for (let i = 0; i < values.length; i++) {
    const left = i > 0 ? values[i - 1] : -Infinity
    const right = i < values.length - 1 ? values[i + 1] : -Infinity
    if (values[i] >= threshold && values[i] >= left && values[i] > right) peaks++
  }
  return peaks
}

// 최소제곱 기울기 (재가속 강도)
function slopeOf(values: number[]): number {
  const n = values.length
  if (n < 2) return 0
  const meanX = (n - 1) / 2
  const meanY = values.reduce((a, b) => a + b, 0) / n
  let num = 0
  let den = 0
  for (let i = 0; i < n; i++) {
    num += (i - meanX) * (values[i] - meanY)
    den += (i - meanX) ** 2
  }
  return den === 0 ? 0 : num / den
}

async function fetchData(): Promise<{ rows: ResurgenceRow[] }> {
  const sb = createAdminClient()
  const P = RESURGENCE_PARAMS

  // 전체 시계열 (product_id 별로 펼침). 누적이 커지면 윈도우 제한 필요.
  const { data: scores } = await sb
    .from('jimscanner_trends_scores')
    .select('product_id, trend_score, final_score, computed_at')
    .order('product_id', { ascending: true })
    .order('computed_at', { ascending: true })
    .limit(20000)

  const byProduct = new Map<string, ScoreRow[]>()
  for (const s of (scores ?? []) as ScoreRow[]) {
    const arr = byProduct.get(s.product_id)
    if (arr) arr.push(s)
    else byProduct.set(s.product_id, [s])
  }

  const candidates: Omit<ResurgenceRow, 'name' | 'category' | 'hasSupplier'>[] = []

  for (const [pid, ser] of byProduct) {
    if (ser.length < P.MIN_POINTS) continue

    const values = ser.map((r) => r.trend_score)
    const recent = values.slice(-P.RECENT_WINDOW)
    const past = ser.slice(0, -P.RECENT_WINDOW) // 현재 제외 과거 구간

    if (past.length < 2) continue

    const pastValues = past.map((r) => r.trend_score)
    const prevPeakVal = Math.max(...pastValues)
    const prevPeakIdx = pastValues.indexOf(prevPeakVal)
    const trough = Math.min(...pastValues)
    const current = values[values.length - 1]
    const slope = slopeOf(recent)

    // 휴면 길이: 직전 피크 이후 DORMANT_THRESHOLD 이하로 머문 연속 주수
    let dormantPoints = 0
    for (let i = prevPeakIdx + 1; i < ser.length; i++) {
      if (ser[i].trend_score <= P.DORMANT_THRESHOLD) dormantPoints++
      else if (i >= ser.length - P.RECENT_WINDOW) break // 재가속 구간 도달
    }
    // 인접 row 간 시간차로 주수 환산 (대략)
    const peakAt = new Date(ser[prevPeakIdx].computed_at).getTime()
    const nowAt = new Date(ser[ser.length - 1].computed_at).getTime()
    const spanWeeks = Math.max(0, (nowAt - peakAt) / (1000 * 60 * 60 * 24 * 7))
    // gapWeeks: 휴면 비율 × 피크~현재 경과 주수 (근사)
    const dormRatio = ser.length - prevPeakIdx - 1 > 0 ? dormantPoints / (ser.length - prevPeakIdx - 1) : 0
    const gapWeeks = spanWeeks * dormRatio

    // 3박자 판정
    const hadPeak = prevPeakVal >= P.PEAK_THRESHOLD
    const wasDormant = trough <= P.DORMANT_THRESHOLD && gapWeeks >= P.MIN_GAP_WEEKS
    const reaccelerating = slope > 0 && current > trough + 5

    if (!(hadPeak && wasDormant && reaccelerating)) continue

    candidates.push({
      id: pid,
      series: ser.map((r) => ({ t: new Date(r.computed_at).getTime(), v: r.trend_score })),
      prevPeak: Math.round(prevPeakVal),
      prevPeakAt: ser[prevPeakIdx].computed_at,
      troughTrend: Math.round(trough),
      currentTrend: Math.round(current),
      gapWeeks: Math.round(gapWeeks * 10) / 10,
      slope: Math.round(slope * 100) / 100,
      peakCount: countPeaks(values, P.PEAK_THRESHOLD),
      final: Math.round(ser[ser.length - 1].final_score),
    })
  }

  if (candidates.length === 0) return { rows: [] }

  const ids = candidates.map((c) => c.id)

  // 상품 메타 + 소싱 커버리지(supplier 존재 여부)
  const [{ data: prods }, { data: suppliers }] = await Promise.all([
    sb.from('jimscanner_trends_products').select('id, canonical_name, category_top').in('id', ids),
    sb.from('jimscanner_trends_supplier').select('product_id').in('product_id', ids),
  ])

  const byId = new Map((prods ?? []).map((p: any) => [p.id, p]))
  const sourced = new Set((suppliers ?? []).map((r: any) => r.product_id))

  const rows: ResurgenceRow[] = candidates.map((c) => {
    const p = byId.get(c.id) ?? {}
    return {
      ...c,
      name: (p as any).canonical_name ?? '?',
      category: (p as any).category_top ?? 'all',
      hasSupplier: sourced.has(c.id),
    }
  })

  // 정렬: 소싱공백(우선 큐) → 재가속 기울기 → final
  rows.sort((a, b) => {
    if (a.hasSupplier !== b.hasSupplier) return a.hasSupplier ? 1 : -1
    if (b.slope !== a.slope) return b.slope - a.slope
    return b.final - a.final
  })

  return { rows }
}

export default async function ResurgencePage() {
  const { rows } = await fetchData()
  const gapQueue = rows.filter((r) => !r.hasSupplier)

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold">🔁 부활 상품 보드</h1>
          <p className="text-sm text-gray-500 mt-1">
            과거 피크 → ≥{RESURGENCE_PARAMS.MIN_GAP_WEEKS}주 휴면 → 현재 재가속 (다봉 패턴). 첫 유행 경쟁자가 빠진
            골든윈도우 · <span className="font-medium text-amber-600">소싱공백 후보 우선</span>
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      {rows.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500">
          아직 다봉 부활 후보 없음. 점수 시계열이 {RESURGENCE_PARAMS.MIN_POINTS}회 이상 누적되면 자연 등장.
        </div>
      ) : (
        <>
          {gapQueue.length > 0 && (
            <div className="rounded-lg border border-amber-300 bg-amber-50 p-4">
              <div className="text-sm font-semibold text-amber-800">
                🎯 지금 비어있는 부활 후보 (소싱 미연결) — {gapQueue.length}건 우선 큐
              </div>
              <p className="mt-1 text-xs text-amber-700">
                수요 재검증 끝 + 경쟁 약화 + 도매 미소싱 = 즉시 소싱 후보. ggsan 카탈로그에서 매칭 우선.
              </p>
            </div>
          )}

          <div className="overflow-hidden rounded-lg border border-gray-200">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-xs text-gray-500">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">상품</th>
                  <th className="px-3 py-2 text-center font-medium">추이 (이전 피크·휴면 골·반등)</th>
                  <th className="px-3 py-2 text-center font-medium">부활</th>
                  <th className="px-3 py-2 text-right font-medium">이전 피크</th>
                  <th className="px-3 py-2 text-right font-medium">휴면</th>
                  <th className="px-3 py-2 text-right font-medium">현재 / 기울기</th>
                  <th className="px-3 py-2 text-center font-medium">소싱</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {rows.map((r) => (
                  <tr key={r.id} className={r.hasSupplier ? '' : 'bg-amber-50/40'}>
                    <td className="px-3 py-2">
                      <Link
                        href={`/admin/trend-radar/products/${r.id}`}
                        className="font-medium text-gray-900 hover:underline"
                      >
                        {r.name}
                      </Link>
                      <div className="text-xs text-gray-400">
                        {r.category} · final {r.final}
                      </div>
                    </td>
                    <td className="px-3 py-2">
                      <ResurgenceSparkline
                        series={r.series}
                        peakThreshold={RESURGENCE_PARAMS.PEAK_THRESHOLD}
                        dormantThreshold={RESURGENCE_PARAMS.DORMANT_THRESHOLD}
                      />
                    </td>
                    <td className="px-3 py-2 text-center">
                      <span
                        className="inline-flex items-center rounded-full bg-violet-100 px-2 py-0.5 text-xs font-semibold text-violet-700"
                        title="누적 피크 횟수"
                      >
                        {r.peakCount}번째
                      </span>
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-gray-700">{r.prevPeak}</td>
                    <td className="px-3 py-2 text-right font-mono text-gray-700">
                      {r.gapWeeks}주
                      <div className="text-[10px] text-gray-400">골 {r.troughTrend}</div>
                    </td>
                    <td className="px-3 py-2 text-right font-mono">
                      <span className="text-gray-900">{r.currentTrend}</span>
                      <span className={r.slope > 0 ? 'ml-1 text-emerald-600' : 'ml-1 text-gray-400'}>
                        {r.slope > 0 ? '↑' : ''}
                        {r.slope}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-center">
                      {r.hasSupplier ? (
                        <span className="text-xs text-gray-400">연결됨</span>
                      ) : (
                        <span className="rounded bg-amber-200 px-2 py-0.5 text-xs font-medium text-amber-800">
                          공백
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  )
}
