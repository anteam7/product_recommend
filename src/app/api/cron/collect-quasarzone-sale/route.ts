import { NextResponse, type NextRequest } from 'next/server'
import { insertMarketRaw, isAuthorizedCron, type MarketRawInsert } from '@/lib/market-signals'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0 Safari/537.36'

const LIST_URL = 'https://quasarzone.com/bbs/qb_saleinfo'

/**
 * 'YYYY-MM-DD HH:MM[:SS]' / 'YYYY.MM.DD HH:MM' / 'N분전' / 'N시간전' / 'N일전' / 'HH:MM' 형태를
 * ISO timestamp(UTC) 로 정규화. 못 알아내면 null.
 */
function parsePostedAt(s: string | null): string | null {
  if (!s) return null
  const t = s.trim()
  if (!t) return null
  const now = new Date()

  const rel = t.match(/^(\d+)\s*(분|시간|일)\s*전/)
  if (rel) {
    const n = parseInt(rel[1], 10)
    const unit = rel[2]
    const ms = unit === '분' ? n * 60_000 : unit === '시간' ? n * 3_600_000 : n * 86_400_000
    return new Date(now.getTime() - ms).toISOString()
  }

  // 오늘만 표시되는 HH:MM
  const hm = t.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/)
  if (hm) {
    const d = new Date(now)
    d.setHours(parseInt(hm[1], 10), parseInt(hm[2], 10), hm[3] ? parseInt(hm[3], 10) : 0, 0)
    return d.toISOString()
  }

  // 2026-05-28 13:24 또는 2026.05.28 13:24
  const abs = t.match(/(\d{4})[-.\/](\d{1,2})[-.\/](\d{1,2})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/)
  if (abs) {
    const y = parseInt(abs[1], 10)
    const mo = parseInt(abs[2], 10) - 1
    const d = parseInt(abs[3], 10)
    const hh = abs[4] ? parseInt(abs[4], 10) : 0
    const mm = abs[5] ? parseInt(abs[5], 10) : 0
    const ss = abs[6] ? parseInt(abs[6], 10) : 0
    // 한국 시간으로 가정 → UTC 보정 (KST = UTC+9)
    const local = new Date(Date.UTC(y, mo, d, hh - 9, mm, ss))
    return local.toISOString()
  }
  return null
}

/**
 * 한 게시글 row 의 HTML 조각에서 reply count / posted_at / sold-out 추출.
 * 마크업이 자주 바뀌어도 죽지 않도록 모두 best-effort.
 */
function extractRowMeta(chunk: string): {
  reply_count: number | null
  posted_at_raw: string | null
  posted_at: string | null
  sold_out: boolean
} {
  // 댓글 수: 다양한 패턴을 시도
  //   <span class="ca-cnt">[12]</span>
  //   <span class="reply-count">12</span>
  //   <em class="ctn-count">[12]</em>
  let reply_count: number | null = null
  const replyPatterns = [
    /class="ca-cnt"[^>]*>\s*\[?\s*(\d+)\s*\]?/i,
    /class="[^"]*reply[^"]*"[^>]*>\s*\[?\s*(\d+)\s*\]?/i,
    /class="[^"]*comment[^"]*"[^>]*>\s*\[?\s*(\d+)\s*\]?/i,
    // ellipsis-with-reply-cnt 뒤에 곧바로 [N] 형태가 오는 패턴
    /ellipsis-with-reply-cnt[\s\S]{0,200}?\[(\d+)\]/i,
  ]
  for (const re of replyPatterns) {
    const m = chunk.match(re)
    if (m) {
      reply_count = parseInt(m[1], 10)
      break
    }
  }

  // 작성시각: <span class="date">2026-05-28 13:24</span> 또는 '시간전'
  let posted_at_raw: string | null = null
  const dateMatch =
    chunk.match(/class="date"[^>]*>\s*([^<]+?)\s*</) ??
    chunk.match(/>(\d{4}[-.\/]\d{1,2}[-.\/]\d{1,2}(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?)</) ??
    chunk.match(/>(\d+\s*(?:분|시간|일)\s*전)</) ??
    chunk.match(/>(\d{1,2}:\d{2})</)
  if (dateMatch) posted_at_raw = dateMatch[1].trim()
  const posted_at = parsePostedAt(posted_at_raw)

  // 품절 / 종료 배지: 제목 옆 span 또는 라벨
  const sold_out =
    /품절/.test(chunk) ||
    /종료/.test(chunk) ||
    /sold[-_ ]?out/i.test(chunk) ||
    /class="[^"]*end[^"]*"/i.test(chunk)

  return { reply_count, posted_at_raw, posted_at, sold_out }
}

export async function GET(request: NextRequest) {
  if (!isAuthorizedCron(request))
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const res = await fetch(LIST_URL, {
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

  // 각 매치의 위치를 알아야 row chunk 를 잘라낼 수 있어 별도로 indexes 를 모은다
  type Hit = { idx: number; hrefRel: string; id: string; rawTitle: string }
  const hits: Hit[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) {
    hits.push({ idx: m.index, hrefRel: m[1], id: m[2], rawTitle: m[3] })
  }

  const rows: MarketRawInsert[] = []
  const seen = new Set<string>()
  const now = Date.now()
  for (let i = 0; i < hits.length; i++) {
    const h = hits[i]
    if (seen.has(h.id)) continue
    seen.add(h.id)
    const title = h.rawTitle.trim()
    if (!title) continue

    // 같은 row 범위로 추정되는 chunk: 다음 hit 직전까지, 단 4kb 상한
    const nextIdx = i + 1 < hits.length ? hits[i + 1].idx : Math.min(html.length, h.idx + 4000)
    const chunkEnd = Math.min(nextIdx, h.idx + 4000)
    const chunk = html.slice(h.idx, chunkEnd)

    // 제목 prefix 의 [사이트] 라벨 추출 — 예: "[기타] 폰드몰 ...", "[스팀] 언더테일"
    const labelMatch = title.match(/^\[([^\]]+)\]\s*(.*)$/)
    const siteLabel = labelMatch ? labelMatch[1] : null
    const cleanTitle = labelMatch ? labelMatch[2] : title

    const meta = extractRowMeta(chunk)
    const postedTs = meta.posted_at ? Date.parse(meta.posted_at) : NaN
    const hoursSincePost =
      Number.isFinite(postedTs) && postedTs > 0 ? Math.max(0.25, (now - postedTs) / 3_600_000) : null
    const replyVelocity =
      meta.reply_count != null && hoursSincePost != null && hoursSincePost > 0
        ? Number((meta.reply_count / hoursSincePost).toFixed(3))
        : null

    rows.push({
      source: 'quasarzone_sale',
      dedup_key: h.id,
      source_url: `https://quasarzone.com${h.hrefRel}`,
      title,
      external_id: h.id,
      metadata: {
        site_label: siteLabel,
        clean_title: cleanTitle,
        reply_count: meta.reply_count,
        posted_at_raw: meta.posted_at_raw,
        posted_at: meta.posted_at,
        hours_since_post: hoursSincePost,
        reply_velocity: replyVelocity,
        sold_out: meta.sold_out,
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
