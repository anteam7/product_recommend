/**
 * 모방 클리프 추적기 — supply-side commoditization 반감기 산출.
 *
 * 입력: 시계열 (observed_at, serp_listing_count) 관측치
 * 출력:
 *   - growth_rate_per_day (지수 fit 의 k)
 *   - doubling_days (listing 수가 2배 되는 데 걸리는 일수)
 *   - imitation_half_life_days (1/k * ln2 — 보수적으로 정의: 시장점유 반감기)
 *   - entry_window_days (현재 listing 수에서 saturation_count 까지 남은 일수 추정)
 *   - dday_label / severity ('safe' | 'narrow' | 'closing')
 *
 * 지수 fit 은 단순 log-linear regression 사용 (의존성 추가 없음).
 */

export type ImitationObservation = {
  observed_at: string // ISO timestamp
  serp_listing_count: number
}

export type ImitationDecayResult = {
  observations: number
  start_at: string | null
  latest_count: number
  latest_at: string | null
  // 지수 fit: count(t) = a * exp(k * t_days)
  fit_a: number | null
  fit_k_per_day: number | null
  doubling_days: number | null
  imitation_half_life_days: number | null
  entry_window_days: number | null // saturation 까지 추정 일수
  dday_label: string
  severity: 'safe' | 'narrow' | 'closing' | 'unknown'
  saturation_count: number
}

/**
 * saturation_count: SERP 1페이지(40개) 기준. 카피캣이 이 수치에 도달하면 진입 윈도우 종료로 간주.
 */
const DEFAULT_SATURATION = 40

export function computeImitationDecay(
  observations: ImitationObservation[],
  opts: { saturation?: number } = {},
): ImitationDecayResult {
  const saturation = opts.saturation ?? DEFAULT_SATURATION
  const empty: ImitationDecayResult = {
    observations: observations.length,
    start_at: null,
    latest_count: 0,
    latest_at: null,
    fit_a: null,
    fit_k_per_day: null,
    doubling_days: null,
    imitation_half_life_days: null,
    entry_window_days: null,
    dday_label: '데이터 부족',
    severity: 'unknown',
    saturation_count: saturation,
  }

  if (!observations || observations.length === 0) return empty

  const sorted = [...observations]
    .filter((o) => o.serp_listing_count > 0 && o.observed_at)
    .sort((a, b) => +new Date(a.observed_at) - +new Date(b.observed_at))

  if (sorted.length === 0) {
    return { ...empty, observations: 0 }
  }

  const t0 = +new Date(sorted[0].observed_at)
  const latest = sorted[sorted.length - 1]
  const latestCount = latest.serp_listing_count

  if (sorted.length < 2) {
    return {
      ...empty,
      observations: sorted.length,
      start_at: sorted[0].observed_at,
      latest_count: latestCount,
      latest_at: latest.observed_at,
      dday_label: '관측 1회 (성장률 미정)',
      severity: 'unknown',
    }
  }

  // log-linear regression: y = ln(count), x = days since t0
  let n = 0
  let sumX = 0
  let sumY = 0
  let sumXY = 0
  let sumXX = 0
  for (const o of sorted) {
    const x = (+new Date(o.observed_at) - t0) / 86_400_000
    const y = Math.log(Math.max(1, o.serp_listing_count))
    n++
    sumX += x
    sumY += y
    sumXY += x * y
    sumXX += x * x
  }
  const denom = n * sumXX - sumX * sumX
  let k: number | null = null
  let a: number | null = null
  if (denom > 1e-9) {
    k = (n * sumXY - sumX * sumY) / denom
    const lnA = (sumY - k * sumX) / n
    a = Math.exp(lnA)
  }

  let doubling: number | null = null
  let halfLife: number | null = null
  let entryWindow: number | null = null

  if (k !== null && k > 0) {
    doubling = Math.log(2) / k
    halfLife = doubling // 시장점유 반감기 == 카피캣 두 배 되는 시점 (보수적 정의)
    if (latestCount > 0 && latestCount < saturation) {
      entryWindow = Math.log(saturation / latestCount) / k
    } else if (latestCount >= saturation) {
      entryWindow = 0
    }
  } else if (k !== null && k <= 0) {
    // 감소 또는 정체 — 진입 윈도우는 사실상 무제한
    entryWindow = null
  }

  let severity: ImitationDecayResult['severity'] = 'unknown'
  let label = '데이터 부족'
  if (entryWindow !== null) {
    if (entryWindow <= 3) {
      severity = 'closing'
      label = `D-${Math.max(0, Math.round(entryWindow))} (윈도우 마감 임박)`
    } else if (entryWindow <= 14) {
      severity = 'narrow'
      label = `D-${Math.round(entryWindow)} (윈도우 좁아지는 중)`
    } else {
      severity = 'safe'
      label = `D-${Math.round(entryWindow)} (여유 있음)`
    }
  } else if (k !== null && k <= 0) {
    severity = 'safe'
    label = '카피캣 정체 — 윈도우 열림'
  }

  return {
    observations: sorted.length,
    start_at: sorted[0].observed_at,
    latest_count: latestCount,
    latest_at: latest.observed_at,
    fit_a: a,
    fit_k_per_day: k,
    doubling_days: doubling,
    imitation_half_life_days: halfLife,
    entry_window_days: entryWindow,
    dday_label: label,
    severity,
    saturation_count: saturation,
  }
}

/**
 * 카테고리별 평균 half-life — 핀별 결과를 카테고리 키로 묶어서 평균.
 */
export function aggregateCategoryHalfLife(
  rows: Array<{ category_top: string; result: ImitationDecayResult }>,
): Record<string, { samples: number; avg_half_life_days: number | null }> {
  const buckets = new Map<string, number[]>()
  for (const r of rows) {
    if (r.result.imitation_half_life_days === null) continue
    if (!Number.isFinite(r.result.imitation_half_life_days)) continue
    const arr = buckets.get(r.category_top) ?? []
    arr.push(r.result.imitation_half_life_days as number)
    buckets.set(r.category_top, arr)
  }
  const out: Record<string, { samples: number; avg_half_life_days: number | null }> = {}
  for (const [cat, arr] of buckets.entries()) {
    if (arr.length === 0) {
      out[cat] = { samples: 0, avg_half_life_days: null }
    } else {
      const avg = arr.reduce((a, b) => a + b, 0) / arr.length
      out[cat] = { samples: arr.length, avg_half_life_days: avg }
    }
  }
  return out
}

/**
 * +1σ 도달 판정 — 최근 new_listings_24h 가 카테고리 평균 + 표준편차 이상이면 true.
 */
export function isImitationSpike(
  recent24h: number,
  categorySamples: number[],
): { spike: boolean; mean: number; sigma: number; threshold: number } {
  if (categorySamples.length === 0) {
    return { spike: false, mean: 0, sigma: 0, threshold: 0 }
  }
  const mean = categorySamples.reduce((a, b) => a + b, 0) / categorySamples.length
  const variance =
    categorySamples.reduce((a, b) => a + (b - mean) ** 2, 0) / categorySamples.length
  const sigma = Math.sqrt(variance)
  const threshold = mean + sigma
  return { spike: recent24h >= threshold && recent24h > 0, mean, sigma, threshold }
}
