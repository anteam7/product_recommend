/**
 * Repurchase Cadence Engine — 재구매 주기 / LTV proxy 추정 모듈.
 *
 * 데이터 소스 3개를 결합:
 *   1) jimscanner_trends_keywords 의 같은 키워드 재등장 간격 (ACF 근사)
 *   2) jimscanner_forwarder_reviews 의 '재구매·또 샀·리오더' 토픽 빈도
 *   3) 카테고리별 외부 벤치마크 seed (테이블에 미리 삽입됨)
 *
 * 산출물: jimscanner_trends_repurchase_cadence upsert.
 */

import type { SupabaseClient } from '@supabase/supabase-js'

export interface CadenceRow {
  category_top: string
  category_mid: string | null
  brand: string | null
  cadence_days_p25: number | null
  cadence_days_p50: number
  cadence_days_p75: number | null
  ltv_proxy_krw: number | null
  sample_size: number
  confidence_score: number | null
  evidence_jsonb: Record<string, unknown>
  computed_at?: string
}

// 한국어 재구매 시그널 어휘
const REPURCHASE_PHRASES = [
  '재구매', '또 샀', '또 시켰', '또 주문', '두 번째', '세 번째', '리오더', '재주문',
  '계속 쓰', '계속 사', '꾸준히 사', '단골', '정기 구매', '정기구매', '항상 사',
] as const

// 키워드 → 카테고리 매핑 (간단 규칙). 실제 LLM 분류 결과는 jimscanner_trends_keywords.category_top 사용.
function reviewKeywordCategoryHint(keywords: string[] | null | undefined): { top: string; mid: string | null } | null {
  if (!keywords || keywords.length === 0) return null
  const joined = keywords.join(' ')
  if (/멜라토닌|수면|sleep/i.test(joined)) return { top: 'health', mid: 'sleep' }
  if (/영양제|비타민|오메가|프로바이오/i.test(joined)) return { top: 'health', mid: 'supplements' }
  if (/스킨|로션|에센스|토너|크림/i.test(joined)) return { top: 'beauty', mid: 'skincare' }
  if (/립|아이|섀도|마스카라|틴트/i.test(joined)) return { top: 'beauty', mid: 'cosmetics' }
  if (/사료|간식|반려/i.test(joined)) return { top: 'pet', mid: 'food' }
  if (/세제|샴푸|치약|휴지/i.test(joined)) return { top: 'living', mid: 'consumable' }
  return null
}

