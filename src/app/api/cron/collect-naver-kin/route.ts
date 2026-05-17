import { NextResponse, type NextRequest } from 'next/server'
import { KIN_QNA_QUERIES } from '@/lib/market-keywords'
import { insertMarketRaw, isAuthorizedCron, type MarketRawInsert } from '@/lib/market-signals'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

// 네이버 지식인 검색 OpenAPI
// https://developers.naver.com/docs/serviceapi/search/kin/kin.md
type NaverKinItem = {
  title?: string
  link?: string
  description?: string
}

function stripTags(s: string | undefined): string {
  if (!s) return ''
  return s
    .replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim()
}

function extractDocId(link: string): string | null {
  // 지식인 URL 예: https://kin.naver.com/qna/detail.naver?d1id=...&dirId=...&docId=409123456
  const m = link.match(/[?&]docId=(\d+)/)
  return m ? m[1] : null
}

async function searchKin(query: string): Promise<NaverKinItem[]> {
  const id = process.env.NAVER_OPENAPI_CLIENT_ID
  const secret = process.env.NAVER_OPENAPI_CLIENT_SECRET
  if (!id || !secret) throw new Error('NAVER_OPENAPI 키 미설정')

  const url = `https://openapi.naver.com/v1/search/kin.json?query=${encodeURIComponent(query)}&display=30&sort=date`
  const res = await fetch(url, {
    headers: {
      'X-Naver-Client-Id': id,
      'X-Naver-Client-Secret': secret,
    },
  })
  if (!res.ok) throw new Error(`Naver kin ${res.status}`)
  const json = (await res.json()) as { items?: NaverKinItem[] }
  return json.items ?? []
}

export async function GET(request: NextRequest) {
  if (!isAuthorizedCron(request))
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const errors: { query: string; reason: string }[] = []
  const rows: MarketRawInsert[] = []
  const docIdSet = new Set<string>()

  for (const q of KIN_QNA_QUERIES) {
    try {
      const items = await searchKin(q)
      for (const item of items) {
        const url = item.link
        if (!url) continue
        const docId = extractDocId(url)
        const dedup = docId ?? url
        if (docIdSet.has(dedup)) continue
        docIdSet.add(dedup)

        rows.push({
          source: 'naver_kin',
          dedup_key: dedup,
          source_url: url,
          title: stripTags(item.title),
          query: q,
          external_id: docId ?? null,
          metadata: {
            description: stripTags(item.description),
            search_query: q,
            // answer_count / accepted / posted_at 은 OpenAPI 가 노출하지 않음 —
            // Phase 2 LLM 추출 단계에서 상세 페이지 fetch 로 보강.
          },
        })
      }
    } catch (e) {
      errors.push({ query: q, reason: e instanceof Error ? e.message : String(e) })
    }
  }

  const result = await insertMarketRaw(rows)

  // Phase 2 — 신규 raw 를 latent_questions 큐에 pending 상태로 미러링.
  // LLM 추출은 별도 routine 이 mapping_status='pending' 인 행을 pickup 한다.
  let queued = 0
  if (result.inserted > 0) {
    try {
      const admin = createAdminClient()
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
      const { data: fresh } = await admin
        .from('jimscanner_market_raw')
        .select('id, dedup_key, source_url, title, metadata')
        .eq('source', 'naver_kin')
        .gte('captured_at', since)
        .limit(500)

      const freshRows = (fresh ?? []) as Array<{
        id: string
        dedup_key: string
        source_url: string | null
        title: string | null
        metadata: Record<string, unknown> | null
      }>

      if (freshRows.length > 0) {
        const queuePayload = freshRows.map((r) => {
          const desc =
            (r.metadata && typeof r.metadata === 'object' && 'description' in r.metadata
              ? (r.metadata.description as string)
              : '') ?? ''
          return {
            raw_id: r.id,
            question_id: r.dedup_key,
            source: 'naver_kin',
            raw_text: [r.title ?? '', desc].filter(Boolean).join(' — ').slice(0, 2000),
            source_url: r.source_url,
            answer_count: 0,
            accepted: false,
            age_days: 0,
            mapping_status: 'pending',
          }
        })

        // 테이블이 아직 types/supabase.ts 에 없으므로 `as any` 캐스팅.
        const { error: qErr, count } = await (admin as any)
          .from('jimscanner_trends_latent_questions')
          .upsert(queuePayload, { onConflict: 'source,question_id', ignoreDuplicates: true, count: 'exact' })
        if (qErr) {
          errors.push({ query: '__queue__', reason: qErr.message })
        } else {
          queued = count ?? 0
        }
      }
    } catch (e) {
      errors.push({ query: '__queue__', reason: e instanceof Error ? e.message : String(e) })
    }
  }

  return NextResponse.json({
    ok: true,
    queries: KIN_QNA_QUERIES.length,
    fetched: rows.length,
    inserted: result.inserted,
    queued_for_extraction: queued,
    errors,
    executed_at: new Date().toISOString(),
  })
}
