/**
 * 한국소비자원 비교공감 게시판 수집기 — 정부 인증 1~3위 발표.
 *
 * 비교공감(Comparative Test Reports)은 KCA 가 카테고리별 제품 성능·안전
 * 비교를 매월 발표하는 코너. '소비자원 1위 [카테고리]' 검색 트래픽이
 * 발표 후 3-6개월 지속되므로 위탁 진입 후보 발굴의 핵심 시드.
 *
 * 기존 collect-kca-press 는 '직구·통관' 키워드만 필터하므로 비교공감
 * 게시물 자체가 통째로 누락된다. 본 cron 은 별개 게시판(menukey 다름)
 * 을 따로 수집해 jimscanner_market_raw 에 source='kca_comparative' 로 적재.
 *
 * 후속 LLM 정형화 cron 이 raw 를 읽어 jimscanner_kca_winners 테이블에
 * (브랜드·모델·평가 차원·SEO 핸들) 단위로 풀어낸다 — 본 라우트의 책임 X.
 */
import { NextResponse, type NextRequest } from 'next/server'
import { insertMarketRaw, isAuthorizedCron, type MarketRawInsert } from '@/lib/market-signals'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0 Safari/537.36'

// KCA 스마트컨슈머 > 비교공감 게시판.
// menukey 는 사이트 개편에 따라 변할 수 있으므로 ENV 로 override 가능.
const MENU_KEY = process.env.KCA_COMPARATIVE_MENUKEY ?? '7301'
const BASE = 'https://www.kca.go.kr/smartconsumer/sub.do'

function decodeHtmlAmp(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
}

interface ParsedRow {
  id: string
  title: string
  href: string
  postedAt?: string
}

function parseListing(html: string): ParsedRow[] {
  const rows: ParsedRow[] = []
  const seen = new Set<string>()

  // 패턴 A: <a href="?menukey=NNN&amp;mode=view&amp;no={id}" class="title">제목</a>
  const reTitle =
    /<a\s+href="(\?menukey=\d+&amp;mode=view&amp;no=(\d+)[^"]*)"\s+class="title"[^>]*>([^<]+)<\/a>/g
  let m: RegExpExecArray | null
  while ((m = reTitle.exec(html)) !== null) {
    const [, hrefRel, id, rawTitle] = m
    if (seen.has(id)) continue
    seen.add(id)
    rows.push({ id, title: decodeHtmlAmp(rawTitle).trim(), href: decodeHtmlAmp(hrefRel) })
  }

  // 패턴 B: 사이트 개편 후 list-item 변형
  if (rows.length === 0) {
    const reAlt = /href="([^"]*mode=view[^"]*no=(\d+)[^"]*)"[^>]*>\s*([^<]{4,200})\s*</g
    while ((m = reAlt.exec(html)) !== null) {
      const [, hrefRel, id, rawTitle] = m
      if (seen.has(id)) continue
      seen.add(id)
      const title = decodeHtmlAmp(rawTitle).trim()
      if (!title || /^(이전|다음|목록|view)$/i.test(title)) continue
      rows.push({ id, title, href: decodeHtmlAmp(hrefRel) })
    }
  }

  return rows
}

async function fetchListing(): Promise<string> {
  const url = `${BASE}?menukey=${MENU_KEY}`
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, 'Accept-Language': 'ko-KR,ko;q=0.9' },
    cache: 'no-store',
  })
  if (!res.ok) throw new Error(`KCA listing ${res.status}`)
  return await res.text()
}

async function fetchDetail(href: string): Promise<string | null> {
  try {
    const url = href.startsWith('http')
      ? href
      : `${BASE}${href.startsWith('?') ? href : `?${href}`}`
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept-Language': 'ko-KR,ko;q=0.9' },
      cache: 'no-store',
    })
    if (!res.ok) return null
    const html = await res.text()
    // 본문 영역만 발췌 (LLM 토큰 절감) — 대략 첫 8KB 텍스트
    const text = html
      .replace(/<script[\s\S]*?<\/script>/g, '')
      .replace(/<style[\s\S]*?<\/style>/g, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 8000)
    return text
  } catch {
    return null
  }
}

export async function GET(request: NextRequest) {
  if (!isAuthorizedCron(request))
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const url = new URL(request.url)
  const fetchBody = url.searchParams.get('body') !== '0'
  const maxDetails = Math.min(parseInt(url.searchParams.get('details') ?? '8', 10) || 8, 20)

  let listingHtml: string
  try {
    listingHtml = await fetchListing()
  } catch (err) {
    return NextResponse.json(
      { error: `KCA listing fetch failed: ${(err as Error).message}`, menukey: MENU_KEY },
      { status: 502 },
    )
  }

  const parsed = parseListing(listingHtml)
  if (parsed.length === 0) {
    return NextResponse.json({
      ok: true,
      matched: 0,
      inserted: 0,
      menukey: MENU_KEY,
      note: 'No rows matched — site layout may have changed; set KCA_COMPARATIVE_MENUKEY env.',
      executed_at: new Date().toISOString(),
    })
  }

  // 본문은 상위 N건만 (LLM 입력 비용·요청 시간 가드)
  const detailBodies = new Map<string, string>()
  if (fetchBody) {
    const head = parsed.slice(0, maxDetails)
    const bodies = await Promise.all(head.map((p) => fetchDetail(p.href)))
    head.forEach((p, i) => {
      const b = bodies[i]
      if (b) detailBodies.set(p.id, b)
    })
  }

  const rows: MarketRawInsert[] = parsed.map((p) => {
    const fullUrl = `${BASE}${p.href.startsWith('?') ? p.href : `?${p.href}`}`
    const body = detailBodies.get(p.id) ?? null
    return {
      source: 'kca_comparative' as const,
      dedup_key: p.id,
      source_url: fullUrl,
      title: p.title,
      external_id: p.id,
      metadata: {
        board: 'comparative',
        menukey: MENU_KEY,
        body_excerpt: body,
        body_chars: body?.length ?? 0,
      },
    }
  })

  const result = await insertMarketRaw(rows)
  return NextResponse.json({
    ok: true,
    menukey: MENU_KEY,
    matched: rows.length,
    inserted: result.inserted,
    bodies_fetched: detailBodies.size,
    executed_at: new Date().toISOString(),
  })
}
