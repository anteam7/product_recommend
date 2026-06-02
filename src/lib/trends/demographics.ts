/**
 * 인구통계 수요 프로파일 — 순수 계산 유틸 (Supabase 비의존).
 *
 * Naver DataLab 의 연령·성별 세그먼트 분해를 다루는 공용 타입/상수/계산.
 * 수집(collect.ts)과 보드 페이지(trend-radar/demographics) 양쪽에서 import.
 *
 * 주의: DataLab API 는 세그먼트별 분해를 한 응답에 주지 않는다.
 *   → 연령/성별 필터를 건 호출을 세그먼트 수만큼 반복해 ratio 벡터를 조립한다.
 *   각 호출의 ratio 는 자체 기간 최댓값=100 으로 정규화되므로 절대 비교는 한계가 있으나,
 *   세그먼트 간 '상대 분포 형태'(누가 더 검색/구매하나)는 충분히 읽힌다.
 */

export const DEMO_SOURCE = 'naver_demographics'

export type AgeBucketKey = '10대' | '20대' | '30대' | '40대' | '50대' | '60대+'
export const AGE_BUCKET_KEYS: AgeBucketKey[] = ['10대', '20대', '30대', '40대', '50대', '60대+']

export type GenderKey = 'm' | 'f'
export const GENDER_KEYS: GenderKey[] = ['m', 'f']
export const GENDER_LABEL: Record<GenderKey, string> = { m: '남성', f: '여성' }

/**
 * 소스별 연령 코드 매핑.
 *  - 쇼핑인사이트: ages 코드 = '10' | '20' | ... | '60'
 *  - 검색어 트렌드: ages 코드 = '1'~'11' (5세 단위) → 10년 단위로 묶음
 */
export const AGE_CODES: Record<'shopping' | 'search', Record<AgeBucketKey, string[]>> = {
  shopping: {
    '10대': ['10'],
    '20대': ['20'],
    '30대': ['30'],
    '40대': ['40'],
    '50대': ['50'],
    '60대+': ['60'],
  },
  search: {
    '10대': ['2'], // 13~18
    '20대': ['3', '4'], // 19~29
    '30대': ['5', '6'], // 30~39
    '40대': ['7', '8'], // 40~49
    '50대': ['9', '10'], // 50~59
    '60대+': ['11'], // 60+
  },
}

export type DemoAgeVector = Partial<Record<AgeBucketKey, number>>
export type DemoGenderVector = Partial<Record<GenderKey, number>>

export type DemoProfile = {
  /** 0(범용·균등) ~ 1(특정 세그먼트 편중). 엔트로피 역수 기반. */
  concentration: number
  /** 주력 연령대 (정규화 비중 최댓값) */
  dominantAge: AgeBucketKey | null
  /** 주력 성별 */
  dominantGender: GenderKey | null
  /** 주력 연령대의 비중(0~1) */
  dominantAgeShare: number
  /** 주력 성별의 비중(0~1) */
  dominantGenderShare: number
  /** 연령대 정규화 비중 (합=1) */
  ageShares: Record<AgeBucketKey, number>
}

function normalize(values: number[]): number[] {
  const sum = values.reduce((a, b) => a + (b > 0 ? b : 0), 0)
  if (sum <= 0) return values.map(() => 0)
  return values.map((v) => (v > 0 ? v / sum : 0))
}

/** 정규화 엔트로피 역수 기반 집중도 (0~1). N개 균등 → 0, 단일 집중 → 1. */
function concentrationFromShares(shares: number[]): number {
  const n = shares.length
  if (n <= 1) return 0
  const present = shares.filter((s) => s > 0)
  if (present.length === 0) return 0
  const h = -present.reduce((a, s) => a + s * Math.log(s), 0)
  const hMax = Math.log(n)
  if (hMax <= 0) return 0
  return Math.max(0, Math.min(1, 1 - h / hMax))
}

export function computeDemoProfile(
  age: DemoAgeVector | null | undefined,
  gender: DemoGenderVector | null | undefined,
): DemoProfile {
  const ageVals = AGE_BUCKET_KEYS.map((k) => Number(age?.[k] ?? 0))
  const ageShares = normalize(ageVals)
  const ageSharesMap = Object.fromEntries(
    AGE_BUCKET_KEYS.map((k, i) => [k, ageShares[i]]),
  ) as Record<AgeBucketKey, number>

  let dominantAge: AgeBucketKey | null = null
  let dominantAgeShare = 0
  AGE_BUCKET_KEYS.forEach((k, i) => {
    if (ageShares[i] > dominantAgeShare) {
      dominantAgeShare = ageShares[i]
      dominantAge = k
    }
  })

  const genderVals = GENDER_KEYS.map((k) => Number(gender?.[k] ?? 0))
  const genderShares = normalize(genderVals)
  let dominantGender: GenderKey | null = null
  let dominantGenderShare = 0
  GENDER_KEYS.forEach((k, i) => {
    if (genderShares[i] > dominantGenderShare) {
      dominantGenderShare = genderShares[i]
      dominantGender = k
    }
  })

  // 집중도: 연령 분포 집중도를 주로 보되, 성별 편중을 가산(최대 0.3 보너스).
  const ageConc = concentrationFromShares(ageShares)
  const genderConc = concentrationFromShares(genderShares)
  const concentration = Math.max(0, Math.min(1, ageConc * 0.7 + genderConc * 0.3))

  return {
    concentration,
    dominantAge,
    dominantGender,
    dominantAgeShare,
    dominantGenderShare,
    ageShares: ageSharesMap,
  }
}

/** 주력 세그먼트를 사람이 읽는 한 줄 라벨로. (등록 단계 톤 가이드용) */
export function dominantSegmentLabel(p: DemoProfile): string {
  const a = p.dominantAge ?? '?'
  const g = p.dominantGender ? GENDER_LABEL[p.dominantGender] : '?'
  return `${a} ${g}`
}
