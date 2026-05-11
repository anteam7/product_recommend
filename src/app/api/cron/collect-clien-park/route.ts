import { NextResponse, type NextRequest } from 'next/server'
import { insertMarketRaw, isAuthorizedCron, type MarketRawInsert } from '@/lib/market-signals'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0 Safari/537.36'

// 직구 관련 신호로 식별할 키워드 (글 제목 기준 client-side 필터)
const KEYWORDS = [
  '직구', '해외구매', '해외직구',
  '아마존', '라쿠텐', '타오바오', '메루카리', 'eBay', '알리',
  '관세', '통관', '배대지', '면세', '개인통관',
]

function looksRelevant(title: string): boolean {
  return KEYWORDS.some((k) => title.includes(k))
}

export async function GET(request: NextRequest) {
  if (!isAuthorizedCron(request))
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const res = await fetch('https://www.clien.net/service/board/park', {
    headers: { 'User-Agent': UA, 'Accept-Language': 'ko-KR,ko;q=0.9' },
    cache: 'no-store',
  })
  if (!res.ok)
    return NextResponse.json({ error: `Clien ${res.status}` }, { status: 502 })
  const html = await res.text()

  // <a class="list_subject" href="/service/board/park/{id}?..."> ... title="제목" ...
  const re =
    /<a class="list_subject" href="(\/service\/board\/park\/(\d+)[^"]*)"[^>]*>[\s\S]*?title="([^"]+)"/g

  const rows: MarketRawInsert[] = []
  const seen = new Set<string>()
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) {
    const [, hrefRel, id, rawTitle] = m
    const title = rawTitle.trim()
    if (!title || !looksRelevant(title)) continue
    if (seen.has(id)) continue
    seen.add(id)
    rows.push({
      source: 'clien_park',
      dedup_key: id,
      source_url: `https://www.clien.net${hrefRel}`,
      title,
      external_id: id,
      metadata: { board: 'park' },
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
