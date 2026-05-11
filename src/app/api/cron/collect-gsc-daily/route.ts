// /api/cron/collect-gsc-daily — GSC 일별 데이터를 jimscanner_gsc_queries / jimscanner_gsc_pages 에 적재.
// 매일 03:00 KST(=18:00 UTC 전날) 실행. GSC 는 3일 지연 데이터가 가장 정확하므로
// 매번 최근 7일을 다시 pull → upsert (PK (date, query) / (date, page) 충돌 시 update).
// 트렌드 분석(이번주 vs 지난주 검색어 변화) 가능하게 하는 게 목적.

import { NextResponse, type NextRequest } from 'next/server'
import { fetchGscDailyRows } from '@/lib/search-console'
import { isAuthorizedCron } from '@/lib/market-signals'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

const WINDOW_DAYS = 7

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86400000).toISOString().slice(0, 10)
}
function todayIso(): string {
  return new Date().toISOString().slice(0, 10)
}

// GSC Domain property 는 동일 path 의 www·non-www 를 별행으로 돌려줌.
// 풀 URL → path 만 추출해서 (date, path) 단위로 합산해야 PK 충돌이 같은 path 를 갱신.
// 도메인 마이그레이션(www → non-www) 이전에 적재된 풀 URL row 는 그대로 남아있음.
function stripHost(page: string): string {
  if (!page) return ''
  if (page.startsWith('/')) return page
  try {
    return new URL(page).pathname || '/'
  } catch {
    return page
  }
}

export async function GET(request: NextRequest) {
  if (!isAuthorizedCron(request))
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const startDate = isoDaysAgo(WINDOW_DAYS)
  const endDate = todayIso()

  const { queries, pages, has_credentials } = await fetchGscDailyRows({ startDate, endDate })
  if (!has_credentials) {
    return NextResponse.json({ ok: false, reason: 'no_credentials' }, { status: 200 })
  }

  const admin = createAdminClient()

  // upsert: PK (date, query) / (date, page) 충돌 시 update
  let queryUpserted = 0
  let pageUpserted = 0
  const errors: string[] = []

  if (queries.length > 0) {
    // 청크로 나눠 upsert (500 단위)
    for (let i = 0; i < queries.length; i += 500) {
      const chunk = queries.slice(i, i + 500).map((q) => ({
        date: q.date,
        query: q.query,
        clicks: q.clicks,
        impressions: q.impressions,
        ctr: q.ctr,
        position: q.position,
        collected_at: new Date().toISOString(),
      }))
      const { error, count } = await admin
        .from('jimscanner_gsc_queries')
        .upsert(chunk, { onConflict: 'date,query', count: 'exact' })
      if (error) errors.push(`queries chunk ${i}: ${error.message}`)
      else queryUpserted += count ?? chunk.length
    }
  }

  // page: 풀 URL → path 추출 후 (date, path) 단위 합산.
  type AggPage = { date: string; page: string; clicks: number; impressions: number; position: number }
  const aggMap = new Map<string, AggPage>()
  for (const p of pages) {
    const path = stripHost(p.page)
    if (!path) continue
    const key = `${p.date}|${path}`
    const ex = aggMap.get(key)
    if (ex) {
      const totalImp = ex.impressions + p.impressions
      ex.position =
        totalImp > 0
          ? (ex.position * ex.impressions + p.position * p.impressions) / totalImp
          : 0
      ex.clicks += p.clicks
      ex.impressions = totalImp
    } else {
      aggMap.set(key, {
        date: p.date,
        page: path,
        clicks: p.clicks,
        impressions: p.impressions,
        position: p.position,
      })
    }
  }
  const aggregatedPages = [...aggMap.values()]

  if (aggregatedPages.length > 0) {
    for (let i = 0; i < aggregatedPages.length; i += 500) {
      const chunk = aggregatedPages.slice(i, i + 500).map((p) => ({
        date: p.date,
        page: p.page,
        clicks: p.clicks,
        impressions: p.impressions,
        ctr: p.impressions > 0 ? p.clicks / p.impressions : 0,
        position: p.position,
        collected_at: new Date().toISOString(),
      }))
      const { error, count } = await admin
        .from('jimscanner_gsc_pages')
        .upsert(chunk, { onConflict: 'date,page', count: 'exact' })
      if (error) errors.push(`pages chunk ${i}: ${error.message}`)
      else pageUpserted += count ?? chunk.length
    }
  }

  return NextResponse.json({
    ok: errors.length === 0,
    range: { start: startDate, end: endDate },
    queries_upserted: queryUpserted,
    pages_upserted: pageUpserted,
    errors,
    executed_at: new Date().toISOString(),
  })
}
