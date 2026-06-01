// 교차소스 리드-래그 분석 — 순수 함수 (서버에서 호출).
// 커뮤니티(선행 채팅) 시계열이 메인스트림 수요를 평균 며칠 앞서는가를 lag 교차상관으로 추정.

export interface DailyPoint {
  day: string // 'YYYY-MM-DD'
  val: number
}

export const MAX_LAG = 14

/** start~end(포함) 사이 연속 일자 배열 */
export function dayRange(start: string, end: string): string[] {
  const out: string[] = []
  const s = new Date(start + 'T00:00:00Z')
  const e = new Date(end + 'T00:00:00Z')
  for (let d = new Date(s); d <= e; d.setUTCDate(d.getUTCDate() + 1)) {
    out.push(d.toISOString().slice(0, 10))
  }
  return out
}

/** {day,val} 목록을 연속 일자축에 맞춘 number[] 로 (빈 날 0) */
export function toSeries(points: DailyPoint[], days: string[]): number[] {
  const m = new Map(points.map((p) => [p.day, p.val]))
  return days.map((d) => m.get(d) ?? 0)
}

function pearson(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length)
  if (n < 3) return 0
  let sa = 0, sb = 0
  for (let i = 0; i < n; i++) { sa += a[i]; sb += b[i] }
  const ma = sa / n, mb = sb / n
  let num = 0, da = 0, db = 0
  for (let i = 0; i < n; i++) {
    const xa = a[i] - ma, xb = b[i] - mb
    num += xa * xb
    da += xa * xa
    db += xb * xb
  }
  if (da === 0 || db === 0) return 0
  return num / Math.sqrt(da * db)
}

export interface LagResult {
  lag: number // 양수 = leading 이 target 보다 lag 일 선행
  corr: number // 최적 lag 에서의 상관계수
}

/**
 * leading 이 target 을 0~maxLag 일 앞서는 교차상관을 스캔해 최대 상관 lag 반환.
 * lag=L → leading[t] 와 target[t+L] 비교.
 */
export function bestLeadLag(leading: number[], target: number[], maxLag = MAX_LAG): LagResult {
  let best: LagResult = { lag: 0, corr: 0 }
  for (let lag = 0; lag <= maxLag; lag++) {
    const lead = leading.slice(0, leading.length - lag)
    const tgt = target.slice(lag)
    const c = pearson(lead, tgt)
    if (c > best.corr) best = { lag, corr: c }
  }
  return best
}

export interface Watch {
  token: string
  lag: number          // 학습된 선행일수
  corr: number         // 선행 상관계수
  leadRecent: number   // 커뮤니티 최근 7일 평균
  leadPrev: number     // 커뮤니티 직전 7일 평균
  mainRecent: number   // 메인스트림 최근 7일 평균
  mainPrev: number     // 메인스트림 직전 7일 평균
  surge: number        // 커뮤니티 급등 배수 (recent/prev)
  ddayDate: string | null // 학습 lag 기반 메인스트림 도달 예측일
  leading: number[]    // 커뮤니티 스파크라인
  mainstream: number[] // 메인스트림 스파크라인
}

function avg(xs: number[]): number {
  if (xs.length === 0) return 0
  return xs.reduce((s, v) => s + v, 0) / xs.length
}

function addDays(day: string, n: number): string {
  const d = new Date(day + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

/**
 * 토큰별 선행 워치리스트 산출.
 * 조건: 커뮤니티에서 최근 급등(surge≥surgeMin) + 유의미한 선행 상관(corr≥corrMin, lag≥1)
 *       + 메인스트림은 아직 평탄(mainRecent 가 mainPrev 대비 크게 안 오름).
 */
export function buildWatchlist(
  byToken: Map<string, { leading: number[]; mainstream: number[] }>,
  days: string[],
  opts: { corrMin?: number; surgeMin?: number } = {},
): Watch[] {
  const corrMin = opts.corrMin ?? 0.3
  const surgeMin = opts.surgeMin ?? 1.5
  const lastDay = days[days.length - 1]
  const out: Watch[] = []

  for (const [token, { leading, mainstream }] of byToken) {
    const { lag, corr } = bestLeadLag(leading, mainstream)
    if (lag < 1 || corr < corrMin) continue

    const leadRecent = avg(leading.slice(-7))
    const leadPrev = avg(leading.slice(-14, -7))
    const mainRecent = avg(mainstream.slice(-7))
    const mainPrev = avg(mainstream.slice(-14, -7))

    const surge = leadPrev > 0 ? leadRecent / leadPrev : leadRecent > 0 ? Infinity : 0
    // 메인스트림은 아직 평탄해야 (선행소스만 뜨는 후보)
    const mainFlat = mainPrev === 0 ? mainRecent < 1 : mainRecent / mainPrev < 1.3
    if (surge < surgeMin || leadRecent < 1 || !mainFlat) continue

    // 커뮤니티 마지막 피크일 + lag = 메인스트림 도달 예측일
    let peakIdx = leading.length - 1
    let peakVal = -Infinity
    for (let i = Math.max(0, leading.length - 7); i < leading.length; i++) {
      if (leading[i] > peakVal) { peakVal = leading[i]; peakIdx = i }
    }
    const ddayDate = days[peakIdx] ? addDays(days[peakIdx], lag) : addDays(lastDay, lag)

    out.push({
      token, lag, corr,
      leadRecent, leadPrev, mainRecent, mainPrev,
      surge: surge === Infinity ? 99 : Number(surge.toFixed(2)),
      ddayDate,
      leading, mainstream,
    })
  }

  out.sort((a, b) => b.corr * b.surge - a.corr * a.surge)
  return out
}
