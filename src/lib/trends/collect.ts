import type { SupabaseClient } from '@supabase/supabase-js'
import {
  fetchSearchTrend,
  fetchShoppingCategories,
  dateNDaysAgoKst,
  chunk,
  type DatalabKeywordGroup,
  type DatalabCategoryGroup,
  type DatalabDevice,
  type DatalabGender,
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

// ──────────────────────────────────────────────────────────────────────────
// 인구통계 페르소나 핑거프린트 수집
//
// Naver DataLab Shopping Insight 의 ages/gender/device 분기 파라미터를 fan-out 호출하여
// 카테고리별 인구통계 분포를 얻는다.
// DataLab 은 절대값이 아니라 그룹간 ratio 만 반환하므로,
// 각 단일 분기 호출의 가장 최근 ratio 가 곧 분기간 상대 분포가 된다.
// (예: age=10 호출 ratio + age=20 호출 ratio + ... 를 정규화 → 연령 분포)
//
// 핀+상위N 카테고리 시드 한정 일 1회 (쿼터 절약).
// ──────────────────────────────────────────────────────────────────────────

const DEMO_AGE_BUCKETS: string[] = ['10', '20', '30', '40', '50', '60']
const DEMO_GENDERS: DatalabGender[] = ['m', 'f']
const DEMO_DEVICES: DatalabDevice[] = ['pc', 'mo']

export type DemographicRow = {
  keyword: string
  cid: string | null
  source: string
  age_bucket: string | null
  gender: string | null
  device: string | null
  share: number
}

export async function collectDemographicProfile(
  source: 'naver_shopping_insight',
  category: DatalabCategoryGroup,
  startDate: string,
  endDate: string,
): Promise<DemographicRow[]> {
  const keyword = category.name
  const cid = category.param?.[0] ?? null
  const rows: DemographicRow[] = []

  async function callOne(opts: {
    ages?: string[]
    gender?: DatalabGender
    device?: DatalabDevice
  }): Promise<number | null> {
    const resp = await fetchShoppingCategories({
      startDate,
      endDate,
      timeUnit: 'date',
      category: [category],
      ages: opts.ages,
      gender: opts.gender,
      device: opts.device,
    })
    const group = resp.results?.[0]
    const last = group?.data?.[group.data.length - 1]
    return typeof last?.ratio === 'number' ? last.ratio : null
  }

  for (const age of DEMO_AGE_BUCKETS) {
    try {
      const ratio = await callOne({ ages: [age] })
      if (ratio !== null) {
        rows.push({ keyword, cid, source, age_bucket: age, gender: null, device: null, share: ratio })
      }
    } catch {
      // 단일 분기 실패는 분포 손실로 흡수
    }
  }

  for (const g of DEMO_GENDERS) {
    try {
      const ratio = await callOne({ gender: g })
      if (ratio !== null) {
        rows.push({ keyword, cid, source, age_bucket: null, gender: g, device: null, share: ratio })
      }
    } catch {
      // skip
    }
  }

  for (const d of DEMO_DEVICES) {
    try {
      const ratio = await callOne({ device: d })
      if (ratio !== null) {
        rows.push({ keyword, cid, source, age_bucket: null, gender: null, device: d, share: ratio })
      }
    } catch {
      // skip
    }
  }

  return rows
}

export async function collectDemographicsCron(
  admin: SupabaseClient,
  triggeredBy: string,
  opts: { topN?: number } = {},
): Promise<CollectSummary> {
  const startedAt = Date.now()
  const internalSource = 'naver_demographics'
  const dlSource = 'naver_shopping_insight' as const
  const topN = opts.topN ?? 8

  const { data: seeds, error: sErr } = await admin
    .from('jimscanner_trends_seeds')
    .select('id, source, kind, label, config')
    .eq('source', dlSource)
    .eq('is_active', true)
    .order('display_order')
    .limit(topN)
  if (sErr) {
    const summary = { fetched: 0, inserted: 0, status: 'error' as const, error: sErr.message }
    await logRun(admin, internalSource, triggeredBy, startedAt, summary)
    return { ...summary, source: internalSource, durationMs: Date.now() - startedAt }
  }
  const seedList = (seeds ?? []) as Seed[]
  const categories: DatalabCategoryGroup[] = seedList
    .filter((s) => !!s.config.cid)
    .map((s) => ({ name: s.config.name ?? s.label, param: [s.config.cid!] }))

  if (categories.length === 0) {
    const summary = {
      fetched: 0,
      inserted: 0,
      status: 'partial' as const,
      error: 'no active category seeds',
    }
    await logRun(admin, internalSource, triggeredBy, startedAt, summary)
    return { ...summary, source: internalSource, durationMs: Date.now() - startedAt }
  }

  const startDate = dateNDaysAgoKst(30)
  const endDate = dateNDaysAgoKst(1)

  let fetched = 0
  let inserted = 0
  let lastErr: string | undefined

  for (const cat of categories) {
    try {
      const rows = await collectDemographicProfile(dlSource, cat, startDate, endDate)
      fetched++
      if (rows.length > 0) {
        // 신규 테이블 — generated types 미반영. as any 캐스팅 필요.
        const { error: insErr } = await (admin as any)
          .from('jimscanner_trends_demographics')
          .insert(rows)
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
  await logRun(admin, internalSource, triggeredBy, startedAt, summary)
  return { ...summary, source: internalSource, durationMs: Date.now() - startedAt }
}
