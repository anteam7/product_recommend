import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

// ─────────────────────────────────────────────────────────────
// 기회 만료 카운트다운 — 트렌드 잔여수명 vs 운영 리드타임 레이스 게이트
//   잔여수명(반감기 추정) − 운영 리드타임(소싱+승인+발송)
//   = '내가 지금 착수해 등록 완료되는 시점에 트렌드가 아직 살아있는가'
// ─────────────────────────────────────────────────────────────

const DEAD_FLOOR = 20 // trend_score 가 이 밑으로 떨어지면 사실상 죽은 트렌드 (0~100)
const DAY_MS = 24 * 60 * 60 * 1000

interface ScoreTS {
  product_id: string
  trend_score: number
  computed_at: string
}

interface LeadtimeCfg {
  sourcing_days: number
  approval_days: number
  shipping_days: number
  warn_pct: number
  expire_pct: number
}

type Verdict = 'late' | 'now' | 'comfortable' | 'expired' | 'growing' | 'insufficient'

interface Row {
  id: string
  name: string
  category: string
  scoreNow: number
  peak: number
  halfLifeDays: number | null // null = 성장/평탄 (추정 불가)
  remainingLifeDays: number | null
  completionDate: Date
  lifePctAtCompletion: number | null
  verdict: Verdict
}

const DEFAULT_CFG: LeadtimeCfg = {
  sourcing_days: 2,
  approval_days: 4,
  shipping_days: 2,
  warn_pct: 50,
  expire_pct: 10,
}

