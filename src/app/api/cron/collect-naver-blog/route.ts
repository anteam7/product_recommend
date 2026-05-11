import { NextResponse, type NextRequest } from 'next/server'
import { BLOG_SEARCH_QUERIES } from '@/lib/market-keywords'
import { insertMarketRaw, isAuthorizedCron, type MarketRawInsert } from '@/lib/market-signals'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

type NaverBlogItem = {
  title?: string
  link?: string
  description?: string
  bloggername?: string
  bloggerlink?: string
  postdate?: string
}

function stripTags(s: string | undefined): string {
  if (!s) return ''
  return s.replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim()
}

async function searchBlog(query: string): Promise<NaverBlogItem[]> {
  const id = process.env.NAVER_OPENAPI_CLIENT_ID
  const secret = process.env.NAVER_OPENAPI_CLIENT_SECRET
  if (!id || !secret) throw new Error('NAVER_OPENAPI 키 미설정')

  const url = `https://openapi.naver.com/v1/search/blog.json?query=${encodeURIComponent(query)}&display=15&sort=sim`
  const res = await fetch(url, {
    headers: {
      'X-Naver-Client-Id': id,
      'X-Naver-Client-Secret': secret,
    },
  })
  if (!res.ok) throw new Error(`Naver blog ${res.status}`)
  const json = (await res.json()) as { items?: NaverBlogItem[] }
  return json.items ?? []
}

export async function GET(request: NextRequest) {
  if (!isAuthorizedCron(request))
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const errors: { query: string; reason: string }[] = []
  const rows: MarketRawInsert[] = []

  for (const q of BLOG_SEARCH_QUERIES) {
    try {
      const items = await searchBlog(q)
      for (const item of items) {
        const url = item.link
        if (!url) continue
        rows.push({
          source: 'naver_blog',
          dedup_key: url,
          source_url: url,
          title: stripTags(item.title),
          query: q,
          metadata: {
            description: stripTags(item.description),
            bloggername: item.bloggername ?? null,
            postdate: item.postdate ?? null,
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
    queries: BLOG_SEARCH_QUERIES.length,
    fetched: rows.length,
    inserted: result.inserted,
    errors,
    executed_at: new Date().toISOString(),
  })
}
