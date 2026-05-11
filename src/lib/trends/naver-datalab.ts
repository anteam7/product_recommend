/**
 * Naver DataLab API 클라이언트.
 *
 * 두 API 사용:
 *  - 검색어 트렌드: POST /v1/datalab/search
 *  - 쇼핑 카테고리 트렌드: POST /v1/datalab/shopping/categories
 *
 * 둘 다 절대 검색량이 아니라 0~100 ratio (지정 기간 최댓값 = 100) 만 반환.
 * 절대값 비교가 아니라 "추세" 와 "그룹간 상대 인기도" 를 보는 도구.
 *
 * 인증: 헤더 X-Naver-Client-Id / X-Naver-Client-Secret
 * (cf. NAVER_OPENAPI_CLIENT_* 와는 별도 앱 — DataLab 권한 활성화된 키)
 */

const API_BASE = 'https://openapi.naver.com'

export type DatalabKeywordGroup = {
  groupName: string
  keywords: string[]
}

export type DatalabCategoryGroup = {
  name: string
  param: string[] // cid 배열 (보통 1개)
}

export type DatalabTimeUnit = 'date' | 'week' | 'month'
export type DatalabDevice = '' | 'pc' | 'mo'
export type DatalabGender = '' | 'm' | 'f'

export type DatalabSearchRequest = {
  startDate: string // 'YYYY-MM-DD'
  endDate: string
  timeUnit: DatalabTimeUnit
  keywordGroups: DatalabKeywordGroup[] // 최대 5
  device?: DatalabDevice
  ages?: string[]
  gender?: DatalabGender
}

export type DatalabShoppingCategoryRequest = {
  startDate: string
  endDate: string
  timeUnit: DatalabTimeUnit
  category: DatalabCategoryGroup[] // 최대 3
  device?: DatalabDevice
  ages?: string[]
  gender?: DatalabGender
}

export type DatalabResultItem = {
  period: string // 'YYYY-MM-DD'
  ratio: number  // 0~100
}

export type DatalabResultGroup = {
  title: string
  keywords?: string[]
  data: DatalabResultItem[]
}

export type DatalabResponse = {
  startDate: string
  endDate: string
  timeUnit: string
  results: DatalabResultGroup[]
}

function getCredentials(): { id: string; secret: string } {
  const id = process.env.NAVER_DEVELOPERS_CLIENT_ID
  const secret = process.env.NAVER_DEVELOPERS_CLIENT_SECRET
  if (!id || !secret) {
    throw new Error('NAVER_DEVELOPERS_CLIENT_ID / NAVER_DEVELOPERS_CLIENT_SECRET 환경변수 필요')
  }
  return { id, secret }
}

async function postDatalab<T>(path: string, body: unknown): Promise<T> {
  const { id, secret } = getCredentials()
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: {
      'X-Naver-Client-Id': id,
      'X-Naver-Client-Secret': secret,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Naver DataLab ${path} HTTP ${res.status}: ${text.slice(0, 500)}`)
  }
  return (await res.json()) as T
}

export async function fetchSearchTrend(req: DatalabSearchRequest): Promise<DatalabResponse> {
  if (req.keywordGroups.length === 0) throw new Error('keywordGroups empty')
  if (req.keywordGroups.length > 5) throw new Error('keywordGroups max 5')
  return postDatalab<DatalabResponse>('/v1/datalab/search', req)
}

export async function fetchShoppingCategories(
  req: DatalabShoppingCategoryRequest,
): Promise<DatalabResponse> {
  if (req.category.length === 0) throw new Error('category empty')
  if (req.category.length > 3) throw new Error('category max 3')
  return postDatalab<DatalabResponse>('/v1/datalab/shopping/categories', req)
}

/** 오늘로부터 N일 전 (YYYY-MM-DD, KST) */
export function dateNDaysAgoKst(daysAgo: number): string {
  const now = new Date()
  // KST = UTC+9
  const kst = new Date(now.getTime() + 9 * 3600_000)
  kst.setUTCDate(kst.getUTCDate() - daysAgo)
  return kst.toISOString().slice(0, 10)
}

/** 청크: 길이 N 단위로 분할 */
export function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}
