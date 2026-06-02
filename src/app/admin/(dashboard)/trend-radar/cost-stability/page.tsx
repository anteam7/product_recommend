import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

// ── 도매가 변동성 게이트 ───────────────────────────────────────
// price_history 시계열을 처음으로 활용해 goods_no별 도매가 변동성을 집계,
// 수요점수(recommend final_score)와 교차해 '마진 휘발 리스크'를 라우팅한다.
//   X = 도매가 CV(변동계수)  ·  Y = 수요점수
//   고수요×저변동 = set&forget 적합  /  고수요×고변동 = 판매가 모니터링 필수
// ────────────────────────────────────────────────────────────

interface StabilityRow {
  goods_no: string
  title: string
  cate_cd: string | null
  cate_label: string | null
  price_krw: number | null
  is_imminent: boolean
  image_url: string | null
  detail_url: string | null
  n_obs: number
  avg_price: number
  stddev_price: number
  cv: number
  min_price: number
  max_price: number
  change_count: number
  max_spike_pct: number
  soldout_count: number
  first_obs: string
  last_obs: string
  spark: number[] | null
}

interface RecommendRow {
  goods_no: string
  final_score: number
}

const DAYS_OPTIONS = [
  { v: 14, label: '14일' },
  { v: 30, label: '30일 (기본)' },
  { v: 60, label: '60일' },
  { v: 90, label: '90일' },
] as const

// CV 등급 임계치 — 변동계수(표준편차/평균) 기준
const CV_CAUTION = 0.03 // 3% 이상 = 주의
const CV_DANGER = 0.08 // 8% 이상 = 위험

type Grade = 'stable' | 'caution' | 'danger'
function gradeOf(cv: number, soldout: number): Grade {
  if (cv >= CV_DANGER || soldout >= 2) return 'danger'
  if (cv >= CV_CAUTION || soldout >= 1) return 'caution'
  return 'stable'
}

const GRADE_META: Record<Grade, { label: string; badge: string; dot: string }> = {
  stable: { label: '🟢 안정', badge: 'bg-emerald-100 text-emerald-800', dot: '#10b981' },
  caution: { label: '🟡 주의', badge: 'bg-amber-100 text-amber-800', dot: '#f59e0b' },
  danger: { label: '🔴 위험', badge: 'bg-red-100 text-red-800', dot: '#ef4444' },
}

async function fetchStability(days: number) {
  const sb = createAdminClient()
  // RPC는 DB(supabase/ggsan_cost_stability_rpc.sql)에 존재하나 generated 타입 미반영 — gen:types 후 캐스팅 제거
  const { data, error } = await sb.rpc('jimscanner_ggsan_cost_stability' as never, {
    days_window: days,
    min_observations: 2,
    result_limit: 500,
  } as never)
  if (error) return { rows: [] as StabilityRow[], error: error.message }
  return { rows: (data ?? []) as StabilityRow[], error: null as string | null }
}

async function fetchDemand(days: number): Promise<Map<string, number>> {
  const sb = createAdminClient()
  const { data, error } = await sb.rpc('jimscanner_ggsan_recommend' as never, {
    days_window: days,
    min_sim: 0.2,
    min_score: 0,
    result_limit: 1000,
  } as never)
  const map = new Map<string, number>()
  if (error || !data) return map
  for (const r of data as RecommendRow[]) map.set(r.goods_no, Number(r.final_score) || 0)
  return map
}

function buildHref(override: Record<string, string | null>): string {
  const params = new URLSearchParams()
  for (const [k, v] of Object.entries(override)) if (v) params.set(k, v)
  const qs = params.toString()
  return '/admin/trend-radar/cost-stability' + (qs ? `?${qs}` : '')
}

