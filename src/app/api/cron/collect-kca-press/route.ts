import { NextResponse, type NextRequest } from 'next/server'
import { insertMarketRaw, isAuthorizedCron, type MarketRawInsert } from '@/lib/market-signals'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0 Safari/537.36'

// 한국소비자원 보도자료 — 직구·해외구매 키워드만 필터
const KEYWORDS = ['직구', '해외구매', '해외직구', '관세', '통관']

function looksRelevant(title: string): boolean {
  return KEYWORDS.some((k) => title.includes(k))
}

function decodeHtmlAmp(s: string): string {
  return s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
}

export async function GET(request: NextRequest) {
  if (!isAuthorizedCron(request))
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const res = await fetch('https://www.kca.go.kr/home/sub.do?menukey=4002', {
    headers: { 'User-Agent': UA, 'Accept-Language': 'ko-KR,ko;q=0.9' },
    cache: 'no-store',
  })
  if (!res.ok)
    return NextResponse.json({ error: `KCA ${res.status}` }, { status: 502 })
  const html = await res.text()

  // <a href="?menukey=4002&amp;mode=view&amp;no={id}" class="title" ...>제목</a>
  const re =
    /<a href="(\?menukey=4002&amp;mode=view&amp;no=(\d+)[^"]*)" class="title"[^>]*>([^<]+)<\/a>/g

  const rows: MarketRawInsert[] = []
  const seen = new Set<string>()
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) {
    const [, hrefRel, id, rawTitle] = m
    const title = rawTitle.trim()
    if (!title || !looksRelevant(title)) continue
    if (seen.has(id)) continue
    seen.add(id)
    const url = `https://www.kca.go.kr/home/sub.do${decodeHtmlAmp(hrefRel)}`
    rows.push({
      source: 'kca_press',
      dedup_key: id,
      source_url: url,
      title,
      external_id: id,
      metadata: { board: 'press', menukey: '4002' },
    })
  }

  const result = await insertMarketRaw(rows)
  return NextResponse.json({
    ok: true,
    matched: rows.length,
    inserted: result.inserted,
    executed_at: new Date().toISOString(),
  })
}
