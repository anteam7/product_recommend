// Google Search Console API 클라이언트 (서버 전용)
//
// 인증:
//   prod (Vercel): GSC_SERVICE_ACCOUNT_JSON 환경변수 (base64 인코딩된 service account JSON)
//   dev (로컬):    프로젝트 루트의 gsc-key.json 파일

import { google } from 'googleapis'
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'

const SITE_URL = 'sc-domain:jimscanner.co.kr'

type ServiceAccount = {
  client_email: string
  private_key: string
  [key: string]: unknown
}

function loadCredentials(): ServiceAccount | null {
  const env = process.env.GSC_SERVICE_ACCOUNT_JSON
  if (env) {
    try {
      // base64 또는 raw JSON 둘 다 지원
      const trimmed = env.trim()
      const text = trimmed.startsWith('{')
        ? trimmed
        : Buffer.from(trimmed, 'base64').toString('utf-8')
      return JSON.parse(text) as ServiceAccount
    } catch {
      return null
    }
  }
  // 로컬 fallback
  const localPath = path.join(process.cwd(), 'gsc-key.json')
  if (existsSync(localPath)) {
    return JSON.parse(readFileSync(localPath, 'utf-8')) as ServiceAccount
  }
  return null
}

function getClient() {
  const creds = loadCredentials()
  if (!creds) return null
  const auth = new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ['https://www.googleapis.com/auth/webmasters.readonly'],
  })
  return google.searchconsole({ version: 'v1', auth })
}

export type GscRow = {
  query?: string
  page?: string
  device?: string
  country?: string
  clicks: number
  impressions: number
  ctr: number
  position: number
}

type GscRawRow = {
  keys?: string[] | null
  clicks?: number | null
  impressions?: number | null
  ctr?: number | null
  position?: number | null
}

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86400000).toISOString().slice(0, 10)
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10)
}

async function gscQuery(args: {
  startDate: string
  endDate: string
  dimensions?: string[]
  rowLimit?: number
}): Promise<GscRawRow[]> {
  const client = getClient()
  if (!client) throw new Error('GSC 인증 정보 없음 (GSC_SERVICE_ACCOUNT_JSON env 또는 gsc-key.json 필요)')
  const res = await client.searchanalytics.query({
    siteUrl: SITE_URL,
    requestBody: {
      startDate: args.startDate,
      endDate: args.endDate,
      dimensions: args.dimensions ?? [],
      rowLimit: args.rowLimit ?? 100,
    },
  })
  return (res.data.rows ?? []) as GscRawRow[]
}

function mapRow(r: GscRawRow, dimNames: string[]): GscRow {
  const out: GscRow = {
    clicks: Number(r.clicks ?? 0),
    impressions: Number(r.impressions ?? 0),
    ctr: Number(r.ctr ?? 0),
    position: Number(r.position ?? 0),
  }
  const keys = r.keys ?? []
  for (let i = 0; i < dimNames.length; i++) {
    const v = keys[i]
    if (typeof v !== 'string') continue
    if (dimNames[i] === 'query') out.query = v
    else if (dimNames[i] === 'page') out.page = v
    else if (dimNames[i] === 'device') out.device = v
    else if (dimNames[i] === 'country') out.country = v
  }
  return out
}

export type GscReport = {
  range: { start: string; end: string; days: number }
  summary: { clicks: number; impressions: number; ctr: number; position: number }
  queries: GscRow[]
  pages: GscRow[]
  opportunities: GscRow[] // 노출 많은데 CTR 낮은 키워드 (콘텐츠 부족 신호)
  has_credentials: boolean
}

export async function fetchGscReport(args: {
  days?: number
  queryLimit?: number
  pageLimit?: number
  opportunityMinImpressions?: number
  opportunityMaxCtr?: number
}): Promise<GscReport> {
  const days = args.days ?? 7
  const queryLimit = args.queryLimit ?? 30
  const pageLimit = args.pageLimit ?? 20
  const oppMinImp = args.opportunityMinImpressions ?? 10
  const oppMaxCtr = args.opportunityMaxCtr ?? 0.02 // 2%

  const startDate = isoDaysAgo(days)
  const endDate = todayIso()
  const range = { start: startDate, end: endDate, days }

  // 인증 없으면 빈 결과 (UI에서 안내 표시)
  const creds = loadCredentials()
  if (!creds) {
    return {
      range,
      summary: { clicks: 0, impressions: 0, ctr: 0, position: 0 },
      queries: [],
      pages: [],
      opportunities: [],
      has_credentials: false,
    }
  }

  // 병렬 호출
  const [summaryRows, queryRows, pageRows, oppRows] = await Promise.all([
    gscQuery({ startDate, endDate, dimensions: [] }),
    gscQuery({ startDate, endDate, dimensions: ['query'], rowLimit: queryLimit }),
    gscQuery({ startDate, endDate, dimensions: ['page'], rowLimit: pageLimit }),
    gscQuery({ startDate, endDate, dimensions: ['query'], rowLimit: 200 }),
  ])

  const s = summaryRows[0]
  const summary = s
    ? {
        clicks: Number(s.clicks ?? 0),
        impressions: Number(s.impressions ?? 0),
        ctr: Number(s.ctr ?? 0),
        position: Number(s.position ?? 0),
      }
    : { clicks: 0, impressions: 0, ctr: 0, position: 0 }

  const queries = queryRows.map((r) => mapRow(r, ['query']))
  const pages = pageRows.map((r) => mapRow(r, ['page']))
  const opportunities = oppRows
    .map((r) => mapRow(r, ['query']))
    .filter((r) => r.impressions >= oppMinImp && r.ctr < oppMaxCtr && r.clicks <= 5)
    .sort((a, b) => b.impressions - a.impressions)
    .slice(0, 15)

  return { range, summary, queries, pages, opportunities, has_credentials: true }
}

