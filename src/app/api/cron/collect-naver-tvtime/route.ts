/**
 * 네이버 SERP `홈쇼핑 편성표` tvtime 위젯 수집기 — Vercel Cron 버전.
 *
 * 운영 의도: 로컬 WSL 호스트가 꺼져 있어도 TV 편성표는 누락 없이 수집되도록
 * 클라우드(Vercel)에서 매일 일정시각 1~2회 호출.
 *
 * 적재 테이블:
 *  - jimscanner_trends_raw      (HTML 잘라서 보존)
 *  - jimscanner_trends_keywords (상품명 시계열 row, source='naver_tvtime')
 *  - jimscanner_trends_runs     (감사 로그)
 *
 * 스케줄: vercel.json 에서 KST 04:10 + 17:10 로 등록.
 *  (Vercel Cron 은 UTC. KST 04:10 = UTC 19:10, KST 17:10 = UTC 08:10)
 */
import { NextResponse, type NextRequest } from 'next/server'
import { isAuthorizedCron } from '@/lib/market-signals'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import type { Json } from '@/lib/supabase'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

const SOURCE = 'naver_tvtime'
const URL_TARGET =
  'https://search.naver.com/search.naver?query=' + encodeURIComponent('홈쇼핑 편성표')
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36'

interface Slot {
  product: string
  time: string
  channel: string | null
}

function safeKeyword(s: string, max = 200): string {
  return s.replace(/\s+/g, ' ').trim().slice(0, max)
}

// 홈쇼핑 채널 정규화 사전 — 위젯 HTML 내 등장 위치로 각 슬롯의 편성사를 추정.
// 채널 다중성(여러 사가 같은 상품을 편성)이 '프로 MD 다중 검증' 신호의 핵심.
const CHANNEL_PATTERNS: { canon: string; re: RegExp }[] = [
  { canon: 'GS샵', re: /GS\s*샵|GS\s*SHOP|지에스샵/i },
  { canon: 'CJ온스타일', re: /CJ\s*온스타일|CJ\s*ONSTYLE|온스타일/i },
  { canon: '롯데홈쇼핑', re: /롯데\s*(홈쇼핑|원티비|onetv)?/i },
  { canon: '현대홈쇼핑', re: /현대\s*(홈쇼핑|hmall)?/i },
  { canon: 'NS홈쇼핑', re: /NS\s*(홈쇼핑|shop)?/i },
  { canon: '공영쇼핑', re: /공영\s*쇼핑/i },
  { canon: '신세계쇼핑', re: /신세계\s*(쇼핑|tv)?/i },
  { canon: 'SK스토아', re: /SK\s*스토아|SK\s*stoa/i },
  { canon: '쇼핑엔티', re: /쇼핑\s*엔티|쇼핑엔티|shopnt/i },
  { canon: '홈앤쇼핑', re: /홈\s*앤\s*쇼핑|홈앤쇼핑|home\s*&?\s*shopping/i },
  { canon: 'K쇼핑', re: /K\s*쇼핑/i },
  { canon: 'W쇼핑', re: /W\s*쇼핑|더블유\s*쇼핑/i },
]

// 위젯 HTML 에서 각 채널명이 처음/매번 등장하는 위치(index)를 모아 정렬.
// 슬롯 li 의 위치보다 앞선 가장 가까운 채널 마커를 그 슬롯의 편성사로 본다.
function buildChannelMarkers(widget: string): { idx: number; canon: string }[] {
  const markers: { idx: number; canon: string }[] = []
  for (const { canon, re } of CHANNEL_PATTERNS) {
    const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g')
    let m: RegExpExecArray | null
    while ((m = g.exec(widget)) !== null) {
      markers.push({ idx: m.index, canon })
      if (m.index === g.lastIndex) g.lastIndex++ // zero-width 방어
    }
  }
  return markers.sort((a, b) => a.idx - b.idx)
}

function channelAt(markers: { idx: number; canon: string }[], pos: number): string | null {
  let found: string | null = null
  for (const mk of markers) {
    if (mk.idx <= pos) found = mk.canon
    else break
  }
  return found
}

