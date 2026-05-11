import { NextResponse, type NextRequest } from 'next/server'
import { insertMarketRaw, isAuthorizedCron, type MarketRawInsert } from '@/lib/market-signals'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0 Safari/537.36'

export async function GET(request: NextRequest) {
  if (!isAuthorizedCron(request))
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const res = await fetch('https://quasarzone.com/bbs/qb_saleinfo', {
    headers: { 'User-Agent': UA, 'Accept-Language': 'ko-KR,ko;q=0.9' },
    cache: 'no-store',
  })
  if (!res.ok)
    return NextResponse.json({ error: `Quasarzone ${res.status}` }, { status: 502 })
  const html = await res.text()

  // 진행중 핫딜 항목: <a href="/bbs/qb_saleinfo/views/{id}" class="subject-link "> ... <span class="ellipsis-with-reply-cnt">제목</span>
  // 공지 (subject-link 끝에 trailing space 없음) 는 의도적으로 제외
  const re =
    /<a href="(\/bbs\/qb_saleinfo\/views\/(\d+))" class="subject-link\s+"[^>]*>[\s\S]*?<span class="ellipsis-with-reply-cnt">([^<]+)<\/span>/g

  const rows: MarketRawInsert[] = []
  const seen = new Set<string>()
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) {
    const [, hrefRel, id, rawTitle] = m
    const title = rawTitle.trim()
    if (!title || seen.has(id)) continue
    seen.add(id)

    // 제목 prefix 의 [사이트] 라벨 추출 — 예: "[기타] 폰드몰 ...", "[스팀] 언더테일"
    const labelMatch = title.match(/^\[([^\]]+)\]\s*(.*)$/)
    const siteLabel = labelMatch ? labelMatch[1] : null
    const cleanTitle = labelMatch ? labelMatch[2] : title

    rows.push({
      source: 'quasarzone_sale',
      dedup_key: id,
      source_url: `https://quasarzone.com${hrefRel}`,
      title,
      external_id: id,
      metadata: {
        site_label: siteLabel,
        clean_title: cleanTitle,
      },
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
