import type { SupabaseClient } from '@supabase/supabase-js'
import {
  fetchSearchTrend,
  fetchShoppingCategories,
  fetchShoppingCategoryKeywordArea,
  dateNDaysAgoKst,
  chunk,
  type DatalabKeywordGroup,
  type DatalabCategoryGroup,
} from './naver-datalab'
import { KR_REGIONS } from './kr-regions'

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

  // 검색어 트렌드는 한 호출당 최대 5 그룹
  for (const batch of chunk(seedList, 5)) {
    const keywordGroups: DatalabKeywordGroup[] = batch
      .map((s) => ({
        groupName: s.config.groupName ?? s.label,
        keywords: s.config.keywords ?? [],
      }))
      .filter((g) => g.keywords.length > 0)
    if (keywordGroups.length === 0) continue

    try {
      const resp = await fetchSearchTrend({
        startDate,
        endDate,
        timeUnit: 'date',
        keywordGroups,
      })
      fetched++

      // raw 저장
      await admin.from('jimscanner_trends_raw').insert({
        source,
        request_label: keywordGroups.map((g) => g.groupName).join(', '),
        payload: resp as unknown as Record<string, unknown>,
      })

      // keywords 정규화 — 각 그룹의 마지막 시점 ratio
      const rows: Array<Record<string, unknown>> = []
      for (const group of resp.results ?? []) {
        const last = group.data?.[group.data.length - 1]
        rows.push({
          keyword: group.title,
          source,
          category: null,
          category_top: null,
          rank: null,
          volume_relative: last?.ratio ?? null,
        })
      }
      if (rows.length > 0) {
        const { error: insErr } = await admin.from('jimscanner_trends_keywords').insert(rows)
        if (insErr) lastErr = insErr.message
        else inserted += rows.length
      }
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e)
    }
  }

  const status: CollectSummary['status'] = lastErr
    ? inserted > 0
      ? 'partial'
      : 'error'
    : 'ok'
  const summary = { fetched, inserted, status, error: lastErr }
  await logRun(admin, source, triggeredBy, startedAt, summary)
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

  // 쇼핑 카테고리는 한 호출당 최대 3 카테고리
  for (const batch of chunk(seedList, 3)) {
    const category: DatalabCategoryGroup[] = batch
      .filter((s) => !!s.config.cid)
      .map((s) => ({
        name: s.config.name ?? s.label,
        param: [s.config.cid!],
      }))
    if (category.length === 0) continue

    try {
      const resp = await fetchShoppingCategories({
        startDate,
        endDate,
        timeUnit: 'date',
        category,
      })
      fetched++

      await admin.from('jimscanner_trends_raw').insert({
        source,
        request_label: category.map((c) => c.name).join(', '),
        payload: resp as unknown as Record<string, unknown>,
      })

      const rows: Array<Record<string, unknown>> = []
      for (const group of resp.results ?? []) {
        const last = group.data?.[group.data.length - 1]
        rows.push({
          keyword: group.title,
          source,
          category: group.title, // 카테고리 자체가 키워드
          category_top: group.title,
          rank: null,
          volume_relative: last?.ratio ?? null,
        })
      }
      if (rows.length > 0) {
        const { error: insErr } = await admin.from('jimscanner_trends_keywords').insert(rows)
        if (insErr) lastErr = insErr.message
        else inserted += rows.length
      }
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e)
    }
  }

  const status: CollectSummary['status'] = lastErr
    ? inserted > 0
      ? 'partial'
      : 'error'
    : 'ok'
  const summary = { fetched, inserted, status, error: lastErr }
  await logRun(admin, source, triggeredBy, startedAt, summary)
  return { ...summary, source, durationMs: Date.now() - startedAt }
}

/**
 * 지역별 디맨드 편중도 수집.
 * 입력 키워드: pinned=true 인 jimscanner_trends_keywords 키워드 (최근 30일 이내)
 *           + seed (naver_shopping_region, kind=category, config.cid) 의 cid 들.
 * 각 (키워드 × 17개 시도) 에 대해 Naver area API 호출, ratio 정규화하여
 * jimscanner_trends_region_share 에 적재.
 */
