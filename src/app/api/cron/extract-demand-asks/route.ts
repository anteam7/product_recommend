import { NextResponse, type NextRequest } from 'next/server'
import { isAuthorizedCron } from '@/lib/market-signals'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import { extractAskRecommendations } from '@/lib/demand-asks'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0 Safari/537.36'

// 한 번 실행에 처리할 ask 글 수 (Gemini 비용·maxDuration 고려)
const BATCH = 12

// clien 본문/댓글 추출 (best-effort; 실패 시 제목만으로 LLM 호출)
async function fetchClienBodyComments(url: string): Promise<{ body: string; comments: string[] }> {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept-Language': 'ko-KR,ko;q=0.9' },
      cache: 'no-store',
    })
    if (!res.ok) return { body: '', comments: [] }
    const html = await res.text()

    // 본문: <div class="post_article ...> ... </div> 안의 텍스트
    const bodyMatch = html.match(/<div[^>]*class="[^"]*post_article[^"]*"[\s\S]*?<\/div>\s*<\/div>/)
    const body = stripHtml(bodyMatch?.[0] ?? '').slice(0, 2000)

    // 댓글: clien 은 <div class="comment_view ...> 류. 광범위하게 텍스트만 긁음.
    const comments: string[] = []
    const cmtRe = /<div[^>]*class="[^"]*comment_view[^"]*"[^>]*>([\s\S]*?)<\/div>/g
    let cm: RegExpExecArray | null
    while ((cm = cmtRe.exec(html)) !== null && comments.length < 120) {
      const t = stripHtml(cm[1]).trim()
      if (t && t.length >= 2) comments.push(t.slice(0, 300))
    }
    return { body, comments }
  } catch {
    return { body: '', comments: [] }
  }
}