// 인라인 스파크라인 (의존성 없이 SVG)
function Sparkline({ data, grade }: { data: number[]; grade: Grade }) {
  if (!data || data.length < 2) return <span className="text-gray-300 text-[10px]">—</span>
  const w = 88
  const h = 24
  const min = Math.min(...data)
  const max = Math.max(...data)
  const span = max - min || 1
  const pts = data
    .map((v, i) => {
      const x = (i / (data.length - 1)) * w
      const y = h - ((v - min) / span) * (h - 2) - 1
      return `${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')
  return (
    <svg width={w} height={h} className="overflow-visible">
      <polyline points={pts} fill="none" stroke={GRADE_META[grade].dot} strokeWidth={1.4} />
    </svg>
  )
}

export default async function CostStabilityPage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string; grade?: string }>
}) {
  const sp = await searchParams
  const daysIn = parseInt(sp.days ?? '30', 10)
  const days = DAYS_OPTIONS.some((d) => d.v === daysIn) ? daysIn : 30
  const gradeFilter = (['stable', 'caution', 'danger'].includes(sp.grade ?? '') ? sp.grade : '') as
    | Grade
    | ''

  const [{ rows, error }, demand] = await Promise.all([fetchStability(days), fetchDemand(days)])

  // 수요축 부착 + 등급 산정
  const enriched = rows.map((r) => {
    const cv = Number(r.cv) || 0
    const grade = gradeOf(cv, r.soldout_count)
    return { ...r, cv, grade, demand: demand.get(r.goods_no) ?? 0 }
  })

  const filtered = gradeFilter ? enriched.filter((r) => r.grade === gradeFilter) : enriched

  // KPI
  const total = enriched.length
  const dangerCount = enriched.filter((r) => r.grade === 'danger').length
  const cautionCount = enriched.filter((r) => r.grade === 'caution').length
  const stableCount = enriched.filter((r) => r.grade === 'stable').length

  // 수요 임계: 점수>0 상품들의 중앙값(없으면 0) → 고수요/저수요 구분
  const demandScores = enriched.map((r) => r.demand).filter((d) => d > 0).sort((a, b) => a - b)
  const demandMid =
    demandScores.length > 0 ? demandScores[Math.floor(demandScores.length / 2)] : 0

  // set&forget 적합 = 고수요 × 저변동(안정) / 마진 휘발 경고 = 고수요 × 고변동(위험)
  const setForget = enriched.filter((r) => r.demand >= demandMid && r.demand > 0 && r.grade === 'stable')
  const meltdownRisk = enriched.filter(
    (r) => r.demand >= demandMid && r.demand > 0 && r.grade === 'danger',
  )

  // 산점도 스케일
  const maxCv = Math.max(0.12, ...enriched.map((r) => r.cv))
  const maxDemand = Math.max(1, ...enriched.map((r) => r.demand))
  const PW = 560
  const PH = 280
  const PAD = 34

  const sorted = [...filtered].sort((a, b) => b.cv - a.cv)

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold">⚖️ 도매가 변동성 게이트</h1>
          <p className="text-sm text-gray-500 mt-1">
            price_history {days}일 시계열 × 수요점수 — 위탁 마진 휘발 리스크 보드.{' '}
            <strong>고수요×저변동 = set&amp;forget</strong> / <strong>고수요×고변동 = 판매가 모니터링 필수</strong>
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      <div className="rounded border border-sky-200 bg-sky-50 px-4 py-3 text-xs text-sky-900">
        <strong>왜 변동성인가</strong> · 위탁은 쿠팡 고정가 등록 후 도매가가 먼저 오르면 그대로 역마진.
        CV(변동계수)는 진입타이밍·환율·단위경제성과 다른 <strong>원가측 운영 리스크</strong> 축이다.
        안정 공급가 상품은 우선 소싱(set&amp;forget), 고변동 상품은 모니터링 대상으로 분리한다.
      </div>

      {/* 필터 */}
      <div className="flex flex-wrap items-center gap-4 rounded border border-gray-200 px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-500">윈도우</span>
          {DAYS_OPTIONS.map((d) => (
            <Link
              key={d.v}
              href={buildHref({ days: String(d.v), grade: gradeFilter || null })}
              className={`px-2 py-1 text-xs rounded ${days === d.v ? 'bg-sky-100 text-sky-700 font-semibold' : 'text-gray-500 hover:text-black'}`}
            >
              {d.label}
            </Link>
          ))}
        </div>
        <div className="flex items-center gap-1 border-l border-gray-200 pl-3">
          <span className="text-xs text-gray-500">등급</span>
          <Link
            href={buildHref({ days: String(days), grade: null })}
            className={`px-2 py-1 text-xs rounded ${gradeFilter === '' ? 'bg-black text-white font-semibold' : 'text-gray-500 hover:text-black'}`}
          >
            전체
          </Link>
          {(['stable', 'caution', 'danger'] as Grade[]).map((g) => (
            <Link
              key={g}
              href={buildHref({ days: String(days), grade: g })}
              className={`px-2 py-1 text-xs rounded ${gradeFilter === g ? GRADE_META[g].badge + ' font-semibold' : 'text-gray-500 hover:text-black'}`}
            >
              {GRADE_META[g].label}
            </Link>
          ))}
        </div>
      </div>

      {/* KPI */}
      <section className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <Kpi label="추적 상품 (≥2관측)" value={total} />
        <Kpi label="🟢 안정" value={stableCount} />
        <Kpi label="🟡 주의" value={cautionCount} />
        <Kpi label="🔴 위험" value={dangerCount} highlight={dangerCount > 0} />
        <Kpi label="⚠️ 마진휘발 경고" value={meltdownRisk.length} highlight={meltdownRisk.length > 0} />
      </section>

      {error && (
        <div className="rounded border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800">
          RPC 에러: <code className="font-mono text-xs">{error}</code>
          <p className="text-xs mt-2 text-red-700">
            RPC <code>jimscanner_ggsan_cost_stability</code> 미적용 가능성. supabase/ggsan_cost_stability_rpc.sql 적용 필요.
          </p>
        </div>
      )}

      {!error && total === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500 space-y-2">
          <div className="text-base font-medium">변동성 추적 데이터 없음</div>
          <div className="text-xs text-gray-400">
            price_history 에 goods_no당 2회 이상 관측이 누적돼야 CV 계산이 가능합니다.
            <br />
            ggsan collector 가 가격·재고 변동마다 jimscanner_ggsan_price_history 에 row 를 적재합니다 (수일 누적 필요).
          </div>
        </div>
      ) : (
        <>
          {/* 산점도: X=CV, Y=수요점수 */}
          <section className="rounded border border-gray-200 p-4">
            <div className="text-sm font-semibold mb-2">
              산점도 · X = 도매가 변동성(CV) → · Y = 수요점수 ↑
            </div>
            <div className="flex flex-wrap gap-6 items-start">
              <svg viewBox={`0 0 ${PW} ${PH}`} className="w-full max-w-2xl border border-gray-100 rounded">
                {/* 사분면 가이드 (수요 중앙값 / CV 주의선) */}
                {(() => {
                  const xDanger = PAD + (CV_DANGER / maxCv) * (PW - PAD * 2)
                  const xCaution = PAD + (CV_CAUTION / maxCv) * (PW - PAD * 2)
                  const yMid = PH - PAD - (demandMid / maxDemand) * (PH - PAD * 2)
                  return (
                    <g>
                      <rect x={xDanger} y={0} width={PW - xDanger} height={yMid} fill="#fef2f2" />
                      <rect x={PAD} y={0} width={xCaution - PAD} height={yMid} fill="#ecfdf5" />
                      <line x1={xCaution} y1={0} x2={xCaution} y2={PH - PAD} stroke="#d1fae5" strokeDasharray="3 3" />
                      <line x1={xDanger} y1={0} x2={xDanger} y2={PH - PAD} stroke="#fecaca" strokeDasharray="3 3" />
                      {demandMid > 0 && (
                        <line x1={PAD} y1={yMid} x2={PW - PAD} y2={yMid} stroke="#e5e7eb" strokeDasharray="3 3" />
                      )}
                      <text x={PW - 6} y={14} textAnchor="end" className="fill-red-400" fontSize={9}>
                        고수요×고변동 = 마진휘발 경고
                      </text>
                      <text x={PAD + 4} y={14} className="fill-emerald-500" fontSize={9}>
                        고수요×저변동 = set&amp;forget
                      </text>
                    </g>
                  )
                })()}
                {/* 축 */}
                <line x1={PAD} y1={PH - PAD} x2={PW - PAD} y2={PH - PAD} stroke="#9ca3af" strokeWidth={1} />
                <line x1={PAD} y1={PAD} x2={PAD} y2={PH - PAD} stroke="#9ca3af" strokeWidth={1} />
                <text x={PW - PAD} y={PH - PAD + 14} textAnchor="end" fontSize={9} className="fill-gray-500">
                  CV {(maxCv * 100).toFixed(0)}%
                </text>
                {/* 점 */}
                {enriched.map((r) => {
                  const x = PAD + (r.cv / maxCv) * (PW - PAD * 2)
                  const y = PH - PAD - (r.demand / maxDemand) * (PH - PAD * 2)
                  return (
                    <circle
                      key={r.goods_no}
                      cx={Math.min(PW - PAD, x)}
                      cy={Math.max(PAD, y)}
                      r={r.demand >= demandMid && r.demand > 0 ? 4 : 2.5}
                      fill={GRADE_META[r.grade].dot}
                      fillOpacity={0.7}
                    >
                      <title>
                        {r.title} · CV {(r.cv * 100).toFixed(1)}% · 수요 {r.demand.toFixed(1)} · 변동 {r.change_count}회
                      </title>
                    </circle>
                  )
                })}
              </svg>

              {/* 액션 라우팅 요약 */}
              <div className="text-xs space-y-3 min-w-[180px]">
                <div className="rounded border border-emerald-200 bg-emerald-50 px-3 py-2">
                  <div className="font-semibold text-emerald-800">✅ set&amp;forget 적합 {setForget.length}</div>
                  <div className="text-emerald-700 mt-0.5">고수요 × 저변동. 고정가 등록 후 방치 가능.</div>
                </div>
                <div className="rounded border border-red-200 bg-red-50 px-3 py-2">
                  <div className="font-semibold text-red-800">⚠️ 판매가 모니터링 필수 {meltdownRisk.length}</div>
                  <div className="text-red-700 mt-0.5">고수요 × 고변동. 도매가 급등 시 역마진 — 알림 대상.</div>
                </div>
                <div className="text-gray-400">
                  수요 중앙값 기준선: {demandMid.toFixed(1)} · CV 주의 {CV_CAUTION * 100}% / 위험{' '}
                  {CV_DANGER * 100}%
                </div>
              </div>
            </div>
          </section>

          {/* 정렬 테이블 */}
          <div className="text-xs text-gray-500">{sorted.length}건 · 변동성(CV) 높은순</div>
          <div className="overflow-x-auto rounded border border-gray-200">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-xs text-gray-500">
                <tr className="text-left">
                  <th className="px-3 py-2 font-medium">등급</th>
                  <th className="px-3 py-2 font-medium">상품</th>
                  <th className="px-3 py-2 font-medium text-right">CV</th>
                  <th className="px-3 py-2 font-medium text-right">변동/품절</th>
                  <th className="px-3 py-2 font-medium text-right">최대급등</th>
                  <th className="px-3 py-2 font-medium text-right">가격대</th>
                  <th className="px-3 py-2 font-medium text-right">수요</th>
                  <th className="px-3 py-2 font-medium">추이</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {sorted.map((r) => {
                  const m = GRADE_META[r.grade]
                  const hot = r.demand >= demandMid && r.demand > 0
                  return (
                    <tr key={r.goods_no} className={`hover:bg-gray-50 ${hot && r.grade === 'danger' ? 'bg-red-50/40' : ''}`}>
                      <td className="px-3 py-2 whitespace-nowrap">
                        <span className={`px-2 py-0.5 rounded text-xs font-semibold ${m.badge}`}>{m.label}</span>
                      </td>
                      <td className="px-3 py-2 max-w-xs">
                        <a
                          href={r.detail_url ?? '#'}
                          target="_blank"
                          rel="noopener"
                          className="font-medium leading-snug hover:underline line-clamp-1"
                          title={r.title}
                        >
                          {r.title}
                        </a>
                        <div className="text-xs text-gray-400">
                          {r.cate_label ?? r.cate_cd} · {r.goods_no} · {r.n_obs}관측
                          {hot && <span className="ml-1 text-amber-600 font-semibold">· 고수요</span>}
                        </div>
                      </td>
                      <td className="px-3 py-2 text-right font-mono font-semibold" style={{ color: m.dot }}>
                        {(r.cv * 100).toFixed(1)}%
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-xs text-gray-600">
                        {r.change_count}회
                        {r.soldout_count > 0 && <span className="text-red-500"> · 품절{r.soldout_count}</span>}
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-xs">
                        {r.max_spike_pct > 0 ? (
                          <span className="text-red-600">+{(r.max_spike_pct * 100).toFixed(0)}%</span>
                        ) : (
                          <span className="text-gray-300">—</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-xs text-gray-600 whitespace-nowrap">
                        {r.min_price.toLocaleString()}~{r.max_price.toLocaleString()}
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-gray-700">
                        {r.demand > 0 ? r.demand.toFixed(1) : <span className="text-gray-300">—</span>}
                      </td>
                      <td className="px-3 py-2">
                        <Sparkline data={r.spark ?? []} grade={r.grade} />
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </>
      )}

      <section className="text-xs text-gray-500 border-t border-gray-200 pt-4 space-y-1">
        <div className="font-semibold text-gray-700">📐 변동성 지표</div>
        <code className="block bg-gray-50 px-3 py-2 rounded font-mono text-[11px] leading-relaxed">
          CV(변동계수) = stddev(price) / avg(price) — 평균 대비 흔들림 정도
          <br />
          change_count = 연속 관측 간 가격이 바뀐 횟수 · max_spike = 직전 대비 최대 급등폭
          <br />
          등급: CV ≥ {CV_DANGER * 100}% 또는 품절 2회+ = 🔴위험 · CV ≥ {CV_CAUTION * 100}% 또는 품절 1회 = 🟡주의 · 그 외 🟢안정
        </code>
        <div className="pt-1">
          데이터 출처: <code>jimscanner_ggsan_price_history</code> (수집 시 가격·재고 변동마다 적재) ×{' '}
          <code>jimscanner_ggsan_recommend</code> (수요점수). 윈도우 내 2회 이상 관측된 상품만.
        </div>
      </section>
    </div>
  )
}

function Kpi({ label, value, highlight = false }: { label: string; value: number | string; highlight?: boolean }) {
  return (
    <div className={`rounded border p-3 ${highlight ? 'border-red-300 bg-red-50' : 'border-gray-200'}`}>
      <div className="text-xs text-gray-500">{label}</div>
      <div className={`text-2xl font-bold mt-1 ${highlight ? 'text-red-700' : ''}`}>
        {typeof value === 'number' ? value.toLocaleString() : value}
      </div>
    </div>
  )
}
