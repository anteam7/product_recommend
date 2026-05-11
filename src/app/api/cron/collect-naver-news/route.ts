import { NextResponse, type NextRequest } from 'next/server'
import { GOV_NEWS_QUERIES } from '@/lib/market-keywords'
import { insertMarketRaw, isAuthorizedCron, type MarketRawInsert } from '@/lib/market-signals'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

type NaverNewsItem = {
  title?: string
  originallink?: string
  link?: string
  description?: string
  pubDate?: string
}

function stripTags(s: string | undefined): string {
  if (!s) return ''
  return s.replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim()
}

async function searchNews(query: string): Promise<NaverNewsItem[]> {
  const id = process.env.NAVER_OPENAPI_CLIENT_ID
  const secret = process.env.NAVER_OPENAPI_CLIENT_SECRET
  if (!id || !secret) throw new Error('NAVER_OPENAPI 키 미설정')

  const url = `https://openapi.naver.com/v1/search/news.json?query=${encodeURIComponent(query)}&display=20&sort=date`
  const res = await fetch(url, {
    headers: {
      'X-Naver-Client-Id': id,
      'X-Naver-Client-Secret': secret,
    },
  })
  if (!res.ok) throw new Error(`Naver news ${res.status}`)
  const json = (await res.json()) as { items?: NaverNewsItem[] }
  return json.items ?? []
}

export async function GET(request: NextRequest) {
  if (!isAuthorizedCron(request))
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const errors: { query: string; reason: string }[] = []
  const rows: MarketRawInsert[] = []

  for (const q of GOV_NEWS_QUERIES) {
    try {
      const items = await searchNews(q)
      for (const item of items) {
        const url = item.originallink || item.link
        if (!url) continue
        rows.push({
          source: 'naver_news',
          dedup_key: url,
          source_url: url,
          title: stripTags(item.title),
          query: q,
          metadata: {
            description: stripTags(item.description),
            originallink: item.originallink ?? null,
            naver_link: item.link ?? null,
            pubDate: item.pubDate ?? null,
            search_query: q,
          },
        })
      }
    } catch (e) {
      errors.push({ query: q, reason: e instanceof Error ? e.message : String(e) })
    }
  }

  const result = await insertMarketRaw(rows)
  return NextResponse.json({
    ok: true,
    queries: GOV_NEWS_QUERIES.length,
    fetched: rows.length,
    inserted: result.inserted,
    errors,
    executed_at: new Date().toISOString(),
  })
}
