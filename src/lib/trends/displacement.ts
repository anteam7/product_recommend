/**
 * 수요 대체(Displacement) 탐지
 * ─────────────────────────────────────────────
 * 같은 니드 공간(동일 category_mid) 안에서 trend_score 시계열이
 * 음의 상관(한쪽↑·다른쪽↓)을 보이는 '대체 페어'를 계산한다.
 *
 * 절대 velocity 만 보던 기존 점수 모델과 달리, '왜' 뜨는지를 구분한다:
 *   기존 시장을 빼앗으며 뜨는 상품 = 수요가 이미 검증된 최상의 위탁 후보.
 *
 * jimscanner_trends_displacement 테이블은 신규 마이그레이션이라
 * 생성된 supabase 타입에 아직 없음 → 쿼리에서 `as any` 캐스팅.
 */
import type { SupabaseClient } from '@supabase/supabase-js'

const DAY_MS = 24 * 60 * 60 * 1000

// 페어가 대체 관계로 인정되기 위한 임계값
const MIN_SAMPLE_POINTS = 5 // 공유 일수 최소
const ANTI_CORR_MAX = -0.5 // 이보다 더 음수여야 대체로 인정
const MIN_SLOPE_MAG = 0.5 // 기울기(점/일) 최소 크기 — 평평한 페어 배제
const MAX_PRODUCTS_PER_MID = 40 // 카테고리당 페어 폭발 방지 (n^2)

export interface DisplacementOptions {
  windowDays?: number
}

interface ScoreRow {
  product_id: string
  trend_score: number | string
  computed_at: string
}

interface ProductRow {
  id: string
  category_mid: string | null
  canonical_name: string | null
}

interface Series {
  productId: string
  // dayIndex(정수) → 그 날의 trend_score (하루 여러 건이면 최신)
  byDay: Map<number, number>
}

export interface DisplacementResult {
  status: 'ok' | 'error'
  windowDays: number
  productsConsidered: number
  pairsEvaluated: number
  pairsInserted: number
  error?: string
}

/** 피어슨 상관계수. 표준편차 0 이면 null. */
function pearson(xs: number[], ys: number[]): number | null {
  const n = xs.length
  if (n < 2) return null
  let sx = 0
  let sy = 0
  for (let i = 0; i < n; i++) {
    sx += xs[i]
    sy += ys[i]
  }
  const mx = sx / n
  const my = sy / n
  let num = 0
  let dx2 = 0
  let dy2 = 0
  for (let i = 0; i < n; i++) {
    const a = xs[i] - mx
    const b = ys[i] - my
    num += a * b
    dx2 += a * a
    dy2 += b * b
  }
  const den = Math.sqrt(dx2 * dy2)
  if (den === 0) return null
  return num / den
}

/** 최소제곱 기울기 (단위: 점 / 일). days 는 dayIndex 배열. */
function slope(days: number[], vals: number[]): number {
  const n = days.length
  if (n < 2) return 0
  let sx = 0
  let sy = 0
  for (let i = 0; i < n; i++) {
    sx += days[i]
    sy += vals[i]
  }
  const mx = sx / n
  const my = sy / n
  let num = 0
  let den = 0
  for (let i = 0; i < n; i++) {
    const dx = days[i] - mx
    num += dx * (vals[i] - my)
    den += dx * dx
  }
  if (den === 0) return 0
  return num / den
}

/**
 * displacement 페어를 계산해 jimscanner_trends_displacement 에 upsert.
 * recompute_scores cron 끝단 또는 별도 cron 에서 호출.
 */
