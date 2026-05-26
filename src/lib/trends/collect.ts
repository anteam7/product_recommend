import type { SupabaseClient } from '@supabase/supabase-js'
import {
  fetchSearchTrend,
  fetchShoppingCategories,
  dateNDaysAgoKst,
  chunk,
  type DatalabKeywordGroup,
  type DatalabCategoryGroup,
} from './naver-datalab'

/**
 * 트렌드 수집 코어 — cron 라우트가 호출.
 * seed 테이블에서 active 시드 읽어 청크 단위로 Naver DataLab 호출.
 *
 * trends_raw: 호출 1회당 1 row (응답 그대로)
 * trends_keywords: 응답 결과의 그룹별 1 row (가장 최근 시점 ratio 만)
 *   — 시계열은 매일 누적되며 자연스럽게 형성. 30일 추이는 raw payload 에서 sparkline 추출
 */

type Seed = {
  id: string
  source: string
  kind: string
  label: string
  config: { cid?: string; name?: string; groupName?: string; keywords?: string[] }
}

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
  triggeredSeedId?: string,
) {
  const finishedAt = Date.now()
  const row: Record<string, unknown> = {
    source,
    status: summary.status,
    fetched_count: summary.fetched,
    inserted_count: summary.inserted,
    duration_ms: finishedAt - startedAt,
    error_message: summary.error ?? null,
    triggered_by: triggeredBy,
    started_at: new Date(startedAt).toISOString(),
    finished_at: new Date(finishedAt).toISOString(),
  }
  if (triggeredSeedId) row.triggered_seed_id = triggeredSeedId
  // triggered_seed_id 는 trends_v4_seed_yield 마이그레이션 적용 후 사용 가능
  await admin.from('jimscanner_trends_runs').insert(row as never)
}

// seed-level yield 어트리뷰션 — 시드별 1 row 를 trends_runs 에 추가 기록.
// 기존 aggregate row 와 별개로 seed_id 컬럼 채워 등록.
async function logSeedRuns(
  admin: SupabaseClient,
  source: string,
  triggeredBy: string,
  perSeed: Map<string, { fetched: number; inserted: number; status: 'ok' | 'partial' | 'error'; error?: string; startedAt: number; finishedAt: number }>,
) {
  const rows = Array.from(perSeed.entries()).map(([seedId, s]) => ({
    source,
    status: s.status,
    fetched_count: s.fetched,
    inserted_count: s.inserted,
    duration_ms: s.finishedAt - s.startedAt,
    error_message: s.error ?? null,
    triggered_by: triggeredBy,
    triggered_seed_id: seedId,
    started_at: new Date(s.startedAt).toISOString(),
    finished_at: new Date(s.finishedAt).toISOString(),
  }))
  if (rows.length === 0) return
  await admin.from('jimscanner_trends_runs').insert(rows as never)
}

