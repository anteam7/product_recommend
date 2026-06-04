/**
 * 자동완성 suffix 의도 분류 — 규칙 기반(무료, LLM 비용 0).
 *
 * 검색엔진 자동완성은 실제 고빈도 검색만 노출하므로, seed 키워드 뒤에 붙는
 * suffix 를 5종 구매의도로 라벨링하면 "사람들이 어떤 스펙·문제·비교를
 * 실제로 치는지"가 드러난다.
 *
 * - spec       스펙변형: 용량·사이즈·색상·모델 변형 → 소싱 변형 후보
 * - compare    비교: 'vs', '차이', '비교' → 상세페이지 비교표 카피 소재
 * - problem    문제: '안돼', '고장', '오류', 'as' → 상세페이지 FAQ·해결 카피
 * - price      가격: '최저가', '가격', '할인', '쿠폰' → 가격 민감 수요
 * - accessory  액세서리·호환: '케이스', '호환', '거치대' → 번들·교차판매
 * - generic    위 어디에도 안 맞는 일반 롱테일
 */

export type AutocompleteIntent =
  | 'spec'
  | 'compare'
  | 'problem'
  | 'price'
  | 'accessory'
  | 'generic'

export const INTENT_META: Record<
  AutocompleteIntent,
  { label: string; badge: string; route: string }
> = {
  spec: { label: '스펙변형', badge: 'bg-blue-100 text-blue-700', route: '소싱 변형 후보' },
  compare: { label: '비교', badge: 'bg-purple-100 text-purple-700', route: '상세 비교표' },
  problem: { label: '문제', badge: 'bg-red-100 text-red-700', route: '상세 FAQ' },
  price: { label: '가격', badge: 'bg-amber-100 text-amber-700', route: '가격 소구' },
  accessory: { label: '액세서리', badge: 'bg-green-100 text-green-700', route: '번들·교차' },
  generic: { label: '일반', badge: 'bg-gray-100 text-gray-600', route: '—' },
}

const RULES: { intent: AutocompleteIntent; re: RegExp }[] = [
  { intent: 'compare', re: /\bvs\b|비교|차이|어떤게|뭐가\s*좋|대신/i },
  { intent: 'problem', re: /안돼|안됨|안되|고장|오류|에러|불량|증상|as|a\/s|수리|해결|먹통|버벅/i },
  { intent: 'price', re: /최저가|가격|할인|쿠폰|특가|세일|저렴|싼|얼마|중고/i },
  { intent: 'accessory', re: /케이스|호환|거치대|충전|악세|악세서리|커버|필름|받침|부품|전용|악세사리/i },
  { intent: 'spec', re: /\d|용량|사이즈|색상|컬러|인치|기가|gb|tb|모델|형|버전|미니|프로|맥스|울트라|호수|구|개입|ml|리터|kg/i },
]

/** seed(query)를 뺀 나머지 suffix 텍스트로 의도 판정. seed 없으면 전체 텍스트 사용. */
export function classifyIntent(suggestion: string, seed?: string): AutocompleteIntent {
  const text = (suggestion || '').trim()
  const suffix =
    seed && text.toLowerCase().startsWith(seed.toLowerCase())
      ? text.slice(seed.length).trim()
      : text
  const target = suffix || text
  for (const { intent, re } of RULES) {
    if (re.test(target)) return intent
  }
  return 'generic'
}

/** seed 를 제거한 순수 suffix 만 추출 (트리 표시용). */
export function extractSuffix(suggestion: string, seed: string): string {
  const text = (suggestion || '').trim()
  if (seed && text.toLowerCase().startsWith(seed.toLowerCase())) {
    return text.slice(seed.length).trim() || text
  }
  return text
}
