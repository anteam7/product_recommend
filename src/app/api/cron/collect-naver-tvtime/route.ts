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
}

function safeKeyword(s: string, max = 200): string {
  return s.replace(/\s+/g, ' ').trim().slice(0, max)
}

function extractSlots(html: string): Slot[] {
  const tvtimeIdx = html.indexOf('tvtime')
  if (tvtimeIdx < 0) return []
  const widget = html.slice(Math.max(0, tvtimeIdx - 1000), tvtimeIdx + 80000)

  const slots: Slot[] = []
  const liRe = /<li[^>]*>[\s\S]*?<\/li>/g
  for (const m of widget.matchAll(liRe)) {
    const li = m[0]
    if (!/[01]?\d:[0-5]\d/.test(li)) continue
    const text = li.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
    if (text.length > 250 || !/[가-힣]{2,}/.test(text)) continue

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
        slots.push({ product: safeKeyword(tok), time: next })
      } else if (prevTime) {
        slots.push({ product: safeKeyword(tok), time: prevTime })
      }
    }
  }

  // dedupe (product+time)
  const seen = new Set<string>()
  const out: Slot[] = []
  for (const s of slots) {
    const k = s.product + '|' + s.time
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
      collected_at: collectedAt,
    }))

    let inserted = 0
    if (rows.length > 0) {
      const { error: kwErr } = await sb.from('jimscanner_trends_keywords').insert(rows)
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