// 일별(date) × 검색어/페이지 dimension — 트렌드 적재 cron 용
export type GscDailyQuery = {
  date: string
  query: string
  clicks: number
  impressions: number
  ctr: number
  position: number
}
export type GscDailyPage = {
  date: string
  page: string
  clicks: number
  impressions: number
  ctr: number
  position: number
}

export async function fetchGscDailyRows(args: { startDate: string; endDate: string; rowLimit?: number }): Promise<{
  queries: GscDailyQuery[]
  pages: GscDailyPage[]
  has_credentials: boolean
}> {
  const creds = loadCredentials()
  if (!creds) return { queries: [], pages: [], has_credentials: false }

  const rowLimit = args.rowLimit ?? 5000
  const [qRows, pRows] = await Promise.all([
    gscQuery({
      startDate: args.startDate,
      endDate: args.endDate,
      dimensions: ['date', 'query'],
      rowLimit,
    }),
    gscQuery({
      startDate: args.startDate,
      endDate: args.endDate,
      dimensions: ['date', 'page'],
      rowLimit,
    }),
  ])

  const queries: GscDailyQuery[] = qRows
    .map((r) => {
      const keys = r.keys ?? []
      const date = typeof keys[0] === 'string' ? keys[0] : ''
      const query = typeof keys[1] === 'string' ? keys[1] : ''
      if (!date || !query) return null
      return {
        date,
        query,
        clicks: Number(r.clicks ?? 0),
        impressions: Number(r.impressions ?? 0),
        ctr: Number(r.ctr ?? 0),
        position: Number(r.position ?? 0),
      }
    })
    .filter((x): x is GscDailyQuery => x !== null)

  const pages: GscDailyPage[] = pRows
    .map((r) => {
      const keys = r.keys ?? []
      const date = typeof keys[0] === 'string' ? keys[0] : ''
      const page = typeof keys[1] === 'string' ? keys[1] : ''
      if (!date || !page) return null
      return {
        date,
        page,
        clicks: Number(r.clicks ?? 0),
        impressions: Number(r.impressions ?? 0),
        ctr: Number(r.ctr ?? 0),
        position: Number(r.position ?? 0),
      }
    })
    .filter((x): x is GscDailyPage => x !== null)

  return { queries, pages, has_credentials: true }
}

// suggest-keywords 컨텍스트용 — LLM에 전달할 텍스트 빌더
export type GscContext = {
  text: string
  meta: {
    days: number
    top_query_count: number
    opportunity_count: number
  }
}

export async function buildGscContext(args: { days?: number } = {}): Promise<GscContext> {
  const days = args.days ?? 30
  try {
    const report = await fetchGscReport({ days, queryLimit: 25 })
    if (!report.has_credentials || report.summary.impressions === 0) {
      return {
        text: '## Google Search Console 시그널\n(GSC 데이터 없음 — env GSC_SERVICE_ACCOUNT_JSON 미설정 또는 노출 0)',
        meta: { days, top_query_count: 0, opportunity_count: 0 },
      }
    }

    const topLines = report.queries
      .slice(0, 15)
      .map(
        (q) =>
          `- "${q.query}" — 클릭 ${q.clicks}, 노출 ${q.impressions}, CTR ${(q.ctr * 100).toFixed(1)}%, 평균순위 ${q.position.toFixed(1)}`,
      )
      .join('\n')

    const oppLines = report.opportunities
      .slice(0, 10)
      .map(
        (q) =>
          `- "${q.query}" — 노출 ${q.impressions} (CTR ${(q.ctr * 100).toFixed(1)}% · 콘텐츠 보강 시 클릭 증가 기대)`,
      )
      .join('\n')

    const text = `## Google Search Console 시그널 (최근 ${days}일)

전체: 클릭 ${report.summary.clicks}, 노출 ${report.summary.impressions}, 평균 CTR ${(report.summary.ctr * 100).toFixed(2)}%, 평균 순위 ${report.summary.position.toFixed(1)}위

### 클릭 받은 검색어 Top 15
${topLines || '(없음)'}

### CTR 개선 기회 (노출은 많지만 클릭 적음 — 콘텐츠 부족·랭킹 낮음 신호)
${oppLines || '(없음)'}`

    return {
      text,
      meta: {
        days,
        top_query_count: report.queries.length,
        opportunity_count: report.opportunities.length,
      },
    }
  } catch (e) {
    return {
      text: `## Google Search Console 시그널\n(조회 실패: ${e instanceof Error ? e.message : String(e)})`,
      meta: { days, top_query_count: 0, opportunity_count: 0 },
    }
  }
}
