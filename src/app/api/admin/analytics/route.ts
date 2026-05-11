// /api/admin/analytics?days=30 — GSC + GA4 매칭 데이터 (어드민 전용)
//
// GSC 페이지별 (노출/CTR/순위) × GA4 페이지별 (PV/이탈률/체류) 을
// 페이지 경로(pathname)로 left/right outer-merge.
// 페이지 절대 URL 은 GSC 가 host 포함 (https://jimscanner.co.kr/...) ↔ GA4 는 path 만.
// 매칭 키로 path 만 추출. GSC Domain property 는 www/non-www 를 별행으로 돌려주므로
// 같은 path 가 두 번 들어올 수 있어 합산(클릭·노출 sum, 순위는 노출 가중 평균) 처리.

import { NextResponse, type NextRequest } from 'next/server'
import { createClient, isAdminEmail } from '@/lib/auth/server'
import { fetchGscReport } from '@/lib/search-console'
import { fetchGa4Report } from '@/lib/ga4'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 30

const VALID_DAYS = new Set([7, 14, 30, 90])
const SITE_HOSTS = ['https://jimscanner.co.kr', 'https://www.jimscanner.co.kr']

async function requireAdmin() {
  const sb = await createClient()
  const {
    data: { user },
  } = await sb.auth.getUser()
  if (!user || !isAdminEmail(user.email)) return null
  return user
}

function toPath(input: string | undefined): string {
  if (!input) return ''
  if (input.startsWith('/')) return input
  for (const host of SITE_HOSTS) {
    if (input.startsWith(host)) return input.slice(host.length) || '/'
  }
  try {
    const u = new URL(input)
    return u.pathname || '/'
  } catch {
    return input
  }
}

export type MergedRow = {
  page: string
  // GSC
  gscClicks: number
  gscImpressions: number
  gscCtr: number
  gscPosition: number
  // GA4
  pageViews: number
  activeUsers: number
  bounceRate: number
  avgSessionSec: number
  // 진단
  hasGsc: boolean
  hasGa4: boolean
  diagnosis: string[] // 'opportunity' | 'high_bounce' | 'no_traffic' | 'star' | ...
}

export type AnalyticsResponse = {
  range: { start: string; end: string; days: number }
  has_gsc: boolean
  has_ga4: boolean
  gsc_summary: { clicks: number; impressions: number; ctr: number; position: number }
  ga4_summary: {
    sessions: number
    activeUsers: number
    pageViews: number
    bounceRate: number
    avgSessionSec: number
  }
  channels: { channel: string; sessions: number; users: number }[]
  landings: { page: string; sessions: number; activeUsers: number }[]
  rows: MergedRow[]
  errors: string[]
}

function diagnose(row: Omit<MergedRow, 'diagnosis'>): string[] {
  const tags: string[] = []
  // 노출 많은데 클릭 적음 (CTR 누수)
  if (row.gscImpressions >= 200 && row.gscCtr < 0.01) tags.push('ctr_leak')
  else if (row.gscImpressions >= 100 && row.gscCtr < 0.015) tags.push('ctr_low')
  // 들어왔는데 이탈 높음 (이탈률 60% 이상 + PV 30 이상)
  if (row.pageViews >= 30 && row.bounceRate >= 0.6) tags.push('high_bounce')
  // 짧은 체류 + PV 많음
  if (row.pageViews >= 30 && row.avgSessionSec > 0 && row.avgSessionSec < 30) tags.push('short_stay')
  // 노출은 있는데 GA4 PV 거의 없음 (클릭이 정말 안 됨)
  if (row.gscImpressions >= 100 && row.pageViews < 5) tags.push('clicks_dry')
  // 별 (잘 나오는 페이지)
  if (row.gscClicks >= 10 && row.gscCtr >= 0.05 && row.bounceRate < 0.4) tags.push('star')
  return tags
}

