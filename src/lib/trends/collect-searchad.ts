import type { SupabaseClient } from '@supabase/supabase-js'
import {
  fetchKeywordTool,
  estimateCpc,
  parseQcCnt,
  type KeywordToolRow,
} from './naver-searchad'
import { chunk } from './naver-datalab'

/**
 * 네이버 검색광고 키워드도구 수집 코어 — collect-naver-searchad cron 이 호출.
 *
 * 시드: 기존 naver_search_trend 키워드 그룹의 keywords + jimscanner_trends_aliases.alias
 *   (DataLab 시드와 동일 키워드를 절대 검색량/CPC 로 앵커링)
 * 적재: jimscanner_trends_keyword_demand — hint 키워드 row 만 (relKeyword 가 hint 와 일치).
 *   연관 키워드(rel) 전체를 받지만, 노이즈 방지 위해 hint 매칭 row 만 저장.
 */

type CollectSummary = {
  source: string
  fetched: number
  inserted: number
  durationMs: number
  status: 'ok' | 'partial' | 'error'
  error?: string
}

async function logRun(
  admin: SupabaseClient,
  source: string,
  triggeredBy: string,
  startedAt: number,
  summary: Omit<CollectSummary, 'durationMs' | 'source'>,
) {
  const finishedAt = Date.now()
  await admin.from('jimscanner_trends_runs').insert({
    source,
    status: summary.status,
    fetched_count: summary.fetched,
    inserted_count: summary.inserted,
    duration_ms: finishedAt - startedAt,
    error_message: summary.error ?? null,
    triggered_by: triggeredBy,
    started_at: new Date(startedAt).toISOString(),
    finished_at: new Date(finishedAt).toISOString(),
  })
}

const norm = (s: string) => s.replace(/\s+/g, '').toUpperCase()

/** 수집할 hint 키워드 후보 수집 — 검색어 트렌드 시드 keywords + aliases */
async function gatherHintKeywords(admin: SupabaseClient): Promise<string[]> {
  const set = new Set<string>()

  const { data: seeds } = await admin
    .from('jimscanner_trends_seeds')
    .select('config')
    .eq('source', 'naver_search_trend')
    .eq('is_active', true)
  for (const s of (seeds ?? []) as Array<{ config: { keywords?: string[] } }>) {
    for (const k of s.config?.keywords ?? []) {
      const t = k.trim()
      if (t) set.add(t)
    }
  }

  // alias 키워드 (keyword 타입) — 발굴 상품의 검색 키워드
  const { data: aliases } = await admin
    .from('jimscanner_trends_aliases')
    .select('alias')
    .eq('alias_type', 'keyword')
    .limit(500)
  for (const a of (aliases ?? []) as Array<{ alias: string }>) {
    const t = (a.alias ?? '').trim()
    if (t) set.add(t)
  }

  return [...set]
}

export async function collectNaverKeywordDemand(
  admin: SupabaseClient,
  triggeredBy: string,
): Promise<CollectSummary> {
  const startedAt = Date.now()
  const source = 'naver_searchad'

  let hints: string[]
  try {
    hints = await gatherHintKeywords(admin)
  } catch (e) {
    const summary = {
      fetched: 0,
      inserted: 0,
      status: 'error' as const,
      error: e instanceof Error ? e.message : String(e),
    }
    await logRun(admin, source, triggeredBy, startedAt, summary)
    return { ...summary, source, durationMs: Date.now() - startedAt }
  }

  if (hints.length === 0) {
    const summary = { fetched: 0, inserted: 0, status: 'partial' as const, error: 'no hint keywords' }
    await logRun(admin, source, triggeredBy, startedAt, summary)
    return { ...summary, source, durationMs: Date.now() - startedAt }
  }

  let fetched = 0
  let inserted = 0
  let lastErr: string | undefined

  // 키워드도구는 한 호출당 hintKeywords 최대 5
  for (const batch of chunk(hints, 5)) {
    const wanted = new Set(batch.map(norm))
    try {
      const resp = await fetchKeywordTool(batch)
      fetched++

      // hint 와 일치하는 row 만 저장 (연관키워드 노이즈 제외)
      const matched: KeywordToolRow[] = (resp.keywordList ?? []).filter((r) =>
        wanted.has(norm(r.relKeyword ?? '')),
      )

      const rows: Array<Record<string, unknown>> = []
      for (const r of matched) {
        const pc = parseQcCnt(r.monthlyPcQcCnt)
        const mobile = parseQcCnt(r.monthlyMobileQcCnt)
        // CPC 추정 — best-effort, 실패 시 null
        let cpc: number | null = null
        try {
          cpc = await estimateCpc(r.relKeyword)
        } catch {
          cpc = null
        }
        rows.push({
          keyword: norm(r.relKeyword),
          hint_keyword: r.relKeyword,
          monthly_pc: pc,
          monthly_mobile: mobile,
          monthly_total: pc + mobile,
          comp_idx: r.compIdx ?? null,
          ad_depth: typeof r.plAvgDepth === 'number' ? r.plAvgDepth : null,
          est_cpc: cpc,
          raw_payload: r as unknown as Record<string, unknown>,
        })
      }

      if (rows.length > 0) {
        // 신규 마이그레이션 테이블 — generated types 에 아직 없어 as any 캐스팅
        const { error: insErr } = await (admin as any)
          .from('jimscanner_trends_keyword_demand')
          .insert(rows)
        if (insErr) lastErr = insErr.message
        else inserted += rows.length
      }
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e)
    }
  }

  const status: CollectSummary['status'] = lastErr ? (inserted > 0 ? 'partial' : 'error') : 'ok'
  const summary = { fetched, inserted, status, error: lastErr }
  await logRun(admin, source, triggeredBy, startedAt, summary)
  return { ...summary, source, durationMs: Date.now() - startedAt }
}
