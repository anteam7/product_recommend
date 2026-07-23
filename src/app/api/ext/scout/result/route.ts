import { NextResponse, type NextRequest } from 'next/server'
import { isAuthorizedScout } from '@/lib/scout-auth'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function admin(): any { return createAdminClient() }

const isUuid = (v: unknown): v is string =>
  typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)
const toInt = (v: unknown): number | null => (Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : null)
const toStr = (v: unknown, max = 2000): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null)
const toArr = (v: unknown, max = 50): string[] | null =>
  Array.isArray(v) ? v.filter((x) => typeof x === 'string').slice(0, max) : null

/**
 * 확장 결과 수신 — 청크 단위 멱등 upsert.
 * body: { commandId, ok, chunk?: {seq, final}, data?: {kind: 'products'|'product_detail'|'reviews'|'state', items: [...]},
 *         summary?, error?: {code, message, checkpoint?, paused?} }
 * final(또는 chunk 생략) 시 명령 done. ok=false 는 error.paused 여부에 따라 paused|failed.
 */
export async function POST(req: NextRequest) {
  if (!isAuthorizedScout(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const body = await req.json().catch(() => null)
  if (!body || !isUuid(body.commandId)) return NextResponse.json({ error: 'commandId 형식 오류' }, { status: 400 })
  const sb = admin()
  const now = new Date().toISOString()

  // 명령 존재·세션 확인 (임의 id 적재 방지)
  const { data: cmd, error: cErr } = await sb.from('jimscanner_scout_commands')
    .select('id, session_id, command_type, status').eq('id', body.commandId).single()
  if (cErr || !cmd) return NextResponse.json({ error: '명령 없음' }, { status: 404 })

  // 실패 보고
  if (body.ok === false) {
    const e = body.error ?? {}
    const paused = e.paused === true // BLOCKED 등 재개 가능 상태
    const { error } = await sb.from('jimscanner_scout_commands').update({
      status: paused ? 'paused' : 'failed',
      error: `${toStr(e.code, 40) ?? 'ERROR'}: ${toStr(e.message, 500) ?? ''}`,
      progress: e.checkpoint ? { phase: paused ? 'paused' : 'failed', checkpoint: e.checkpoint } : undefined,
      ended_at: paused ? null : now, updated_at: now,
    }).eq('id', cmd.id)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ ok: true })
  }

  // 데이터 적재
  const kind = body.data?.kind
  const items: unknown[] = Array.isArray(body.data?.items) ? body.data.items.slice(0, 1000) : []

  if ((kind === 'products' || kind === 'product_detail') && items.length) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows = items.map((raw: any) => {
      const pid = toStr(raw?.product_id, 32)
      if (!pid) return null
      return {
        session_id: cmd.session_id, command_id: cmd.id, product_id: pid,
        url: toStr(raw.url, 500), name: toStr(raw.name, 500),
        price: toInt(raw.price), original_price: toInt(raw.original_price), discount_rate: toInt(raw.discount_rate),
        rating: Number.isFinite(Number(raw.rating)) ? Number(raw.rating) : null,
        review_count: toInt(raw.review_count), brand: toStr(raw.brand, 100), seller: toStr(raw.seller, 100),
        competing_sellers: toInt(raw.competing_sellers),
        delivery_badge: toStr(raw.delivery_badge, 30), image_url: toStr(raw.image_url, 800),
        keyword: toStr(raw.keyword, 200), page_no: toInt(raw.page_no), rank_in_page: toInt(raw.rank_in_page),
        options: raw.options ?? null, manufacturer: toStr(raw.manufacturer, 200), origin: toStr(raw.origin, 200),
        detail_images: toArr(raw.detail_images), delivery_info: raw.delivery_info ?? null,
        seller_info: raw.seller_info ?? null, qna: raw.qna ?? null, category_path: toArr(raw.category_path, 10),
        raw: raw.raw ?? null,
        ...(kind === 'product_detail' ? { detail_collected_at: now } : {}),
      }
    }).filter(Boolean)
    if (rows.length) {
      const { error } = await sb.from('jimscanner_scout_products').upsert(rows, { onConflict: 'command_id,product_id' })
      if (error) return NextResponse.json({ error: `products: ${error.message}` }, { status: 500 })
    }
  } else if (kind === 'reviews' && items.length) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows = items.map((raw: any) => {
      const pid = toStr(raw?.product_id, 32)
      const hash = toStr(raw?.content_hash, 64)
      if (!pid || !hash) return null
      return {
        product_id: pid, command_id: cmd.id, content_hash: hash,
        review_date: toStr(raw.review_date, 10), rating: toInt(raw.rating),
        content: toStr(raw.content, 4000), images: toArr(raw.images),
        option_text: toStr(raw.option_text, 300), helpful_count: toInt(raw.helpful_count),
      }
    }).filter(Boolean)
    if (rows.length) {
      const { error } = await sb.from('jimscanner_scout_reviews').upsert(rows, { onConflict: 'product_id,content_hash' })
      if (error) return NextResponse.json({ error: `reviews: ${error.message}` }, { status: 500 })
    }
  }

  // final(또는 chunk 생략) → done + 요약
  const isFinal = !body.chunk || body.chunk.final === true
  if (isFinal) {
    const summary = body.summary && JSON.stringify(body.summary).length <= 8000 ? body.summary : { items: items.length }
    const { error } = await sb.from('jimscanner_scout_commands').update({
      status: 'done', result_summary: summary, ended_at: now, updated_at: now,
    }).eq('id', cmd.id)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  } else {
    const { error } = await sb.from('jimscanner_scout_commands').update({ updated_at: now }).eq('id', cmd.id)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  }
  return NextResponse.json({ ok: true, saved: items.length })
}
