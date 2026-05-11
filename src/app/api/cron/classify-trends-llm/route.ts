/**
 * 트렌드 레이더 v4 — Gemma 4 LLM 분류 cron (PR-4.5, 2026-05-09)
 *
 * 목표: jimscanner_trends_products 의 LLM 미분류·변경된 row 만 batch 호출.
 *      canonical_name 정제 + brand 추출 + category_top 검증 + category_mid + intent_label + description.
 *
 * 비용 가드:
 *  - Gemma 4 26B A4B (`gemma-4-26b-a4b-it`) 무료 티어
 *  - batch 20개/호출, 일 최대 60 req (= product 1200개) 까지만 처리하고 종료
 *  - jimscanner_trends_llm_calls 일별 카운터 upsert
 *
 * 스케줄: vercel.json — 매일 KST 06:30 (UTC 21:30) — recompute (KST 06:00) 직후
 */
import { NextResponse, type NextRequest } from 'next/server'
import { isAuthorizedCron } from '@/lib/market-signals'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import { classifyBatch, type ClassifyInput, type ClassifyResult } from '@/lib/gemma-classify'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

const MODEL = 'gemini-2.5-flash-lite'
const BATCH_SIZE = 20
const MAX_REQ_PER_RUN = 60          // 안전 한도 (실제 무료 티어보다 훨씬 보수적)
const PRODUCT_FETCH_LIMIT = MAX_REQ_PER_RUN * BATCH_SIZE
const DAILY_REQ_HARD_CAP = 800       // 어떤 경우에도 일일 누적이 이 값 넘으면 중단

interface ProductCandidate {
  id: string
  canonical_name: string
  category_top: string
  alias_count: number
  llm_classified_at: string | null
  updated_at: string
}

interface AliasRow {
  product_id: string
  alias: string
  source: string | null
}

async function fetchTodayCounter(sb: ReturnType<typeof createAdminClient>) {
  const today = new Date().toISOString().slice(0, 10)
  const { data } = await sb
    .from('jimscanner_trends_llm_calls')
    .select('day, request_count, product_count, input_token_count, output_token_count')
    .eq('day', today)
    .maybeSingle()
  return {
    day: today,
    requestCount: data?.request_count ?? 0,
    productCount: data?.product_count ?? 0,
    inputTokens: data?.input_token_count ?? 0,
    outputTokens: data?.output_token_count ?? 0,
  }
}

async function bumpCounter(
  sb: ReturnType<typeof createAdminClient>,
  day: string,
  delta: { req: number; products: number; inputTokens: number; outputTokens: number },
) {
  // upsert + add 패턴: 기존 값을 select 해서 새 값을 upsert
  const { data: existing } = await sb
    .from('jimscanner_trends_llm_calls')
    .select('request_count, product_count, input_token_count, output_token_count')
    .eq('day', day)
    .maybeSingle()

  await sb.from('jimscanner_trends_llm_calls').upsert(
    {
      day,
      model: MODEL,
      request_count: (existing?.request_count ?? 0) + delta.req,
      product_count: (existing?.product_count ?? 0) + delta.products,
      input_token_count: (existing?.input_token_count ?? 0) + delta.inputTokens,
      output_token_count: (existing?.output_token_count ?? 0) + delta.outputTokens,
      last_call_at: new Date().toISOString(),
    },
    { onConflict: 'day' },
  )
}

async function fetchCandidates(sb: ReturnType<typeof createAdminClient>): Promise<ProductCandidate[]> {
  // 미분류 우선
  const { data: unclassified } = await sb
    .from('jimscanner_trends_products')
    .select('id, canonical_name, category_top, alias_count, llm_classified_at, updated_at')
    .is('llm_classified_at', null)
    .order('updated_at', { ascending: false })
    .limit(PRODUCT_FETCH_LIMIT)

  return (unclassified ?? []) as ProductCandidate[]
}

async function fetchSampleAliases(
  sb: ReturnType<typeof createAdminClient>,
  productIds: string[],
): Promise<Map<string, AliasRow[]>> {
  if (productIds.length === 0) return new Map()
  const { data } = await sb
    .from('jimscanner_trends_aliases')
    .select('product_id, alias, source')
    .in('product_id', productIds)
    .order('confidence', { ascending: false })
    .limit(productIds.length * 5)
  const map = new Map<string, AliasRow[]>()
  for (const r of (data ?? []) as AliasRow[]) {
    const list = map.get(r.product_id) ?? []
    if (list.length < 3) list.push(r)
    map.set(r.product_id, list)
  }
  return map
}

