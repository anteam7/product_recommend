/**
 * Naver 검색광고(SearchAd) API 클라이언트 — 키워드도구(keywordstool).
 *
 * DataLab 이 0~100 상대비율만 주는 것과 달리, 검색광고 API 는
 *   ① 월간 절대 검색량(PC/모바일 분리)  ② 경쟁정도(낮음/중간/높음)
 *   ③ 월평균 노출 광고수(plAvgDepth)     ④ 예상 입찰가(CPC, 별도 bid estimate)
 * 를 반환한다. 절대 규모·유료 획득비용 차원을 trend_score 에 더하기 위함.
 *
 * 인증: HMAC-SHA256 서명
 *   message   = `${timestamp}.${method}.${uri}`  (uri 는 query 제외 path)
 *   signature = base64(HMAC_SHA256(message, secretKey))
 *   headers   = X-Timestamp / X-API-KEY(access license) / X-Customer(customer id) / X-Signature
 *
 * env: NAVER_SEARCHAD_API_KEY / NAVER_SEARCHAD_SECRET_KEY / NAVER_SEARCHAD_CUSTOMER_ID
 */

import crypto from 'crypto'

const API_BASE = 'https://api.searchad.naver.com'

export type KeywordCompIdx = '낮음' | '중간' | '높음'

export type KeywordToolRow = {
  /** 정규화된 연관 키워드 (공백 제거 대문자) */
  relKeyword: string
  /** 월간 PC 검색수 — 절대값 또는 '< 10' 문자열 */
  monthlyPcQcCnt: number | string
  /** 월간 모바일 검색수 */
  monthlyMobileQcCnt: number | string
  /** 경쟁정도 */
  compIdx: KeywordCompIdx
  /** 월평균 노출 광고수 */
  plAvgDepth: number
  monthlyAvePcClkCnt?: number
  monthlyAveMobileClkCnt?: number
}

export type KeywordToolResponse = {
  keywordList: KeywordToolRow[]
}

function getCredentials(): { apiKey: string; secret: string; customerId: string } {
  const apiKey = process.env.NAVER_SEARCHAD_API_KEY
  const secret = process.env.NAVER_SEARCHAD_SECRET_KEY
  const customerId = process.env.NAVER_SEARCHAD_CUSTOMER_ID
  if (!apiKey || !secret || !customerId) {
    throw new Error(
      'NAVER_SEARCHAD_API_KEY / NAVER_SEARCHAD_SECRET_KEY / NAVER_SEARCHAD_CUSTOMER_ID 환경변수 필요',
    )
  }
  return { apiKey, secret, customerId }
}

function sign(timestamp: string, method: string, uri: string, secret: string): string {
  const message = `${timestamp}.${method}.${uri}`
  return crypto.createHmac('sha256', secret).update(message).digest('base64')
}