function stripHtml(s: string): string {
  return s
    .replace(/<script[\s\S]*?<\/script>/g, '')
    .replace(/<style[\s\S]*?<\/style>/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
}

export async function GET(request: NextRequest) {
  if (!isAuthorizedCron(request))
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  if (!process.env.GEMINI_API_KEY)
    return NextResponse.json({ error: 'GEMINI_API_KEY 미설정' }, { status: 500 })

  const admin = createAdminClient()

  // 미처리 ask 후보 raw 행 (metadata.is_demand_ask = true)
  const { data: raws, error } = await admin
    .from('jimscanner_market_raw')
    .select('id, source, title, source_url, metadata')
    .eq('processed', false)
    .eq('metadata->>is_demand_ask', 'true')
    .order('captured_at', { ascending: false })
    .limit(BATCH)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const rows = (raws ?? []) as {
    id: string
    source: string
    title: string | null
    source_url: string | null
    metadata: Record<string, unknown> | null
  }[]

  let asksUpserted = 0
  let recosUpserted = 0
  let skipped = 0
  const processedIds: string[] = []

  for (const r of rows) {
    processedIds.push(r.id)
    const title = (r.title ?? '').trim()
    if (!title) {
      skipped++
      continue
    }

    // 본문/댓글 fetch (clien 만 지원; 그 외는 제목만)
    let body = ''
    let comments: string[] = []
    if (r.source_url && r.source.startsWith('clien')) {
      const fetched = await fetchClienBodyComments(r.source_url)
      body = fetched.body
      comments = fetched.comments
    }

    const extracted = await extractAskRecommendations({ title, body, comments })
    if (!extracted || !extracted.is_ask) {
      skipped++
      continue
    }

    // upsert ask (ask_text unique). 기존이면 count/source_mix 누적.
    const sourceMix: Record<string, number> = { [r.source]: 1 }
    const { data: askRow, error: askErr } = await admin
      .from('jimscanner_trends_demand_asks' as never)
      .upsert(
        {
          ask_text: extracted.ask_text,
          category: extracted.category,
          ask_count: 1,
          source_mix: sourceMix,
          raw_ids: [r.id],
          example_title: title,
          example_url: r.source_url,
          last_seen: new Date().toISOString(),
        } as never,
        { onConflict: 'ask_text', ignoreDuplicates: false } as never,
      )
      .select('id')
      .single()

    if (askErr || !askRow) {
      // 이미 존재해 ignoreDuplicates 충돌 시 재조회
      const { data: existing } = await admin
        .from('jimscanner_trends_demand_asks' as never)
        .select('id')
        .eq('ask_text', extracted.ask_text)
        .single()
      if (!existing) {
        skipped++
        continue
      }
      await bumpAsk(admin, (existing as { id: string }).id, r.id, r.source)
      asksUpserted++
      recosUpserted += await upsertRecos(
        admin,
        (existing as { id: string }).id,
        extracted,
        r.id,
      )
      continue
    }

    asksUpserted++
    recosUpserted += await upsertRecos(admin, (askRow as { id: string }).id, extracted, r.id)
  }

  // 처리 완료 표시
  if (processedIds.length > 0) {
    await admin
      .from('jimscanner_market_raw')
      .update({ processed: true })
      .in('id', processedIds)
  }

  return NextResponse.json({
    ok: true,
    scanned: rows.length,
    asks_upserted: asksUpserted,
    recos_upserted: recosUpserted,
    skipped,
    executed_at: new Date().toISOString(),
  })
}

// 기존 ask 의 count/source_mix/raw_ids 누적
async function bumpAsk(
  admin: ReturnType<typeof createAdminClient>,
  askId: string,
  rawId: string,
  source: string,
): Promise<void> {
  const { data: cur } = await admin
    .from('jimscanner_trends_demand_asks' as never)
    .select('ask_count, source_mix, raw_ids')
    .eq('id', askId)
    .single()
  const c = (cur ?? {}) as { ask_count?: number; source_mix?: Record<string, number>; raw_ids?: string[] }
  const mix = { ...(c.source_mix ?? {}) }
  mix[source] = (mix[source] ?? 0) + 1
  const rawIds = Array.from(new Set([...(c.raw_ids ?? []), rawId]))
  await admin
    .from('jimscanner_trends_demand_asks' as never)
    .update({
      ask_count: (c.ask_count ?? 1) + 1,
      source_mix: mix,
      raw_ids: rawIds,
      last_seen: new Date().toISOString(),
    } as never)
    .eq('id', askId)
}

// 추천 상품들 upsert (ask_id+recommended_name unique). 기존이면 mention_count 누적.
async function upsertRecos(
  admin: ReturnType<typeof createAdminClient>,
  askId: string,
  extracted: { ask_text: string; recommendations: { recommended_name: string; mention_count: number; sentiment: string }[] },
  rawId: string,
): Promise<number> {
  let n = 0
  for (const reco of extracted.recommendations) {
    const { data: existing } = await admin
      .from('jimscanner_ask_recommendations' as never)
      .select('id, mention_count, raw_ids')
      .eq('ask_id', askId)
      .eq('recommended_name', reco.recommended_name)
      .single()

    if (existing) {
      const e = existing as { id: string; mention_count?: number; raw_ids?: string[] }
      const rawIds = Array.from(new Set([...(e.raw_ids ?? []), rawId]))
      await admin
        .from('jimscanner_ask_recommendations' as never)
        .update({
          mention_count: (e.mention_count ?? 1) + reco.mention_count,
          sentiment: reco.sentiment,
          raw_ids: rawIds,
          last_seen: new Date().toISOString(),
        } as never)
        .eq('id', e.id)
    } else {
      await admin.from('jimscanner_ask_recommendations' as never).insert({
        ask_id: askId,
        asked_product: extracted.ask_text,
        recommended_name: reco.recommended_name,
        mention_count: reco.mention_count,
        sentiment: reco.sentiment,
        raw_ids: [rawId],
      } as never)
    }
    n++
  }
  return n
}
