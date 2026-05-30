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

    // 제목 prefix 의 [라벨] 제거 → clean_title (핫딜 수요 보드 군집화용, quasarzone 과 동일 규약)
    const labelMatch = title.match(/^\[([^\]]+)\]\s*(.*)$/)
    const cleanTitle = labelMatch ? labelMatch[2] : title

    // 댓글/조회 카운트는 같은 list_item 블록 안의 후행 마크업에 있음 — best-effort 윈도우 파싱.
    // 못 찾으면 생략(보드는 0 으로 처리). 메인 regex 는 건드리지 않아 수집 안정성 유지.
    const window = html.slice(m.index, m.index + 1200)
    const replyM = window.match(/rSymph05[^>]*>\s*([\d,]+)/)
    const viewM = window.match(/(?:view_count|hit)[^>]*>\s*([\d,]+)/)
    const replyCnt = replyM ? Number(replyM[1].replace(/,/g, '')) : null
    const viewCnt = viewM ? Number(viewM[1].replace(/,/g, '')) : null

    const metadata: Record<string, unknown> = { board: 'park', clean_title: cleanTitle }
    if (replyCnt != null && Number.isFinite(replyCnt)) metadata.reply_cnt = replyCnt
    if (viewCnt != null && Number.isFinite(viewCnt)) metadata.view_cnt = viewCnt

    rows.push({
      source: 'clien_park',
      dedup_key: id,
      source_url: `https://www.clien.net${hrefRel}`,
      title,
      external_id: id,
      metadata,
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
