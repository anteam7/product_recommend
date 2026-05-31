import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

// ggsan 도매 소싱 리드타임 (주) — 피크보다 이만큼 앞서 비수기 직전에 매입.
const LEAD_WEEKS = 3

const MONTHS = ['1월', '2월', '3월', '4월', '5월', '6월', '7월', '8월', '9월', '10월', '11월', '12월']

interface SeasonRow {
  source: string
  keyword: string
  peak_month: number | null
  peak_week: number | null
  trough_month: number | null
  amplitude: number | null
  current_ratio: number | null
  current_phase: number | null
  weeks_to_peak: number | null
  monthly_curve: Array<{ month: number; ratio: number }> | null
  last_computed: string
}

/** 소싱 시급도: 계절성↑ · 현재 비수기 트로프↓ · 피크까지 ≈ 리드타임 일수록 높음 */
function sourcingUrgency(r: SeasonRow): number {
  const amp = r.amplitude ?? 1
  if (amp < 1.3) return 0 // 뚜렷한 계절성 없음 → 선점 의미 없음
  const phase = r.current_phase ?? 1 // 0 = 트로프(비수기), 1 = 피크
  const wtp = r.weeks_to_peak ?? 99
  // 리드타임 근접도: |wtp - LEAD| 가 작을수록 1 에 가깝게 (최대 8주 윈도우)
  const proximity = Math.max(0, 1 - Math.abs(wtp - LEAD_WEEKS) / 8)
  return amp * (1 - phase) * proximity
}

function cellColor(ratio: number): string {
  // 0~100 ratio → 파랑(저)→빨강(고) 연속색
  const t = Math.min(1, Math.max(0, ratio / 100))
  const r = Math.round(60 + t * 195)
  const g = Math.round(120 - t * 60)
  const b = Math.round(220 - t * 180)
  return `rgb(${r},${g},${b})`
}

async function fetchData() {
  // 신규 테이블 — 생성 타입 미반영이라 any 캐스팅 (마이그레이션 후 상태 가정)
  const sb = createAdminClient() as any
  const { data } = await sb
    .from('jimscanner_trends_seasonality')
    .select(
      'source, keyword, peak_month, peak_week, trough_month, amplitude, current_ratio, current_phase, weeks_to_peak, monthly_curve, last_computed',
    )
    .order('amplitude', { ascending: false })
    .limit(500)

  const rows = ((data ?? []) as SeasonRow[]).slice()
  rows.sort((a, b) => sourcingUrgency(b) - sourcingUrgency(a))
  return rows
}

export default async function SeasonalPage() {
  const rows = await fetchData()

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold">시즌 선점 캘린더</h1>
          <p className="mt-1 text-sm text-gray-500">
            연간 검색곡선(trailing 13개월·월별) 기반 · 진폭↑ + 현재 비수기 + 피크까지 ≈{' '}
            {LEAD_WEEKS}주(ggsan 리드타임) 인 키워드를 <b>지금 소싱</b> 으로 상단 정렬
          </p>
        </div>
        <Link
          href="/admin/trend-radar"
          className="text-sm text-gray-700 underline hover:text-black"
        >
          ← 대시보드
        </Link>
      </header>

      {rows.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500">
          아직 데이터 없음. <code>collect-naver-seasonal</code> cron 1회 실행 후 다시 방문.
        </div>
      ) : (
        <div className="overflow-x-auto rounded border border-gray-200">
          <table className="min-w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-gray-200 bg-gray-50 text-xs text-gray-600">
                <th className="sticky left-0 z-10 bg-gray-50 px-3 py-2 text-left">키워드</th>
                {MONTHS.map((m, i) => (
                  <th key={i} className="px-1 py-2 text-center font-medium">
                    {m}
                  </th>
                ))}
                <th className="px-2 py-2 text-center">진폭</th>
                <th className="px-2 py-2 text-center">현재위상</th>
                <th className="px-2 py-2 text-center">피크까지</th>
                <th className="px-3 py-2 text-center">액션</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const urgency = sourcingUrgency(r)
                const sourceNow = urgency > 0.6
                const curveByMonth = new Map(
                  (r.monthly_curve ?? []).map((c) => [c.month, c.ratio]),
                )
                return (
                  <tr
                    key={`${r.source}:${r.keyword}`}
                    className={`border-b border-gray-100 ${sourceNow ? 'bg-amber-50' : ''}`}
                  >
                    <td className="sticky left-0 z-10 max-w-[160px] truncate bg-inherit px-3 py-2 font-medium text-gray-900">
                      {r.keyword}
                    </td>
                    {MONTHS.map((_, idx) => {
                      const month = idx + 1
                      const ratio = curveByMonth.get(month)
                      const isPeak = r.peak_month === month
                      const isTrough = r.trough_month === month
                      return (
                        <td
                          key={idx}
                          className="px-0.5 py-1 text-center"
                          title={ratio != null ? `${month}월 ${ratio.toFixed(0)}` : '데이터 없음'}
                        >
                          <div
                            className={`mx-auto h-6 w-6 rounded ${
                              isPeak
                                ? 'ring-2 ring-red-500'
                                : isTrough
                                  ? 'ring-2 ring-blue-400'
                                  : ''
                            }`}
                            style={{
                              backgroundColor:
                                ratio != null ? cellColor(ratio) : 'rgb(243,244,246)',
                            }}
                          />
                        </td>
                      )
                    })}
                    <td className="px-2 py-2 text-center font-mono text-xs">
                      {r.amplitude != null ? `${r.amplitude.toFixed(1)}×` : '—'}
                    </td>
                    <td className="px-2 py-2 text-center font-mono text-xs">
                      {r.current_phase != null
                        ? `${Math.round(r.current_phase * 100)}%`
                        : '—'}
                    </td>
                    <td className="px-2 py-2 text-center font-mono text-xs">
                      {r.weeks_to_peak != null ? `${r.weeks_to_peak}주` : '—'}
                    </td>
                    <td className="px-3 py-2 text-center">
                      {sourceNow ? (
                        <span className="inline-block rounded bg-amber-500 px-2 py-1 text-xs font-semibold text-white">
                          🛒 지금 소싱
                        </span>
                      ) : urgency > 0 ? (
                        <span className="text-xs text-gray-400">관망</span>
                      ) : (
                        <span className="text-xs text-gray-300">—</span>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      <div className="flex flex-wrap gap-4 text-xs text-gray-500">
        <span>
          <span className="mr-1 inline-block h-3 w-3 rounded align-middle ring-2 ring-red-500" />
          연간 피크 월
        </span>
        <span>
          <span className="mr-1 inline-block h-3 w-3 rounded align-middle ring-2 ring-blue-400" />
          비수기(트로프) 월
        </span>
        <span>색 진하기 = 해당 월 상대 검색량(0~100)</span>
      </div>
    </div>
  )
}