async function applyResults(
  sb: ReturnType<typeof createAdminClient>,
  results: ClassifyResult[],
) {
  if (results.length === 0) return
  const now = new Date().toISOString()

  // 개별 update — Supabase JS 의 update 는 PK 단위 호출. 병렬화.
  await Promise.all(
    results.map((r) =>
      sb
        .from('jimscanner_trends_products')
        .update({
          canonical_name: r.canonical_name,
          brand: r.brand,
          category_top: r.category_top,
          category_mid: r.category_mid,
          intent_label: r.intent_label,
          description: r.description,
          llm_classified_at: now,
          llm_model: MODEL,
        })
        .eq('id', r.id),
    ),
  )
}

export async function GET(request: NextRequest) {
  if (!isAuthorizedCron(request))
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const t0 = Date.now()
  const sb = createAdminClient()

  try {
    const counter = await fetchTodayCounter(sb)
    if (counter.requestCount >= DAILY_REQ_HARD_CAP) {
      return NextResponse.json({
        ok: true,
        skipped: 'daily_cap_reached',
        request_count_today: counter.requestCount,
      })
    }

    const candidates = await fetchCandidates(sb)
    if (candidates.length === 0) {
      return NextResponse.json({ ok: true, processed: 0, message: '분류 대상 없음' })
    }

    const aliasMap = await fetchSampleAliases(
      sb,
      candidates.map((c) => c.id),
    )

    const allResults: ClassifyResult[] = []
    let reqCount = 0
    let totalIn = 0
    let totalOut = 0
    let lastError: string | null = null

    for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
      if (reqCount >= MAX_REQ_PER_RUN) break
      if (counter.requestCount + reqCount >= DAILY_REQ_HARD_CAP) break

      const batch = candidates.slice(i, i + BATCH_SIZE)
      const inputs: ClassifyInput[] = batch.map((c) => {
        const sample = aliasMap.get(c.id) ?? []
        return {
          id: c.id,
          name: c.canonical_name,
          category_top: c.category_top,
          alias_count: c.alias_count,
          sample_aliases: sample.map((a) => a.alias),
          sample_sources: [
            ...new Set(sample.map((a) => a.source ?? '').filter(Boolean)),
          ],
        }
      })

      try {
        const out = await classifyBatch(inputs, { model: MODEL })
        reqCount++
        totalIn += out.promptTokens
        totalOut += out.outputTokens
        allResults.push(...out.results)
      } catch (e) {
        lastError = e instanceof Error ? e.message : String(e)
        // 호출 실패 시도 카운터엔 반영하지 않고, 한 번만 break
        break
      }
    }

    if (allResults.length > 0) await applyResults(sb, allResults)

    if (reqCount > 0) {
      await bumpCounter(sb, counter.day, {
        req: reqCount,
        products: allResults.length,
        inputTokens: totalIn,
        outputTokens: totalOut,
      })
    }

    await sb.from('jimscanner_trends_runs').insert({
      source: 'classify_trends_llm',
      status: lastError ? 'partial' : 'ok',
      fetched_count: candidates.length,
      inserted_count: allResults.length,
      duration_ms: Date.now() - t0,
      error_message: lastError,
      triggered_by: 'vercel_cron',
      finished_at: new Date().toISOString(),
    })

    return NextResponse.json({
      ok: true,
      candidates: candidates.length,
      requests: reqCount,
      classified: allResults.length,
      input_tokens: totalIn,
      output_tokens: totalOut,
      day_total_after: counter.requestCount + reqCount,
      duration_ms: Date.now() - t0,
      ...(lastError ? { last_error: lastError } : {}),
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    try {
      await sb.from('jimscanner_trends_runs').insert({
        source: 'classify_trends_llm',
        status: 'error',
        fetched_count: 0,
        inserted_count: 0,
        duration_ms: Date.now() - t0,
        error_message: msg,
        triggered_by: 'vercel_cron',
        finished_at: new Date().toISOString(),
      })
    } catch {}
    return NextResponse.json({ ok: false, error: msg }, { status: 500 })
  }
}