export async function collectNaverShoppingRegionTrends(
  admin: SupabaseClient,
  triggeredBy: string,
): Promise<CollectSummary> {
  const startedAt = Date.now()
  const source = 'naver_shopping_region'

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
  const cidList = ((seeds ?? []) as Seed[])
    .map((s) => s.config.cid)
    .filter((c): c is string => !!c)
  if (cidList.length === 0) {
    const summary = {
      fetched: 0,
      inserted: 0,
      status: 'partial' as const,
      error: 'no active naver_shopping_region seeds',
    }
    await logRun(admin, source, triggeredBy, startedAt, summary)
    return { ...summary, source, durationMs: Date.now() - startedAt }
  }

  const { data: pinnedKws, error: kErr } = await admin
    .from('jimscanner_trends_keywords')
    .select('keyword, collected_at')
    .eq('pinned', true)
    .order('collected_at', { ascending: false })
    .limit(50)
  if (kErr) {
    const summary = { fetched: 0, inserted: 0, status: 'error' as const, error: kErr.message }
    await logRun(admin, source, triggeredBy, startedAt, summary)
    return { ...summary, source, durationMs: Date.now() - startedAt }
  }
  const keywords = Array.from(
    new Set(((pinnedKws ?? []) as Array<{ keyword: string }>).map((r) => r.keyword)),
  )
  if (keywords.length === 0) {
    const summary = {
      fetched: 0,
      inserted: 0,
      status: 'partial' as const,
      error: 'no pinned keywords',
    }
    await logRun(admin, source, triggeredBy, startedAt, summary)
    return { ...summary, source, durationMs: Date.now() - startedAt }
  }

  const startDate = dateNDaysAgoKst(30)
  const endDate = dateNDaysAgoKst(1)
  const areaCodes = KR_REGIONS.map((r) => r.naverArea)

  let fetched = 0
  let inserted = 0
  let lastErr: string | undefined

  for (const keyword of keywords) {
    let resp: Awaited<ReturnType<typeof fetchShoppingCategoryKeywordArea>> | undefined
    let usedCid: string | undefined
    for (const cid of cidList) {
      try {
        const r = await fetchShoppingCategoryKeywordArea({
          startDate,
          endDate,
          timeUnit: 'date',
          category: cid,
          keyword,
          area: areaCodes,
        })
        fetched++
        const total = (r.results ?? []).reduce(
          (acc, g) => acc + (g.data?.reduce((s, d) => s + (d.ratio ?? 0), 0) ?? 0),
          0,
        )
        if (total > 0) {
          resp = r
          usedCid = cid
          break
        }
      } catch (e) {
        lastErr = e instanceof Error ? e.message : String(e)
      }
    }
    if (!resp) continue

    await admin.from('jimscanner_trends_raw').insert({
      source,
      request_label: `${keyword} (cid=${usedCid ?? '?'})`,
      payload: resp as unknown as Record<string, unknown>,
    })

    const rawByArea: Record<string, number> = {}
    for (const g of resp.results ?? []) {
      const sum = g.data?.reduce((s, d) => s + (d.ratio ?? 0), 0) ?? 0
      rawByArea[g.title] = sum
    }
    const total = Object.values(rawByArea).reduce((s, v) => s + v, 0)
    if (total <= 0) continue

    const rows = KR_REGIONS.map((r) => {
      const raw = rawByArea[r.naverArea] ?? 0
      return {
        source,
        keyword,
        region_code: r.code,
        region_name: r.name,
        share_ratio: raw / total,
        raw_ratio: raw,
      }
    })

    // region_share 는 generated types 에 아직 없음 — as any 캐스팅.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error: insErr } = await (admin as any)
      .from('jimscanner_trends_region_share')
      .insert(rows)
    if (insErr) lastErr = insErr.message
    else inserted += rows.length
  }

  const status: CollectSummary['status'] = lastErr
    ? inserted > 0
      ? 'partial'
      : 'error'
    : 'ok'
  const summary = { fetched, inserted, status, error: lastErr }
  await logRun(admin, source, triggeredBy, startedAt, summary)
  return { ...summary, source, durationMs: Date.now() - startedAt }
}