function extractSlots(html: string): Slot[] {
  const tvtimeIdx = html.indexOf('tvtime')
  if (tvtimeIdx < 0) return []
  const widget = html.slice(Math.max(0, tvtimeIdx - 1000), tvtimeIdx + 80000)
  const markers = buildChannelMarkers(widget)

  const slots: Slot[] = []
  const liRe = /<li[^>]*>[\s\S]*?<\/li>/g
  let m: RegExpExecArray | null
  while ((m = liRe.exec(widget)) !== null) {
    const li = m[0]
    const liPos = m.index
    if (!/[01]?\d:[0-5]\d/.test(li)) continue
    const text = li.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
    if (text.length > 250 || !/[가-힣]{2,}/.test(text)) continue

    const channel = channelAt(markers, liPos)

    const tokens = text.split(/(\d{1,2}:[0-5]\d)/g)
    let prevTime = ''
    for (let i = 0; i < tokens.length; i++) {
      const tok = tokens[i].trim()
      if (/^\d{1,2}:[0-5]\d$/.test(tok)) {
        prevTime = tok
        continue
      }
      if (!tok || tok.length < 3) continue
      const next = tokens[i + 1]?.trim()
      if (next && /^\d{1,2}:[0-5]\d$/.test(next)) {
        slots.push({ product: safeKeyword(tok), time: next, channel })
      } else if (prevTime) {
        slots.push({ product: safeKeyword(tok), time: prevTime, channel })
      }
    }
  }

  // dedupe (product+time+channel)
  const seen = new Set<string>()
  const out: Slot[] = []
  for (const s of slots) {
    const k = s.product + '|' + s.time + '|' + (s.channel ?? '')
    if (seen.has(k)) continue
    seen.add(k)
    if (s.product.length >= 3 && s.product.length <= 80) out.push(s)
  }
  return out
}

async function recordRun(opts: {
  status: 'ok' | 'partial' | 'error'
  fetched: number
  inserted: number
  durationMs: number
  errorMessage?: string
}) {
  const sb = createAdminClient()
  await sb.from('jimscanner_trends_runs').insert({
    source: SOURCE,
    status: opts.status,
    fetched_count: opts.fetched,
    inserted_count: opts.inserted,
    duration_ms: opts.durationMs,
    error_message: opts.errorMessage ?? null,
    triggered_by: 'vercel_cron',
    finished_at: new Date().toISOString(),
  })
}

export async function GET(request: NextRequest) {
  if (!isAuthorizedCron(request))
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const t0 = Date.now()
  try {
    const res = await fetch(URL_TARGET, {
      headers: {
        'User-Agent': UA,
        'Accept-Language': 'ko-KR,ko;q=0.9',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        Referer: 'https://www.naver.com/',
      },
    })
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`)
    const html = await res.text()
    const slots = extractSlots(html)

    const sb = createAdminClient()
    const collectedAt = new Date().toISOString()

    const tvtimeIdx = html.indexOf('tvtime')
    const rawSlice = tvtimeIdx >= 0 ? html.slice(tvtimeIdx, tvtimeIdx + 50000) : ''

    const { error: rawErr } = await sb.from('jimscanner_trends_raw').insert({
      source: SOURCE,
      request_label: 'naver SERP tvtime widget (vercel cron)',
      payload: {
        size: html.length,
        slot_count: slots.length,
        sample_slots: slots.slice(0, 10),
        widget_excerpt: rawSlice.slice(0, 5000),
      } as unknown as Json,
      collected_at: collectedAt,
    })
    if (rawErr) throw new Error(`raw insert: ${rawErr.message}`)

    const rows = slots.slice(0, 200).map((s) => ({
      keyword: s.product,
      source: SOURCE,
      category: s.time,
      category_top: 'shopping_tv',
      channel: s.channel, // 채널 다중성(MD 검증) 신호 — trends_v5_tv_channel.sql 적용 후 채워짐
      collected_at: collectedAt,
    }))

    let inserted = 0
    if (rows.length > 0) {
      // channel 컬럼은 trends_v5_tv_channel.sql 적용 후 존재 — 생성 타입 미반영분 as any 캐스팅
      const { error: kwErr } = await sb
        .from('jimscanner_trends_keywords')
        .insert(rows as any)
      if (kwErr) throw new Error(`keywords insert: ${kwErr.message}`)
      inserted = rows.length
    }

    await recordRun({
      status: 'ok',
      fetched: slots.length,
      inserted,
      durationMs: Date.now() - t0,
    })

    return NextResponse.json({
      ok: true,
      slots: slots.length,
      inserted,
      duration_ms: Date.now() - t0,
      sample: slots.slice(0, 3),
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    await recordRun({
      status: 'error',
      fetched: 0,
      inserted: 0,
      durationMs: Date.now() - t0,
      errorMessage: msg,
    }).catch(() => {})
    return NextResponse.json({ ok: false, error: msg }, { status: 500 })
  }
}