export async function GET(request: NextRequest) {
  const user = await requireAdmin()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const url = new URL(request.url)
  const daysRaw = Number(url.searchParams.get('days') ?? 30)
  const days = VALID_DAYS.has(daysRaw) ? daysRaw : 30

  const errors: string[] = []
  const [gscSettled, ga4Settled] = await Promise.allSettled([
    fetchGscReport({ days, pageLimit: 100 }),
    fetchGa4Report({ days, pageLimit: 100, excludeAdmin: true }),
  ])

  const gsc =
    gscSettled.status === 'fulfilled'
      ? gscSettled.value
      : (errors.push(`GSC: ${gscSettled.reason}`),
        null)
  const ga4 =
    ga4Settled.status === 'fulfilled'
      ? ga4Settled.value
      : (errors.push(`GA4: ${ga4Settled.reason}`),
        null)

  const rangeStart = gsc?.range.start ?? ga4?.range.start ?? ''
  const rangeEnd = gsc?.range.end ?? ga4?.range.end ?? ''

  // GSC pages → path
  const byPath = new Map<string, Omit<MergedRow, 'diagnosis'>>()

  if (gsc) {
    for (const p of gsc.pages) {
      const pagePath = toPath(p.page)
      const existing = byPath.get(pagePath)
      if (existing) {
        // GSC Domain property 가 www/non-www 를 별행으로 돌려준 경우 합산.
        const totalImp = existing.gscImpressions + p.impressions
        const totalClicks = existing.gscClicks + p.clicks
        existing.gscPosition =
          totalImp > 0
            ? (existing.gscPosition * existing.gscImpressions + p.position * p.impressions) / totalImp
            : 0
        existing.gscClicks = totalClicks
        existing.gscImpressions = totalImp
        existing.gscCtr = totalImp > 0 ? totalClicks / totalImp : 0
      } else {
        byPath.set(pagePath, {
          page: pagePath,
          gscClicks: p.clicks,
          gscImpressions: p.impressions,
          gscCtr: p.ctr,
          gscPosition: p.position,
          pageViews: 0,
          activeUsers: 0,
          bounceRate: 0,
          avgSessionSec: 0,
          hasGsc: true,
          hasGa4: false,
        })
      }
    }
  }

  if (ga4) {
    for (const p of ga4.pages) {
      const pagePath = toPath(p.page)
      const existing = byPath.get(pagePath)
      if (existing) {
        existing.pageViews = p.pageViews
        existing.activeUsers = p.activeUsers
        existing.bounceRate = p.bounceRate
        existing.avgSessionSec = p.avgSessionSec
        existing.hasGa4 = true
      } else {
        byPath.set(pagePath, {
          page: pagePath,
          gscClicks: 0,
          gscImpressions: 0,
          gscCtr: 0,
          gscPosition: 0,
          pageViews: p.pageViews,
          activeUsers: p.activeUsers,
          bounceRate: p.bounceRate,
          avgSessionSec: p.avgSessionSec,
          hasGsc: false,
          hasGa4: true,
        })
      }
    }
  }

  const rows: MergedRow[] = [...byPath.values()]
    .map((r) => ({ ...r, diagnosis: diagnose(r) }))
    // 정렬: GSC 노출 + GA4 PV 합 desc
    .sort((a, b) => b.gscImpressions + b.pageViews * 5 - (a.gscImpressions + a.pageViews * 5))

  const response: AnalyticsResponse = {
    range: { start: rangeStart, end: rangeEnd, days },
    has_gsc: gsc?.has_credentials ?? false,
    has_ga4: ga4?.has_credentials ?? false,
    gsc_summary: gsc?.summary ?? { clicks: 0, impressions: 0, ctr: 0, position: 0 },
    ga4_summary:
      ga4?.summary ?? {
        sessions: 0,
        activeUsers: 0,
        pageViews: 0,
        bounceRate: 0,
        avgSessionSec: 0,
      },
    channels: ga4?.channels ?? [],
    landings: (ga4?.landings ?? []).map((l) => ({
      page: toPath(l.page),
      sessions: l.sessions,
      activeUsers: l.activeUsers,
    })),
    rows,
    errors,
  }

  return NextResponse.json(response)
}