async function fetchData() {
  const sb = createAdminClient()

  // 운영 리드타임 설정 (단일 row). 테이블 미적용 환경에서도 동작하도록 fallback.
  let cfg: LeadtimeCfg = DEFAULT_CFG
  try {
    const { data: cfgRow } = await (sb as any)
      .from('jimscanner_ops_leadtime')
      .select('sourcing_days, approval_days, shipping_days, warn_pct, expire_pct')
      .eq('id', 'main')
      .maybeSingle()
    if (cfgRow) cfg = { ...DEFAULT_CFG, ...(cfgRow as LeadtimeCfg) }
  } catch {
    // 테이블 미존재 시 기본값 사용
  }

  const leadDays =
    Number(cfg.sourcing_days) + Number(cfg.approval_days) + Number(cfg.shipping_days)

  // trend_score 시계열 (product 별 다수 row). 최근 것부터 넉넉히.
  const { data: scores } = await sb
    .from('jimscanner_trends_scores')
    .select('product_id, trend_score, computed_at')
    .order('computed_at', { ascending: false })
    .limit(6000)

  // product 별로 묶기 (시간 오름차순 정렬)
  const byProduct = new Map<string, ScoreTS[]>()
  for (const s of (scores ?? []) as ScoreTS[]) {
    const arr = byProduct.get(s.product_id) ?? []
    arr.push(s)
    byProduct.set(s.product_id, arr)
  }

  const ids = [...byProduct.keys()]
  if (ids.length === 0) return { rows: [], cfg, leadDays }

  const { data: prods } = await sb
    .from('jimscanner_trends_products')
    .select('id, canonical_name, category_top')
    .in('id', ids)
  const byId = new Map((prods ?? []).map((p: any) => [p.id, p]))

  const now = Date.now()
  const rows: Row[] = []

  for (const [pid, seriesDesc] of byProduct) {
    const series = [...seriesDesc].sort(
      (a, b) => new Date(a.computed_at).getTime() - new Date(b.computed_at).getTime(),
    )
    const latest = series[series.length - 1]
    const scoreNow = Number(latest.trend_score)

    // peak (시계열 최대치) 와 그 시점
    let peak = scoreNow
    let peakTime = new Date(latest.computed_at).getTime()
    for (const s of series) {
      const v = Number(s.trend_score)
      if (v > peak) {
        peak = v
        peakTime = new Date(s.computed_at).getTime()
      }
    }

    const p = byId.get(pid) ?? {}
    const base = {
      id: pid,
      name: (p as any).canonical_name ?? '?',
      category: (p as any).category_top ?? 'all',
      scoreNow,
      peak,
    }

    const completionDate = new Date(now + leadDays * DAY_MS)

    // 이미 죽은 트렌드
    if (scoreNow <= DEAD_FLOOR) {
      rows.push({
        ...base,
        halfLifeDays: null,
        remainingLifeDays: 0,
        completionDate,
        lifePctAtCompletion: 0,
        verdict: 'expired',
      })
      continue
    }

    // 감쇠율 추정: peak 시점 이후의 하락분으로 지수감쇠 fit.
    //   trend_score(t) = peak * exp(-decay_rate * (t - peakTime))
    const latestTime = new Date(latest.computed_at).getTime()
    const daysSincePeak = (latestTime - peakTime) / DAY_MS

    let decayRate: number | null = null // per day
    if (daysSincePeak >= 0.5 && scoreNow < peak && scoreNow > 0) {
      decayRate = Math.log(peak / scoreNow) / daysSincePeak
    }

    // 성장/평탄 (peak == now 이거나 측정 불가) → 아직 안 식음
    if (decayRate === null || decayRate <= 0) {
      // 시계열이 1점뿐이면 추정 불가로 표시
      const insufficient = series.length < 2
      rows.push({
        ...base,
        halfLifeDays: null,
        remainingLifeDays: null,
        completionDate,
        lifePctAtCompletion: insufficient ? null : Math.round((scoreNow / peak) * 100),
        verdict: insufficient ? 'insufficient' : 'growing',
      })
      continue
    }

    const halfLifeDays = Math.log(2) / decayRate
    // DEAD_FLOOR 까지 남은 일수
    const remainingLifeDays = Math.log(scoreNow / DEAD_FLOOR) / decayRate

    // 등록완료 시점 투영 점수 & 잔여수명 %
    const projected = scoreNow * Math.exp(-decayRate * leadDays)
    const lifePctAtCompletion = Math.max(0, Math.round((projected / peak) * 100))

    let verdict: Verdict
    if (projected <= DEAD_FLOOR || lifePctAtCompletion <= cfg.expire_pct) {
      verdict = 'expired'
    } else if (lifePctAtCompletion < cfg.warn_pct) {
      verdict = 'late'
    } else if (remainingLifeDays - leadDays < leadDays) {
      // 등록완료 후 버퍼가 리드타임 1회분 미만 → 지금 착수
      verdict = 'now'
    } else {
      verdict = 'comfortable'
    }

    rows.push({
      ...base,
      halfLifeDays,
      remainingLifeDays,
      completionDate,
      lifePctAtCompletion,
      verdict,
    })
  }

  // 긴급도 순 정렬: late > now > comfortable > growing > insufficient > expired
  const urgency: Record<Verdict, number> = {
    late: 0,
    now: 1,
    comfortable: 2,
    growing: 3,
    insufficient: 4,
    expired: 5,
  }
  rows.sort((a, b) => {
    if (urgency[a.verdict] !== urgency[b.verdict]) return urgency[a.verdict] - urgency[b.verdict]
    // 같은 등급 내에서는 잔여수명 % 낮은(급한) 순
    const ap = a.lifePctAtCompletion ?? 999
    const bp = b.lifePctAtCompletion ?? 999
    return ap - bp
  })

  return { rows, cfg, leadDays }
}

const VERDICT_META: Record<Verdict, { label: string; cls: string }> = {
  late: { label: '⏰ 지금 착수해도 늦음', cls: 'bg-red-100 text-red-800 border-red-300' },
  now: { label: '🔥 지금 착수', cls: 'bg-orange-100 text-orange-800 border-orange-300' },
  comfortable: { label: '✅ 여유', cls: 'bg-green-100 text-green-800 border-green-300' },
  growing: { label: '📈 성장 중', cls: 'bg-blue-100 text-blue-800 border-blue-300' },
  insufficient: { label: '· 데이터 부족', cls: 'bg-gray-100 text-gray-500 border-gray-300' },
  expired: { label: '💀 이미 만료', cls: 'bg-gray-200 text-gray-500 border-gray-300' },
}