async function getSearchAd<T>(uri: string, query: Record<string, string>): Promise<T> {
  const { apiKey, secret, customerId } = getCredentials()
  const timestamp = String(Date.now())
  const signature = sign(timestamp, 'GET', uri, secret)
  const qs = new URLSearchParams(query).toString()
  const res = await fetch(`${API_BASE}${uri}?${qs}`, {
    method: 'GET',
    headers: {
      'X-Timestamp': timestamp,
      'X-API-KEY': apiKey,
      'X-Customer': customerId,
      'X-Signature': signature,
      'Content-Type': 'application/json; charset=UTF-8',
    },
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Naver SearchAd ${uri} HTTP ${res.status}: ${text.slice(0, 500)}`)
  }
  return (await res.json()) as T
}

/**
 * 키워드도구 조회. 한 호출당 hintKeywords 최대 5개.
 * showDetail=1 로 경쟁정도·노출광고수까지 받음.
 */
export async function fetchKeywordTool(hintKeywords: string[]): Promise<KeywordToolResponse> {
  if (hintKeywords.length === 0) throw new Error('hintKeywords empty')
  if (hintKeywords.length > 5) throw new Error('hintKeywords max 5')
  // 검색광고는 키워드 내 공백을 허용하지 않음 → 제거
  const hint = hintKeywords.map((k) => k.replace(/\s+/g, '')).join(',')
  return getSearchAd<KeywordToolResponse>('/keywordstool', {
    hintKeywords: hint,
    showDetail: '1',
  })
}

/** '< 10' / '<10' / number → 정수. 미만 표기는 보수적으로 5 로 환산. */
export function parseQcCnt(v: number | string | null | undefined): number {
  if (typeof v === 'number') return Math.round(v)
  if (typeof v !== 'string') return 0
  const t = v.trim()
  if (t.startsWith('<')) return 5
  const n = Number(t.replace(/[^0-9.]/g, ''))
  return Number.isFinite(n) ? Math.round(n) : 0
}

export type BidEstimateResponse = {
  estimate?: Array<{ keyword?: string; bid?: number; position?: number }>
}

/**
 * 예상 입찰가(CPC) — 노출 1위(평균) 기준 추정. best-effort.
 * 키워드별 1위 노출에 필요한 입찰가를 원 단위로 반환. 실패 시 호출측에서 null 처리.
 */
export async function estimateCpc(keyword: string, position = 1): Promise<number | null> {
  const { apiKey, secret, customerId } = getCredentials()
  const uri = '/estimate/average-position-bid/keyword'
  const timestamp = String(Date.now())
  const signature = sign(timestamp, 'POST', uri, secret)
  const res = await fetch(`${API_BASE}${uri}`, {
    method: 'POST',
    headers: {
      'X-Timestamp': timestamp,
      'X-API-KEY': apiKey,
      'X-Customer': customerId,
      'X-Signature': signature,
      'Content-Type': 'application/json; charset=UTF-8',
    },
    body: JSON.stringify({
      device: 'PC',
      keywords: [{ key: keyword.replace(/\s+/g, ''), position }],
    }),
  })
  if (!res.ok) return null
  const json = (await res.json()) as BidEstimateResponse
  const bid = json.estimate?.[0]?.bid
  return typeof bid === 'number' && Number.isFinite(bid) ? bid : null
}

// ─────────────────────────────────────────────────────────────
// 스코어링 보정 — 키워드 수요로 trend/competition 컴포넌트 앵커링
// scoring 파이프라인이 jimscanner_trends_keyword_demand 의 최신 row 를 읽어
// 아래 헬퍼로 score_components 에 절대규모·경쟁혼잡·예상획득비용 필드를 채운다.
// ─────────────────────────────────────────────────────────────

export type KeywordDemand = {
  monthly_total: number
  comp_idx: KeywordCompIdx | string | null
  ad_depth: number | null
  est_cpc: number | null
}

export type DemandScoreComponents = {
  /** (a) 절대 규모 0~100 — 작은 카테고리 과대평가 교정용. 월 5만 검색 ≈ 100 (log 스케일) */
  absolute_scale: number
  /** (b) 실제 광고시장 혼잡도 0~100 — competition_score 보정 (높을수록 혼잡=경쟁 강함) */
  market_congestion: number
  /** (c) 예상 획득비용 — CPC(원), 미수집 시 경쟁정도 프록시 */
  est_acquisition_cost: number
}

const COMP_RANK: Record<string, number> = { 낮음: 25, 중간: 60, 높음: 90 }
const COMP_CPC_PROXY: Record<string, number> = { 낮음: 800, 중간: 2500, 높음: 6000 }

const clamp100 = (n: number) => Math.max(0, Math.min(100, n))

export function demandScoreComponents(d: KeywordDemand): DemandScoreComponents {
  // log10 스케일: 100→0, 1k→26, 10k→52, 50k→~88, 100k→100
  const vol = Math.max(0, d.monthly_total)
  const absolute_scale = vol <= 0 ? 0 : clamp100((Math.log10(vol) - 2) * 33.3)

  const compKey = (d.comp_idx ?? '') as string
  // 광고수(ad_depth) 가 있으면 혼잡도에 가중 (광고 8개+ = 포화)
  const depthBoost = d.ad_depth != null ? clamp100((d.ad_depth / 8) * 100) : null
  const compBase = COMP_RANK[compKey] ?? 50
  const market_congestion = depthBoost == null ? compBase : clamp100(compBase * 0.6 + depthBoost * 0.4)

  const est_acquisition_cost =
    d.est_cpc != null && d.est_cpc > 0 ? d.est_cpc : COMP_CPC_PROXY[compKey] ?? 1500

  return { absolute_scale, market_congestion, est_acquisition_cost }
}
