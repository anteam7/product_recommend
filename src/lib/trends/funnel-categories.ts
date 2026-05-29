/**
 * Demand-Funnel Divergence — 카테고리 정규화 매핑.
 *
 * 두 네이버 소스는 어휘가 다르다:
 *  - naver_search_trend: keyword = 검색어 그룹 라벨 (예: "수면 - 멜라토닌", "직구", "환율")
 *  - naver_shopping_insight: keyword/category_top = 쇼핑 대분류명 (예: "생활/건강", "식품", "패션의류")
 *
 * 퍼널갭(검색 모멘텀 vs 쇼핑클릭 모멘텀)을 교차하려면 두 어휘를 공통 버킷으로 정규화해야 한다.
 * 신규 cron/수집원 없이 이 매핑 테이블 1개만으로 동작한다 (이미 두 소스 모두 매일 수집 중).
 */

export type FunnelBucket = {
  key: string
  label: string
}

/** 정규화 버킷 정의 (표시 순서 = 배열 순서) */
export const FUNNEL_BUCKETS: FunnelBucket[] = [
  { key: 'health', label: '건강·영양제' },
  { key: 'sleep', label: '수면·숙면' },
  { key: 'food', label: '식품' },
  { key: 'fashion', label: '패션' },
  { key: 'beauty', label: '뷰티·화장품' },
  { key: 'digital', label: '디지털·가전' },
  { key: 'interior', label: '가구·인테리어' },
  { key: 'baby', label: '출산·육아' },
  { key: 'sports', label: '스포츠·레저' },
  { key: 'living', label: '생활·건강(쇼핑대분류)' },
  { key: 'direct', label: '직구·해외' },
]

const BUCKET_LABEL = new Map(FUNNEL_BUCKETS.map((b) => [b.key, b.label]))

/** 부분문자열 → 버킷 매칭 규칙. 위에서부터 먼저 매칭되는 것을 채택. */
const RULES: Array<{ bucket: string; needles: string[] }> = [
  { bucket: 'sleep', needles: ['수면', '숙면', '멜라토닌', '꿀잠', '테아닌', '락티움', '감태', '글리신', '수면제', '수면보조'] },
  { bucket: 'health', needles: ['영양제', '건강기능', '건강식품', '비타민', '유산균', '프로바이오', '오메가'] },
  { bucket: 'food', needles: ['식품'] },
  { bucket: 'fashion', needles: ['패션의류', '패션잡화', '의류', '패션'] },
  { bucket: 'beauty', needles: ['화장품', '미용', '뷰티'] },
  { bucket: 'digital', needles: ['디지털', '가전'] },
  { bucket: 'interior', needles: ['가구', '인테리어'] },
  { bucket: 'baby', needles: ['출산', '육아'] },
  { bucket: 'sports', needles: ['스포츠', '레저'] },
  { bucket: 'living', needles: ['생활/건강', '생활', '여가'] },
  { bucket: 'direct', needles: ['직구', '관부가세', '관세', '환율', '구매대행', '배송대행', '목록통관'] },
]

/**
 * (source, keyword, category_top) → 정규화 버킷 key. 매칭 실패 시 null.
 * keyword/category_top 어느 쪽이든 매칭되면 채택한다.
 */
export function normalizeFunnelBucket(
  keyword: string | null,
  categoryTop: string | null,
): string | null {
  const hay = `${keyword ?? ''} ${categoryTop ?? ''}`
  for (const rule of RULES) {
    if (rule.needles.some((n) => hay.includes(n))) return rule.bucket
  }
  return null
}

export function bucketLabel(key: string): string {
  return BUCKET_LABEL.get(key) ?? key
}
