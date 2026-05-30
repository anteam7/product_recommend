// ─────────────────────────────────────────────────────────────
// 주간 등록 캐파 플래너 — 순수 계산 로직 (page/actions 공유)
// ─────────────────────────────────────────────────────────────
// recommend RPC 결과(final_score 랭킹)에 1인 셀러 처리량 제약을 얹어
// 캐파·카테고리 상한 하 greedy knapsack 선택 + '지금/이번 주' 시퀀싱.
// 기대마진은 쿠팡 FEE/SHIP 공식(scripts/coupang-relist-formula.mjs 동기화)으로 추정.
// ─────────────────────────────────────────────────────────────

// 가격 상수 — coupang_pricing_model 동기화 지점.
const OUTBOUND_SHIP = 3000 // 고객 출고 배송비 (실비)
const FEE_RATE = 0.106 // 기타 영양제(73137) 판매수수료 10.6% (결제비 포함)
const VAT_DIVISOR = 11 // 부가세 = 등록가 / 11
const TARGET_MARGIN_RATE = 0.65 // 35% 마진 확보선 (= realCost / 0.65)

export interface RecommendRow {
  goods_no: string
  title: string
  cate_cd: string | null
  cate_label: string | null
  price_krw: number | null
  is_imminent: boolean
  image_url: string | null
  detail_url: string | null
  ggsan_last_seen: string
  tv_score: number
  search_score: number
  raw_score: number
  imminent_bonus: number
  final_score: number
  tv_match_count: number
  tv_top_keyword: string
  tv_total_pushes: number
  search_match_count: number
  search_top_keyword: string
  search_sources: string[]
}

export interface PlanItem {
  goods_no: string
  title: string
  cate_cd: string | null
  cate_label: string | null
  price_krw: number | null
  is_imminent: boolean
  image_url: string | null
  detail_url: string | null
  final_score: number
  expected_margin: number
  plan_value: number
  group_type: 'now' | 'week'
  seq: number
  reasons: string[]
}

/** ggsan 도매가 기준 쿠팡 등록 시 기대 실마진(원) 추정. */
export function estimateMargin(domePriceKrw: number | null): {
  listPrice: number
  expectedMargin: number
} {
  const dome = domePriceKrw ?? 0
  if (dome <= 0) return { listPrice: 0, expectedMargin: 0 }
  const realCost = dome + OUTBOUND_SHIP
  // 마진하한 등록가 (100원 단위 올림)
  const listPrice = Math.ceil(realCost / TARGET_MARGIN_RATE / 100) * 100
  const fee = Math.round(listPrice * FEE_RATE)
  const vat = Math.round(listPrice / VAT_DIVISOR)
  const expectedMargin = listPrice - realCost - fee - vat
  return { listPrice, expectedMargin: Math.max(0, expectedMargin) }
}

/** 시한성(지금 등록) 여부: 임박특가 또는 활성 TV 편성 매칭. */
export function isImminentLike(r: RecommendRow): boolean {
  return r.is_imminent || r.tv_match_count > 0
}

/** 선정 사유 칩 텍스트. */
export function buildReasons(r: RecommendRow, expectedMargin: number): string[] {
  const reasons: string[] = []
  if (r.is_imminent) reasons.push('🔥 임박특가')
  if (r.tv_match_count > 0) reasons.push(`📺 TV ${r.tv_total_pushes}회 편성`)
  if (r.search_match_count > 0) reasons.push(`🔍 검색 ${r.search_match_count}건`)
  reasons.push(`점수 ${r.final_score.toFixed(1)}`)
  if (expectedMargin > 0) reasons.push(`마진 ~${expectedMargin.toLocaleString()}원`)
  return reasons
}

export interface PlannerParams {
  capacity: number // 주간 총 등록 캐파
  perCategoryCap: number // 카테고리당 상한
  marginWeight: number // 0~1, 기대마진을 가치에 반영하는 비중
}

/**
 * 기대가치(final_score × 마진가중) 를 가치로, 주간 캐파·카테고리 상한을 제약으로
 * 두는 greedy knapsack. 시한성 아이템을 'now' 그룹으로 우선 시퀀싱.
 */
export function buildPlan(rows: RecommendRow[], params: PlannerParams): PlanItem[] {
  const { capacity, perCategoryCap, marginWeight } = params

  // 가치 산출: final_score 를 기본, 기대마진을 정규화해 가중.
  const maxMargin = Math.max(1, ...rows.map((r) => estimateMargin(r.price_krw).expectedMargin))
  const scored = rows.map((r) => {
    const { expectedMargin } = estimateMargin(r.price_krw)
    const marginFactor = 1 + marginWeight * (expectedMargin / maxMargin)
    const planValue = r.final_score * marginFactor
    return { r, expectedMargin, planValue }
  })

  // 시한성 우선 → 가치 내림차순.
  scored.sort((a, b) => {
    const aImm = isImminentLike(a.r) ? 1 : 0
    const bImm = isImminentLike(b.r) ? 1 : 0
    if (aImm !== bImm) return bImm - aImm
    return b.planValue - a.planValue
  })

  const perCat = new Map<string, number>()
  const selected: PlanItem[] = []
  for (const { r, expectedMargin, planValue } of scored) {
    if (selected.length >= capacity) break
    const cat = r.cate_cd ?? '__none__'
    const used = perCat.get(cat) ?? 0
    if (used >= perCategoryCap) continue
    perCat.set(cat, used + 1)
    selected.push({
      goods_no: r.goods_no,
      title: r.title,
      cate_cd: r.cate_cd,
      cate_label: r.cate_label,
      price_krw: r.price_krw,
      is_imminent: r.is_imminent,
      image_url: r.image_url,
      detail_url: r.detail_url,
      final_score: r.final_score,
      expected_margin: expectedMargin,
      plan_value: planValue,
      group_type: isImminentLike(r) ? 'now' : 'week',
      seq: 0,
      reasons: buildReasons(r, expectedMargin),
    })
  }

  // 그룹별 시퀀스 번호 부여 (now 먼저, 각 그룹 내 가치순 유지).
  let nowSeq = 1
  let weekSeq = 1
  for (const it of selected) {
    if (it.group_type === 'now') it.seq = nowSeq++
    else it.seq = weekSeq++
  }
  return selected
}

/** 현재 주의 월요일(KST) 을 YYYY-MM-DD 로 반환. */
export function currentWeekStart(now: Date): string {
  // KST = UTC+9
  const kst = new Date(now.getTime() + 9 * 3600 * 1000)
  const dow = kst.getUTCDay() // 0=일 ... 1=월
  const diff = (dow + 6) % 7 // 월요일까지 되돌릴 일수
  kst.setUTCDate(kst.getUTCDate() - diff)
  const y = kst.getUTCFullYear()
  const m = String(kst.getUTCMonth() + 1).padStart(2, '0')
  const d = String(kst.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}