export async function computeDisplacement(
  sb: SupabaseClient,
  opts: DisplacementOptions = {},
): Promise<DisplacementResult> {
  const windowDays = opts.windowDays ?? 14
  const sinceIso = new Date(Date.now() - windowDays * DAY_MS).toISOString()
  const nowIso = new Date().toISOString()

  // 1) window 내 모든 점수 시계열
  const { data: scores, error: scoreErr } = await sb
    .from('jimscanner_trends_scores')
    .select('product_id, trend_score, computed_at')
    .gte('computed_at', sinceIso)
    .order('computed_at', { ascending: true })
    .limit(50000)

  if (scoreErr) {
    return {
      status: 'error',
      windowDays,
      productsConsidered: 0,
      pairsEvaluated: 0,
      pairsInserted: 0,
      error: scoreErr.message,
    }
  }

  // dayIndex 기준점 (window 시작일 자정)
  const baseDay = Math.floor(new Date(sinceIso).getTime() / DAY_MS)

  // product_id → Series (하루 여러 건이면 최신값으로 덮어씀; order asc 라 마지막이 최신)
  const seriesById = new Map<string, Series>()
  for (const s of (scores ?? []) as ScoreRow[]) {
    const dayIdx = Math.floor(new Date(s.computed_at).getTime() / DAY_MS) - baseDay
    let series = seriesById.get(s.product_id)
    if (!series) {
      series = { productId: s.product_id, byDay: new Map() }
      seriesById.set(s.product_id, series)
    }
    series.byDay.set(dayIdx, Number(s.trend_score))
  }

  const productIds = [...seriesById.keys()]
  if (productIds.length === 0) {
    return { status: 'ok', windowDays, productsConsidered: 0, pairsEvaluated: 0, pairsInserted: 0 }
  }

  // 2) 상품 메타 (category_mid 로 니드 공간 그룹)
  const { data: prods, error: prodErr } = await sb
    .from('jimscanner_trends_products')
    .select('id, category_mid, canonical_name')
    .in('id', productIds)

  if (prodErr) {
    return {
      status: 'error',
      windowDays,
      productsConsidered: productIds.length,
      pairsEvaluated: 0,
      pairsInserted: 0,
      error: prodErr.message,
    }
  }

  const metaById = new Map<string, ProductRow>(
    ((prods ?? []) as ProductRow[]).map((p) => [p.id, p]),
  )

  // category_mid 별 그룹 (null/빈값은 니드 공간 불명 → 스킵)
  const groups = new Map<string, string[]>()
  for (const p of (prods ?? []) as ProductRow[]) {
    const mid = (p.category_mid ?? '').trim()
    if (!mid) continue
    if (!seriesById.has(p.id)) continue
    const arr = groups.get(mid) ?? []
    arr.push(p.id)
    groups.set(mid, arr)
  }

  type Insert = {
    rising_id: string
    declining_id: string
    category_mid: string
    anti_corr: number
    share_shift: number
    rising_slope: number
    declining_slope: number
    window_days: number
    sample_points: number
    trajectories: unknown
    computed_at: string
  }
  const inserts: Insert[] = []
  let pairsEvaluated = 0

  for (const [mid, idsRaw] of groups) {
    // 페어 폭발 방지: 카테고리당 상한
    const ids = idsRaw.slice(0, MAX_PRODUCTS_PER_MID)
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const a = seriesById.get(ids[i])!
        const b = seriesById.get(ids[j])!

        // 공통 관측일 교집합
        const commonDays: number[] = []
        for (const d of a.byDay.keys()) {
          if (b.byDay.has(d)) commonDays.push(d)
        }
        if (commonDays.length < MIN_SAMPLE_POINTS) continue
        commonDays.sort((x, y) => x - y)

        const av = commonDays.map((d) => a.byDay.get(d)!)
        const bv = commonDays.map((d) => b.byDay.get(d)!)

        pairsEvaluated++

        const corr = pearson(av, bv)
        if (corr === null || corr > ANTI_CORR_MAX) continue

        const sa = slope(commonDays, av)
        const sb2 = slope(commonDays, bv)

        // 한쪽은 확실히 오르고 한쪽은 확실히 내려야 '대체'
        if (Math.abs(sa) < MIN_SLOPE_MAG || Math.abs(sb2) < MIN_SLOPE_MAG) continue
        if (sa > 0 === sb2 > 0) continue // 같은 방향이면 대체 아님

        const aIsRising = sa > 0
        const risingId = aIsRising ? ids[i] : ids[j]
        const decliningId = aIsRising ? ids[j] : ids[i]
        const risingSeries = aIsRising ? av : bv
        const decliningSeries = aIsRising ? bv : av
        const risingSlope = aIsRising ? sa : sb2
        const decliningSlope = aIsRising ? sb2 : sa

        // share_shift: 시작→끝 점유 이전량 추정 (상승폭 + 하락폭) / 2
        const riseDelta = risingSeries[risingSeries.length - 1] - risingSeries[0]
        const dropDelta = decliningSeries[0] - decliningSeries[decliningSeries.length - 1]
        const shareShift = (riseDelta + dropDelta) / 2

        // dayIndex → 절대 timestamp(자정) 로 변환해 차트에 친화
        const toPoints = (vals: number[]) =>
          commonDays.map((d, k) => ({
            t: new Date((baseDay + d) * DAY_MS).toISOString(),
            v: Math.round(vals[k] * 10) / 10,
          }))

        inserts.push({
          rising_id: risingId,
          declining_id: decliningId,
          category_mid: mid,
          anti_corr: Math.round(corr * 1000) / 1000,
          share_shift: Math.round(shareShift * 10) / 10,
          rising_slope: Math.round(risingSlope * 1000) / 1000,
          declining_slope: Math.round(decliningSlope * 1000) / 1000,
          window_days: windowDays,
          sample_points: commonDays.length,
          trajectories: {
            rising: toPoints(risingSeries),
            declining: toPoints(decliningSeries),
            rising_name: metaById.get(risingId)?.canonical_name ?? null,
            declining_name: metaById.get(decliningId)?.canonical_name ?? null,
          },
          computed_at: nowIso,
        })
      }
    }
  }

  let pairsInserted = 0
  if (inserts.length > 0) {
    // upsert (rising_id, declining_id, window_days) — 새 computed_at 으로 갱신
    const { error: upErr } = await (sb as any)
      .from('jimscanner_trends_displacement')
      .upsert(inserts, { onConflict: 'rising_id,declining_id,window_days' })
    if (upErr) {
      return {
        status: 'error',
        windowDays,
        productsConsidered: productIds.length,
        pairsEvaluated,
        pairsInserted: 0,
        error: upErr.message,
      }
    }
    pairsInserted = inserts.length
  }

  return {
    status: 'ok',
    windowDays,
    productsConsidered: productIds.length,
    pairsEvaluated,
    pairsInserted,
  }
}
