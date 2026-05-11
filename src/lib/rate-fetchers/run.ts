import type { SupabaseClient } from '@supabase/supabase-js'
import { getRateFetcher, RATE_FETCHERS } from './index'
import type { FetcherContext, ParsedRate } from './types'
import { upsertParsedRates } from './upsert'

/**
 * fetcher 실행 코어 — CLI / API 라우트 / 어드민 UI 핸들러 모두 이걸 호출.
 *
 * 정책:
 * - dry=true: 페치는 하되 DB 변경 안 함 (run 로그도 안 남김)
 * - noSnapshot=true: jimscanner_rate_fetch_runs.raw_snapshot 저장 안 함 (대용량 절약)
 * - triggeredBy: run 로그 라벨 (cli / cli-batch / cron / admin 등)
 */

export type RunOptions = {
  dry?: boolean
  noSnapshot?: boolean
  triggeredBy?: string
  /** 사이트별 진행 라인 출력 콜백. 미지정 시 console.log */
  log?: (line: string) => void
}

export type RunSummary = {
  slug: string
  parsed: number
  inserted: number
  status: 'ok' | 'partial' | 'error' | 'skipped'
  error?: string
  durationMs: number
}

/** 등록된 모든 fetcher slug */
export const ALL_FETCHER_SLUGS = Object.keys(RATE_FETCHERS)

/** Playwright (chromium) 의존 사이트 — Vercel 서버리스에서 실행 불가 */
export const PLAYWRIGHT_SLUGS = ['geniezip', 'unition', 'jiggujiggu', 'gajida'] as const

export function isPlaywrightSlug(slug: string): boolean {
  return (PLAYWRIGHT_SLUGS as readonly string[]).includes(slug)
}

export async function runForSlug(
  admin: SupabaseClient,
  slug: string,
  opts: RunOptions = {},
): Promise<RunSummary> {
  const startedAtTotal = Date.now()
  const log = opts.log ?? ((s: string) => console.log(s))
  const dry = !!opts.dry
  const noSnapshot = !!opts.noSnapshot
  const triggeredBy = opts.triggeredBy ?? 'cli'

  const fetcher = getRateFetcher(slug)
  if (!fetcher) {
    return {
      slug,
      parsed: 0,
      inserted: 0,
      status: 'skipped',
      error: 'fetcher 미등록',
      durationMs: 0,
    }
  }

  const { data: forwarder, error: fErr } = await admin
    .from('forwarders')
    .select('id, name, slug')
    .eq('slug', slug)
    .maybeSingle<{ id: string; name: string; slug: string }>()
  if (fErr || !forwarder) {
    return {
      slug,
      parsed: 0,
      inserted: 0,
      status: 'error',
      error: `forwarder 미발견: ${fErr?.message ?? ''}`,
      durationMs: Date.now() - startedAtTotal,
    }
  }

  const { data: sources, error: sErr } = await admin
    .from('jimscanner_forwarder_info_sources')
    .select('id, source_type, url, label, notes, is_active')
    .eq('forwarder_id', forwarder.id)
    .eq('source_type', 'rates')
    .eq('is_active', true)
    .order('display_order')
  if (sErr) {
    return {
      slug,
      parsed: 0,
      inserted: 0,
      status: 'error',
      error: `info_sources 조회 실패: ${sErr.message}`,
      durationMs: Date.now() - startedAtTotal,
    }
  }
  if (!sources || sources.length === 0) {
    return {
      slug,
      parsed: 0,
      inserted: 0,
      status: 'skipped',
      error: 'rates 소스 없음',
      durationMs: Date.now() - startedAtTotal,
    }
  }

  log(`▶ ${forwarder.name} (${slug}) — ${sources.length} 소스 처리`)
  let totalInserted = 0
  let totalParsed = 0
  let aggStatus: 'ok' | 'partial' | 'error' = 'ok'
  let lastError: string | undefined

  for (const src of sources) {
    const startedAt = Date.now()
    const ctx: FetcherContext = {
      forwarder_id: forwarder.id,
      forwarder_slug: forwarder.slug,
      source_id: src.id,
      source_url: src.url,
      source_label: src.label ?? null,
      source_notes: src.notes ?? null,
    }

    let rates: ParsedRate[] = []
    let raw_snapshot = ''
    let status: 'ok' | 'partial' | 'error' = 'ok'
    let error_message: string | null = null
    let inserted = 0

    try {
      const result = await fetcher(ctx)
      rates = result.rates
      raw_snapshot = result.raw_snapshot
      if (rates.length === 0) {
        status = 'partial'
        error_message = '파싱 결과 0행'
      }
    } catch (e) {
      status = 'error'
      error_message = e instanceof Error ? e.message : String(e)
    }

    const countries = [...new Set(rates.map((r) => r.country))]
    log(`  [${src.label ?? '-'}] ${src.url}`)
    log(`    파싱: ${rates.length} 행, 국가: ${countries.join(',') || '-'}, 상태: ${status}${error_message ? ` (${error_message})` : ''}`)

    if (!dry && rates.length > 0) {
      try {
        const r = await upsertParsedRates(admin, forwarder.id, rates)
        inserted = r.inserted
        log(`    DB 반영: ${inserted} 행 insert`)
      } catch (e) {
        status = 'error'
        error_message = e instanceof Error ? e.message : String(e)
        log(`    DB 반영 실패: ${error_message}`)
      }
    }

    if (!dry) {
      const finishedAt = Date.now()
      const { error: runErr } = await admin.from('jimscanner_rate_fetch_runs').insert({
        forwarder_id: forwarder.id,
        source_id: src.id,
        source_url: src.url,
        status,
        parsed_count: rates.length,
        inserted_count: inserted,
        countries,
        raw_snapshot: noSnapshot ? null : raw_snapshot.slice(0, 5_000_000),
        error_message,
        duration_ms: finishedAt - startedAt,
        triggered_by: triggeredBy,
        started_at: new Date(startedAt).toISOString(),
        finished_at: new Date(finishedAt).toISOString(),
      })
      if (runErr) log(`    run 로그 insert 실패: ${runErr.message}`)

      const { error: upErr } = await admin
        .from('jimscanner_forwarder_info_sources')
        .update({ last_fetched_at: new Date().toISOString(), last_fetch_status: status })
        .eq('id', src.id)
      if (upErr) log(`    info_source 업데이트 실패: ${upErr.message}`)
    }

    totalInserted += inserted
    totalParsed += rates.length
    if (status === 'error') {
      aggStatus = 'error'
      lastError = error_message ?? undefined
    } else if (status === 'partial' && aggStatus === 'ok') {
      aggStatus = 'partial'
      lastError = error_message ?? undefined
    }
  }

  log(`✓ ${slug} — 총 파싱 ${totalParsed} 행, DB insert ${totalInserted} 행${dry ? ' (dry-run)' : ''}`)
  return {
    slug,
    parsed: totalParsed,
    inserted: totalInserted,
    status: aggStatus,
    error: lastError,
    durationMs: Date.now() - startedAtTotal,
  }
}

export async function runBatch(
  admin: SupabaseClient,
  slugs: string[],
  opts: RunOptions = {},
): Promise<RunSummary[]> {
  const results: RunSummary[] = []
  for (const s of slugs) {
    try {
      results.push(await runForSlug(admin, s, opts))
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      results.push({
        slug: s,
        parsed: 0,
        inserted: 0,
        status: 'error',
        error: msg,
        durationMs: 0,
      })
    }
  }
  return results
}
