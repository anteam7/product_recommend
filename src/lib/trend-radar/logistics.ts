// ─────────────────────────────────────────────────────────────
// 위탁 물류 핸들링 적합성 게이트 — 부피·파손·냉장·배터리·액체 난이도
// ─────────────────────────────────────────────────────────────
// 발굴 후보의 '물리적 위탁 운영 가능성'을 점수화한다.
// 기존 4점수(trend/commerce/supplier/competition)는 수요·마진만 보고
// 물건 자체의 핸들링 난이도(반품·파손·할증·항공불가)는 못 본다.
//
// 카테고리 키워드 룰을 1차(이 모듈), LLM 을 2차(classify-trends-llm.mjs)로.
// 이 모듈은 UI(recommend/opportunity)와 LLM 스크립트가 공유하는 순수 룰.
// ─────────────────────────────────────────────────────────────

export type DimClass = 'small' | 'medium' | 'large' | 'furniture'
export type LogisticsSuitability = 'fit' | 'caution' | 'unfit'

export interface LogisticsFlags {
  dim_class: DimClass
  fragility: boolean // 유리·세라믹 등 파손 위험
  cold_chain: boolean // 냉장/냉동 (위탁 거의 불가)
  liquid: boolean // 누액 위험
  hazmat_battery: boolean // 리튬배터리 — 항공 불가
  oversize_surcharge: boolean // 부피무게 할증
}

export interface LogisticsRisk extends LogisticsFlags {
  suitability: LogisticsSuitability
  reasons: string[] // UI 사유 칩 (한국어)
}

// 키워드 룰 사전 (1차 판정). LLM 이 보강하지만 룰만으로도 동작 가능.
const RULES: { key: keyof LogisticsFlags; words: string[]; reason: string }[] = [
  {
    key: 'hazmat_battery',
    words: ['리튬', '배터리', '보조배터리', '충전지', '건전지', '파워뱅크', '전동', '드론', '스쿠터', '킥보드'],
    reason: '리튬배터리·항공불가',
  },
  {
    key: 'cold_chain',
    words: ['냉장', '냉동', '신선', '아이스', '밀키트', '생물', '회', '육류', '해산물', '아이스크림'],
    reason: '냉장/냉동·콜드체인',
  },
  {
    key: 'liquid',
    words: ['액상', '액체', '음료', '세제', '워시', '샴푸', '오일', '스프레이', '토너', '에센스', '주스', '워터', '클렌징'],
    reason: '액체·누액 위험',
  },
  {
    key: 'fragility',
    words: ['유리', '세라믹', '도자기', '거울', '액자', '유리병', '머그', '와인잔', '전구', '도기', '크리스탈'],
    reason: '파손 위험',
  },
]

// 부피/대형 룰 — dim_class 결정
const FURNITURE_WORDS = ['가구', '소파', '침대', '매트리스', '책상', '식탁', '옷장', '장롱', '서랍장', '책장', '수납장']
const LARGE_WORDS = ['대형', '캐리어', '텐트', '러그', '카페트', '카펫', '안마의자', '자전거', '러닝머신', '트램폴린', '선반', '행거', '의자']
const OVERSIZE_WORDS = ['대용량', '점보', '특대', '롤매트', '플레이매트', '범퍼침대', '에어매트']

function hasWord(haystack: string, words: string[]): boolean {
  return words.some((w) => haystack.includes(w))
}

/**
 * 상품명·설명·중분류 텍스트에서 키워드 룰로 물류 플래그 1차 산출.
 * LLM 결과가 있으면 mergeLogistics() 로 덮어쓴다.
 */
export function deriveLogisticsFromText(
  canonicalName: string,
  description?: string | null,
  categoryMid?: string | null,
): LogisticsRisk {
  const text = [canonicalName, description ?? '', categoryMid ?? ''].join(' ')

  const flags: LogisticsFlags = {
    dim_class: 'small',
    fragility: false,
    cold_chain: false,
    liquid: false,
    hazmat_battery: false,
    oversize_surcharge: false,
  }

  for (const rule of RULES) {
    if (hasWord(text, rule.words)) flags[rule.key] = true as never
  }

  if (hasWord(text, FURNITURE_WORDS)) {
    flags.dim_class = 'furniture'
    flags.oversize_surcharge = true
  } else if (hasWord(text, LARGE_WORDS)) {
    flags.dim_class = 'large'
    flags.oversize_surcharge = true
  } else if (hasWord(text, OVERSIZE_WORDS)) {
    flags.dim_class = 'medium'
    flags.oversize_surcharge = true
  }

  return finalizeLogistics(flags)
}

/**
 * 플래그 → suitability 등급 + 사유 칩 도출. (룰/LLM 공통 후처리)
 */
export function finalizeLogistics(flags: LogisticsFlags): LogisticsRisk {
  const reasons: string[] = []

  if (flags.hazmat_battery) reasons.push('🔋 리튬배터리·항공불가')
  if (flags.cold_chain) reasons.push('❄️ 냉장/냉동')
  if (flags.dim_class === 'furniture') reasons.push('🛋 가구급 대형')
  if (flags.liquid) reasons.push('💧 액체·누액')
  if (flags.fragility) reasons.push('🥃 파손 위험')
  if (flags.oversize_surcharge && flags.dim_class !== 'furniture') reasons.push('📦 부피무게 할증')
  if (flags.dim_class === 'large') reasons.push('📐 대형')

  // 부적합: 위탁 거의 불가 (반품/파손/항공불가/콜드체인)
  const unfit = flags.hazmat_battery || flags.cold_chain || flags.dim_class === 'furniture'
  // 주의: 운영 가능하나 할증/파손/누액 리스크
  const caution = flags.liquid || flags.fragility || flags.oversize_surcharge || flags.dim_class === 'large'

  const suitability: LogisticsSuitability = unfit ? 'unfit' : caution ? 'caution' : 'fit'

  if (suitability === 'fit') reasons.push('✅ 위탁 적합')

  return { ...flags, suitability, reasons }
}

export const SUITABILITY_META: Record<
  LogisticsSuitability,
  { label: string; cls: string; short: string }
> = {
  fit: { label: '위탁 적합', short: '적합', cls: 'bg-emerald-100 text-emerald-800 border-emerald-200' },
  caution: { label: '주의', short: '주의', cls: 'bg-amber-100 text-amber-800 border-amber-200' },
  unfit: { label: '부적합', short: '부적합', cls: 'bg-red-100 text-red-800 border-red-200' },
}
