// Google Analytics 4 Data API 클라이언트 (서버 전용)
//
// 인증:
//   prod (Vercel): GA4_SERVICE_ACCOUNT_JSON 환경변수 (base64 또는 raw JSON)
//   dev (로컬):    프로젝트 루트의 ga4-key.json 파일
//
// 짐스캐너 GA4 property ID: 526615735

import { BetaAnalyticsDataClient } from '@google-analytics/data'
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'

const PROPERTY_ID = process.env.GA4_PROPERTY_ID ?? '526615735'

type ServiceAccount = {
  client_email: string
  private_key: string
  [key: string]: unknown
}

function loadCredentials(): ServiceAccount | null {
  const env = process.env.GA4_SERVICE_ACCOUNT_JSON
  if (env) {
    try {
      const trimmed = env.trim()
      const text = trimmed.startsWith('{')
        ? trimmed
        : Buffer.from(trimmed, 'base64').toString('utf-8')
      return JSON.parse(text) as ServiceAccount
    } catch {
      return null
    }
  }
  const localPath = path.join(process.cwd(), 'ga4-key.json')
  if (existsSync(localPath)) {
    return JSON.parse(readFileSync(localPath, 'utf-8')) as ServiceAccount
  }
  return null
}

function getClient(): BetaAnalyticsDataClient | null {
  const creds = loadCredentials()
  if (!creds) return null
  return new BetaAnalyticsDataClient({ credentials: creds })
}

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86400000).toISOString().slice(0, 10)
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10)
}

export type Ga4PageRow = {
  page: string
  pageViews: number
  activeUsers: number
  bounceRate: number // 0..1
  avgSessionSec: number
}

export type Ga4ChannelRow = {
  channel: string
  sessions: number
  users: number
}

export type Ga4LandingRow = {
  page: string
  sessions: number
  activeUsers: number
}

export type Ga4Summary = {
  sessions: number
  activeUsers: number
  pageViews: number
  bounceRate: number
  avgSessionSec: number
}

export type Ga4Report = {
  range: { start: string; end: string; days: number }
  summary: Ga4Summary
  pages: Ga4PageRow[]
  channels: Ga4ChannelRow[]
  landings: Ga4LandingRow[]
  has_credentials: boolean
}

export async function fetchGa4Report(args: {
  days?: number
  pageLimit?: number
  excludeAdmin?: boolean
}): Promise<Ga4Report> {
  const days = args.days ?? 30
  const pageLimit = args.pageLimit ?? 50
  const excludeAdmin = args.excludeAdmin ?? true

  const startDate = isoDaysAgo(days)
  const endDate = todayIso()
  const range = { start: startDate, end: endDate, days }

  const client = getClient()
  if (!client) {
    return {
      range,
      summary: {
        sessions: 0,
        activeUsers: 0,
        pageViews: 0,
        bounceRate: 0,
        avgSessionSec: 0,
      },
      pages: [],
      channels: [],
      landings: [],
      has_credentials: false,
    }
  }

  const property = `properties/${PROPERTY_ID}`
  const dateRange = { startDate, endDate }

  const [summaryRes, pagesRes, channelsRes, landingsRes] = await Promise.all([
    client.runReport({
      property,
      dateRanges: [dateRange],
      metrics: [
        { name: 'sessions' },
        { name: 'activeUsers' },
        { name: 'screenPageViews' },
        { name: 'bounceRate' },
        { name: 'averageSessionDuration' },
      ],
    }),
    client.runReport({
      property,
      dateRanges: [dateRange],
      dimensions: [{ name: 'pagePath' }],
      metrics: [
        { name: 'screenPageViews' },
        { name: 'activeUsers' },
        { name: 'bounceRate' },
        { name: 'averageSessionDuration' },
      ],
      orderBys: [{ metric: { metricName: 'screenPageViews' }, desc: true }],
      limit: pageLimit,
    }),
    client.runReport({
      property,
      dateRanges: [dateRange],
      dimensions: [{ name: 'sessionDefaultChannelGroup' }],
      metrics: [{ name: 'sessions' }, { name: 'activeUsers' }],
      orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
    }),
    client.runReport({
      property,
      dateRanges: [dateRange],
      dimensions: [{ name: 'landingPage' }],
      metrics: [{ name: 'sessions' }, { name: 'activeUsers' }],
      orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
      limit: pageLimit,
    }),
  ])

  const sRow = summaryRes[0].rows?.[0]?.metricValues
  const summary: Ga4Summary = sRow
    ? {
        sessions: Number(sRow[0].value ?? 0),
        activeUsers: Number(sRow[1].value ?? 0),
        pageViews: Number(sRow[2].value ?? 0),
        bounceRate: Number(sRow[3].value ?? 0),
        avgSessionSec: Number(sRow[4].value ?? 0),
      }
    : {
        sessions: 0,
        activeUsers: 0,
        pageViews: 0,
        bounceRate: 0,
        avgSessionSec: 0,
      }

  const pages: Ga4PageRow[] = (pagesRes[0].rows ?? [])
    .map((r) => ({
      page: r.dimensionValues?.[0]?.value ?? '',
      pageViews: Number(r.metricValues?.[0]?.value ?? 0),
      activeUsers: Number(r.metricValues?.[1]?.value ?? 0),
      bounceRate: Number(r.metricValues?.[2]?.value ?? 0),
      avgSessionSec: Number(r.metricValues?.[3]?.value ?? 0),
    }))
    .filter((r) => (excludeAdmin ? !r.page.startsWith('/admin') : true))

  const channels: Ga4ChannelRow[] = (channelsRes[0].rows ?? []).map((r) => ({
    channel: r.dimensionValues?.[0]?.value ?? '',
    sessions: Number(r.metricValues?.[0]?.value ?? 0),
    users: Number(r.metricValues?.[1]?.value ?? 0),
  }))

  const landings: Ga4LandingRow[] = (landingsRes[0].rows ?? [])
    .map((r) => ({
      page: r.dimensionValues?.[0]?.value ?? '',
      sessions: Number(r.metricValues?.[0]?.value ?? 0),
      activeUsers: Number(r.metricValues?.[1]?.value ?? 0),
    }))
    .filter((r) => (excludeAdmin ? !r.page.startsWith('/admin') : true))

  return { range, summary, pages, channels, landings, has_credentials: true }
}