function fmtDate(d: Date) {
  return `${d.getMonth() + 1}/${d.getDate()}`
}

function fmtDays(n: number | null) {
  if (n === null) return '—'
  if (!isFinite(n)) return '∞'
  return `${n.toFixed(1)}일`
}

export default async function WindowPage() {
  const { rows, cfg, leadDays } = await fetchData()

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold">기회 만료 카운트다운</h1>
          <p className="text-sm text-gray-500 mt-1">
            트렌드 잔여수명(반감기 추정) − 운영 리드타임 = 지금 착수해 등록 완료되는 시점에 트렌드가 살아있는가
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      <div className="flex flex-wrap gap-3 text-sm">
        <span className="rounded border border-gray-200 bg-gray-50 px-3 py-1.5">
          운영 리드타임 <b>{leadDays}일</b>{' '}
          <span className="text-gray-400">
            (소싱 {cfg.sourcing_days} + 승인 {cfg.approval_days} + 발송 {cfg.shipping_days})
          </span>
        </span>
        <span className="rounded border border-gray-200 bg-gray-50 px-3 py-1.5">
          죽은 트렌드 기준 trend_score ≤ <b>{DEAD_FLOOR}</b>
        </span>
        <span className="rounded border border-gray-200 bg-gray-50 px-3 py-1.5 text-gray-400">
          상수는 <code>jimscanner_ops_leadtime</code> 테이블에서 보정
        </span>
      </div>

      {rows.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500">
          아직 score 시계열 데이터 없음. recompute-scores cron 누적 후 다시 방문.
        </div>
      ) : (
        <div className="overflow-x-auto rounded border border-gray-200">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-left text-gray-500">
              <tr>
                <th className="px-4 py-2 font-medium">판정</th>
                <th className="px-4 py-2 font-medium">상품</th>
                <th className="px-4 py-2 font-medium text-right">trend now / peak</th>
                <th className="px-4 py-2 font-medium text-right">반감기</th>
                <th className="px-4 py-2 font-medium text-right">잔여수명</th>
                <th className="px-4 py-2 font-medium text-right">예상 등록완료</th>
                <th className="px-4 py-2 font-medium text-right">그 시점 잔여수명%</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const m = VERDICT_META[r.verdict]
                return (
                  <tr key={r.id} className="border-t border-gray-100 hover:bg-gray-50">
                    <td className="px-4 py-2">
                      <span className={`inline-block rounded border px-2 py-0.5 text-xs font-medium ${m.cls}`}>
                        {m.label}
                      </span>
                    </td>
                    <td className="px-4 py-2">
                      <Link
                        href={`/admin/trend-radar/products/${r.id}`}
                        className="font-medium text-gray-900 hover:underline"
                      >
                        {r.name}
                      </Link>
                      <span className="ml-2 text-xs text-gray-400">{r.category}</span>
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums text-gray-600">
                      {Math.round(r.scoreNow)} / {Math.round(r.peak)}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums text-gray-600">
                      {fmtDays(r.halfLifeDays)}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums text-gray-600">
                      {fmtDays(r.remainingLifeDays)}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums text-gray-600">
                      {fmtDate(r.completionDate)}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums">
                      {r.lifePctAtCompletion === null ? (
                        <span className="text-gray-400">—</span>
                      ) : (
                        <span
                          className={
                            r.lifePctAtCompletion <= cfg.expire_pct
                              ? 'font-semibold text-red-600'
                              : r.lifePctAtCompletion < cfg.warn_pct
                                ? 'font-semibold text-orange-600'
                                : 'text-green-700'
                          }
                        >
                          {r.lifePctAtCompletion}%
                        </span>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