function median(xs: number[]): number {
  if (xs.length === 0) return NaN
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

function quantile(xs: number[], q: number): number | null {
  if (xs.length === 0) return null
  const s = [...xs].sort((a, b) => a - b)
  const pos = (s.length - 1) * q
  const base = Math.floor(pos)
  const rest = pos - base
  if (s[base + 1] !== undefined) return s[base] + rest * (s[base + 1] - s[base])
  return s[base]
}

/**
 * 같은 키워드가 trends_keywords 에 다시 등장하는 lag(일) 분포 추정.
 * 정확한 자기상관(ACF) 까지는 아니고, 같은 keyword의 collected_at 간 gap 의 분포.
 */
async function computeKeywordCadence(
  admin: SupabaseClient<any, any, any>,
  category_top: string,
): Promise<{ p25: number | null; p50: number | null; p75: number | null; sample: number; topKeyword: string | null }> {
  // 최근 180일치
  const since = new Date(Date.now() - 180 * 24 * 60 * 60 * 1000).toISOString()
  const { data, error } = await admin
    .from('jimscanner_trends_keywords')
    .select('keyword, collected_at')
    .eq('category_top', category_top)
    .gte('collected_at', since)
    .limit(5000)
  if (error || !data || data.length === 0) {
    return { p25: null, p50: null, p75: null, sample: 0, topKeyword: null }
  }

  // keyword 별 collected_at 정렬해서 gap 추출
  const byKeyword = new Map<string, number[]>()
  for (const r of data as { keyword: string; collected_at: string }[]) {
    const arr = byKeyword.get(r.keyword) ?? []
    arr.push(new Date(r.collected_at).getTime())
    byKeyword.set(r.keyword, arr)
  }
  const allGapsDays: number[] = []
  let topKeyword: string | null = null
  let topGaps = 0
  for (const [keyword, times] of byKeyword) {
    if (times.length < 2) continue
    times.sort((a, b) => a - b)
    const gaps: number[] = []
    for (let i = 1; i < times.length; i++) {
      const days = (times[i] - times[i - 1]) / (1000 * 60 * 60 * 24)
      // 너무 짧으면(<1일) 같은 수집 사이클로 봄, 너무 길면(>180일) 노이즈
      if (days >= 1 && days <= 180) gaps.push(days)
    }
    if (gaps.length > topGaps) {
      topGaps = gaps.length
      topKeyword = keyword
    }
    allGapsDays.push(...gaps)
  }

  if (allGapsDays.length === 0) {
    return { p25: null, p50: null, p75: null, sample: 0, topKeyword: null }
  }
  return {
    p25: quantile(allGapsDays, 0.25),
    p50: median(allGapsDays),
    p75: quantile(allGapsDays, 0.75),
    sample: allGapsDays.length,
    topKeyword,
  }
}

/**
 * 후기 텍스트에서 재구매 멘션 비율 산출. 비율이 높으면 cadence 단축 / confidence 상승.
 */
async function computeReviewRepurchaseRate(
  admin: SupabaseClient<any, any, any>,
  category_top: string,
  category_mid: string | null,
): Promise<{ nReviews: number; nMentions: number; phrasesHit: string[] }> {
  const { data, error } = await admin
    .from('jimscanner_forwarder_reviews')
    .select('summary, keywords')
    .eq('is_hidden', false)
    .limit(2000)
  if (error || !data) return { nReviews: 0, nMentions: 0, phrasesHit: [] }

  const phrasesHit = new Set<string>()
  let nReviews = 0
  let nMentions = 0
  for (const r of data as { summary: string | null; keywords: string[] | null }[]) {
    const hint = reviewKeywordCategoryHint(r.keywords)
    if (!hint) continue
    if (hint.top !== category_top) continue
    if (category_mid && hint.mid && hint.mid !== category_mid) continue
    nReviews++
    const text = r.summary ?? ''
    for (const ph of REPURCHASE_PHRASES) {
      if (text.includes(ph)) {
        nMentions++
        phrasesHit.add(ph)
        break
      }
    }
  }
  return { nReviews, nMentions, phrasesHit: [...phrasesHit] }
}

/**
 * LTV proxy 추정. 평균 단가 × (365 / cadence_days) × retention(0.6).
 * 평균 단가는 ggsan 카탈로그 카테고리별 평균 price_krw 로 근사.
 */
async function computeAvgUnitPrice(
  admin: SupabaseClient<any, any, any>,
  category_top: string,
): Promise<number | null> {
  // ggsan 카탈로그는 카테고리 코드(001..014) 사용. category_top 기반 매핑:
  const codeMap: Record<string, string[]> = {
    health: ['001', '002', '003', '005', '006', '007', '008', '009', '011'],
    beauty: [], // ggsan 미수집
    living: ['010', '012', '013'],
    apparel: [],
    digital: [],
    pet: [],
  }
  const codes = codeMap[category_top] ?? []
  if (codes.length === 0) return null
  // 일부 환경에서 ggsan_catalog 테이블명이 jimscanner_ggsan_catalog 일 수 있음 — `as any` 캐스팅.
  // 없거나 에러나면 null 리턴.
  try {
    const { data, error } = await (admin as any)
      .from('jimscanner_ggsan_catalog')
      .select('price_krw, cate_cd')
      .in('cate_cd', codes)
      .not('price_krw', 'is', null)
      .limit(1000)
    if (error || !data || data.length === 0) return null
    const prices = (data as { price_krw: number | null }[])
      .map((d) => d.price_krw)
      .filter((p): p is number => typeof p === 'number' && p > 0)
    if (prices.length === 0) return null
    prices.sort((a, b) => a - b)
    return prices[Math.floor(prices.length / 2)] // 중앙값
  } catch {
    return null
  }
}

/**
 * 추정 결과를 합성한다. seed 벤치마크 → ACF + review 시그널로 보정.
 */
function blend(
  seed: { p25: number; p50: number; p75: number },
  acf: { p25: number | null; p50: number | null; p75: number | null; sample: number },
  reviewRate: number, // 0~1
): { p25: number; p50: number; p75: number; confidence: number } {
  // 시드 가중치 (sample 부족하면 시드 100%, 많으면 ACF 우세)
  const acfWeight = Math.min(0.7, acf.sample / 100) // 100 gap 이상이면 0.7
  const seedWeight = 1 - acfWeight

  const pick = (s: number, a: number | null): number =>
    a == null || !isFinite(a) ? s : s * seedWeight + a * acfWeight

  const p50 = pick(seed.p50, acf.p50)
  // 재구매 멘션 비율로 cadence 단축 보정 (멘션 많을수록 빠른 재구매층 큼)
  const cadenceBoost = 1 - Math.min(0.25, reviewRate * 0.5) // 최대 25% 단축
  const finalP50 = Math.max(7, p50 * cadenceBoost)
  const finalP25 = Math.max(3, pick(seed.p25, acf.p25) * cadenceBoost)
  const finalP75 = Math.max(finalP50, pick(seed.p75, acf.p75) * cadenceBoost)

  // confidence: sample 100+ → 0.7 base, review 시그널 +0.2
  const baseConf = Math.min(0.7, 0.3 + acf.sample / 200)
  const reviewBoost = Math.min(0.2, reviewRate)
  const confidence = Math.min(0.95, baseConf + reviewBoost)

  return { p25: round1(finalP25), p50: round1(finalP50), p75: round1(finalP75), confidence: round2(confidence) }
}

function round1(x: number): number {
  return Math.round(x * 10) / 10
}
function round2(x: number): number {
  return Math.round(x * 100) / 100
}

// 기본 seed (테이블에 없으면 fallback)
const FALLBACK_SEEDS: Array<{ category_top: string; category_mid: string | null; p25: number; p50: number; p75: number }> = [
  { category_top: 'health', category_mid: 'supplements', p25: 21, p50: 30, p75: 45 },
  { category_top: 'health', category_mid: 'sleep', p25: 25, p50: 30, p75: 45 },
  { category_top: 'beauty', category_mid: 'skincare', p25: 30, p50: 45, p75: 60 },
  { category_top: 'beauty', category_mid: 'cosmetics', p25: 45, p50: 60, p75: 90 },
  { category_top: 'living', category_mid: 'consumable', p25: 30, p50: 60, p75: 90 },
  { category_top: 'apparel', category_mid: null, p25: 60, p50: 90, p75: 180 },
  { category_top: 'digital', category_mid: null, p25: 180, p50: 365, p75: 730 },
  { category_top: 'pet', category_mid: 'food', p25: 21, p50: 30, p75: 45 },
]

export interface RecomputeResult {
  status: 'ok' | 'partial' | 'error'
  rows_upserted: number
  errors: string[]
  computed_at: string
}

export async function recomputeCadence(
  admin: SupabaseClient<any, any, any>,
): Promise<RecomputeResult> {
  const errors: string[] = []
  let upserted = 0
  const now = new Date().toISOString()

  for (const seed of FALLBACK_SEEDS) {
    try {
      const acf = await computeKeywordCadence(admin, seed.category_top)
      const review = await computeReviewRepurchaseRate(admin, seed.category_top, seed.category_mid)
      const reviewRate = review.nReviews > 0 ? review.nMentions / review.nReviews : 0
      const blended = blend(
        { p25: seed.p25, p50: seed.p50, p75: seed.p75 },
        { p25: acf.p25, p50: acf.p50, p75: acf.p75, sample: acf.sample },
        reviewRate,
      )

      const avgPrice = await computeAvgUnitPrice(admin, seed.category_top)
      // LTV proxy = 단가 × (365 / cadence_p50) × retention(0.6)
      const ltv =
        avgPrice && blended.p50 > 0
          ? Math.round(avgPrice * (365 / blended.p50) * 0.6)
          : null

      const evidence: Record<string, unknown> = {
        acf_signal: {
          top_keyword: acf.topKeyword,
          gap_sample: acf.sample,
          p25: acf.p25,
          p50: acf.p50,
          p75: acf.p75,
        },
        review_signal: {
          n_reviews: review.nReviews,
          n_repurchase_mentions: review.nMentions,
          repurchase_rate: round2(reviewRate),
          phrases: review.phrasesHit,
        },
        benchmark: {
          source: 'seed+blend',
          seed_days_p50: seed.p50,
          rationale: `${seed.category_top}/${seed.category_mid ?? '*'} 벤치마크 + ACF + 리뷰 멘션 보정`,
        },
        avg_unit_price_krw: avgPrice,
      }

      const row = {
        category_top: seed.category_top,
        category_mid: seed.category_mid,
        brand: null as string | null,
        cadence_days_p25: blended.p25,
        cadence_days_p50: blended.p50,
        cadence_days_p75: blended.p75,
        ltv_proxy_krw: ltv,
        sample_size: acf.sample + review.nReviews,
        confidence_score: blended.confidence,
        evidence_jsonb: evidence,
        computed_at: now,
      }

      const { error } = await (admin as any)
        .from('jimscanner_trends_repurchase_cadence')
        .upsert(row, { onConflict: 'category_top,category_mid,brand' })
      if (error) {
        errors.push(`${seed.category_top}/${seed.category_mid ?? '*'}: ${error.message}`)
      } else {
        upserted++
      }
    } catch (e: unknown) {
      errors.push(`${seed.category_top}/${seed.category_mid ?? '*'}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  return {
    status: errors.length === 0 ? 'ok' : upserted > 0 ? 'partial' : 'error',
    rows_upserted: upserted,
    errors,
    computed_at: now,
  }
}

/**
 * 권장 CAC 상한 산출. = ltv_proxy × margin_rate × payback_target
 */
export function recommendedCacCeiling(
  ltvProxyKrw: number | null,
  marginRate = 0.3,
  paybackTarget = 0.5,
): number | null {
  if (!ltvProxyKrw || ltvProxyKrw <= 0) return null
  return Math.round(ltvProxyKrw * marginRate * paybackTarget)
}