export async function collectNaverSearchTrends(
  admin: SupabaseClient,
  triggeredBy: string,
): Promise<CollectSummary> {
  const startedAt = Date.now()
  const source = 'naver_search_trend'

  const { data: seeds, error: sErr } = await admin
    .from('jimscanner_trends_seeds')
    .select('id, source, kind, label, config')
    .eq('source', source)
    .eq('is_active', true)
    .order('display_order')
  if (sErr) {
    const summary = { fetched: 0, inserted: 0, status: 'error' as const, error: sErr.message }
    await logRun(admin, source, triggeredBy, startedAt, summary)
    return { ...summary, source, durationMs: Date.now() - startedAt }
  }
  const seedList = (seeds ?? []) as Seed[]
  if (seedList.length === 0) {
    const summary = { fetched: 0, inserted: 0, status: 'partial' as const, error: 'no active seeds' }
    await logRun(admin, source, triggeredBy, startedAt, summary)
    return { ...summary, source, durationMs: Date.now() - startedAt }
  }

  const startDate = dateNDaysAgoKst(30)
  const endDate = dateNDaysAgoKst(1) // 어제까지 (DataLab 은 당일 미반영 가능성)

  let fetched = 0
  let inserted = 0
  let lastErr: string | undefined

  // seed-level 어트리뷰션 — 각 시드별 fetched/inserted 추적
  const perSeed = new Map<string, { fetched: number; inserted: number; status: 'ok' | 'partial' | 'error'; error?: string; startedAt: number; finishedAt: number }>()
  for (const s of seedList) {
    perSeed.set(s.id, { fetched: 0, inserted: 0, status: 'ok', startedAt: Date.now(), finishedAt: Date.now() })
  }

  // 검색어 트렌드는 한 호출당 최대 5 그룹
  for (const batch of chunk(seedList, 5)) {
    const chunkSeeds = batch.filter((s) => (s.config.keywords ?? []).length > 0)
    const keywordGroups: DatalabKeywordGroup[] = chunkSeeds.map((s) => ({
      groupName: s.config.groupName ?? s.label,
      keywords: s.config.keywords ?? [],
    }))
    if (keywordGroups.length === 0) continue
    const chunkStarted = Date.now()

    try {
      const resp = await fetchSearchTrend({
        startDate,
        endDate,
        timeUnit: 'date',
        keywordGroups,
      })
      fetched++
      for (const s of chunkSeeds) {
        const cur = perSeed.get(s.id)!
        cur.fetched += 1
      }

      // raw 저장
      await admin.from('jimscanner_trends_raw').insert({
        source,
        request_label: keywordGroups.map((g) => g.groupName).join(', '),
        payload: resp as unknown as Record<string, unknown>,
      })

      // keywords 정규화 — 각 그룹의 마지막 시점 ratio
      const rows: Array<Record<string, unknown>> = []
      const titleToSeed = new Map<string, string>()
      for (let i = 0; i < (resp.results ?? []).length; i++) {
        const group = resp.results![i]
        const last = group.data?.[group.data.length - 1]
        rows.push({
          keyword: group.title,
          source,
          category: null,
          category_top: null,
          rank: null,
          volume_relative: last?.ratio ?? null,
        })
        const seedForGroup = chunkSeeds[i] ?? chunkSeeds.find((s) => (s.config.groupName ?? s.label) === group.title)
        if (seedForGroup) titleToSeed.set(group.title, seedForGroup.id)
      }
      if (rows.length > 0) {
        const { error: insErr } = await admin.from('jimscanner_trends_keywords').insert(rows)
        if (insErr) {
          lastErr = insErr.message
          for (const s of chunkSeeds) {
            const cur = perSeed.get(s.id)!
            cur.status = cur.inserted > 0 ? 'partial' : 'error'
            cur.error = insErr.message
          }
        } else {
          inserted += rows.length
          for (const r of rows) {
            const sid = titleToSeed.get(r.keyword as string)
            if (sid) perSeed.get(sid)!.inserted += 1
          }
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      lastErr = msg
      for (const s of chunkSeeds) {
        const cur = perSeed.get(s.id)!
        cur.status = cur.inserted > 0 ? 'partial' : 'error'
        cur.error = msg
      }
    } finally {
      const chunkEnded = Date.now()
      for (const s of chunkSeeds) {
        perSeed.get(s.id)!.finishedAt = chunkEnded
        perSeed.get(s.id)!.startedAt = chunkStarted
      }
    }
  }

  const status: CollectSummary['status'] = lastErr
    ? inserted > 0
      ? 'partial'
      : 'error'
    : 'ok'
  const summary = { fetched, inserted, status, error: lastErr }
  await logRun(admin, source, triggeredBy, startedAt, summary)
  await logSeedRuns(admin, source, triggeredBy, perSeed)
  return { ...summary, source, durationMs: Date.now() - startedAt }
}

export async function collectNaverShoppingTrends(
  admin: SupabaseClient,
  triggeredBy: string,
): Promise<CollectSummary> {
  const startedAt = Date.now()
  const source = 'naver_shopping_insight'

  const { data: seeds, error: sErr } = await admin
    .from('jimscanner_trends_seeds')
    .select('id, source, kind, label, config')
    .eq('source', source)
    .eq('is_active', true)
    .order('display_order')
  if (sErr) {
    const summary = { fetched: 0, inserted: 0, status: 'error' as const, error: sErr.message }
    await logRun(admin, source, triggeredBy, startedAt, summary)
    return { ...summary, source, durationMs: Date.now() - startedAt }
  }
  const seedList = (seeds ?? []) as Seed[]
  if (seedList.length === 0) {
    const summary = { fetched: 0, inserted: 0, status: 'partial' as const, error: 'no active seeds' }
    await logRun(admin, source, triggeredBy, startedAt, summary)
    return { ...summary, source, durationMs: Date.now() - startedAt }
  }

  const startDate = dateNDaysAgoKst(30)
  const endDate = dateNDaysAgoKst(1)

  let fetched = 0
  let inserted = 0
  let lastErr: string | undefined

  const perSeed = new Map<string, { fetched: number; inserted: number; status: 'ok' | 'partial' | 'error'; error?: string; startedAt: number; finishedAt: number }>()
  for (const s of seedList) {
    perSeed.set(s.id, { fetched: 0, inserted: 0, status: 'ok', startedAt: Date.now(), finishedAt: Date.now() })
  }

  // 쇼핑 카테고리는 한 호출당 최대 3 카테고리
  for (const batch of chunk(seedList, 3)) {
    const chunkSeeds = batch.filter((s) => !!s.config.cid)
    const category: DatalabCategoryGroup[] = chunkSeeds.map((s) => ({
      name: s.config.name ?? s.label,
      param: [s.config.cid!],
    }))
    if (category.length === 0) continue
    const chunkStarted = Date.now()

    try {
      const resp = await fetchShoppingCategories({
        startDate,
        endDate,
        timeUnit: 'date',
        category,
      })
      fetched++
      for (const s of chunkSeeds) perSeed.get(s.id)!.fetched += 1

      await admin.from('jimscanner_trends_raw').insert({
        source,
        request_label: category.map((c) => c.name).join(', '),
        payload: resp as unknown as Record<string, unknown>,
      })

      const rows: Array<Record<string, unknown>> = []
      const titleToSeed = new Map<string, string>()
      for (let i = 0; i < (resp.results ?? []).length; i++) {
        const group = resp.results![i]
        const last = group.data?.[group.data.length - 1]
        rows.push({
          keyword: group.title,
          source,
          category: group.title,
          category_top: group.title,
          rank: null,
          volume_relative: last?.ratio ?? null,
        })
        const seedForGroup = chunkSeeds[i] ?? chunkSeeds.find((s) => (s.config.name ?? s.label) === group.title)
        if (seedForGroup) titleToSeed.set(group.title, seedForGroup.id)
      }
      if (rows.length > 0) {
        const { error: insErr } = await admin.from('jimscanner_trends_keywords').insert(rows)
        if (insErr) {
          lastErr = insErr.message
          for (const s of chunkSeeds) {
            const cur = perSeed.get(s.id)!
            cur.status = cur.inserted > 0 ? 'partial' : 'error'
            cur.error = insErr.message
          }
        } else {
          inserted += rows.length
          for (const r of rows) {
            const sid = titleToSeed.get(r.keyword as string)
            if (sid) perSeed.get(sid)!.inserted += 1
          }
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      lastErr = msg
      for (const s of chunkSeeds) {
        const cur = perSeed.get(s.id)!
        cur.status = cur.inserted > 0 ? 'partial' : 'error'
        cur.error = msg
      }
    } finally {
      const chunkEnded = Date.now()
      for (const s of chunkSeeds) {
        perSeed.get(s.id)!.finishedAt = chunkEnded
        perSeed.get(s.id)!.startedAt = chunkStarted
      }
    }
  }

  const status: CollectSummary['status'] = lastErr
    ? inserted > 0
      ? 'partial'
      : 'error'
    : 'ok'
  const summary = { fetched, inserted, status, error: lastErr }
  await logRun(admin, source, triggeredBy, startedAt, summary)
  await logSeedRuns(admin, source, triggeredBy, perSeed)
  return { ...summary, source, durationMs: Date.now() - startedAt }
}
