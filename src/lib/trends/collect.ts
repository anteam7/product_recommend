import type { SupabaseClient } from '@supabase/supabase-js'
import {
  fetchSearchTrend,
  fetchShoppingCategories,
  dateNDaysAgoKst,
  chunk,
  type DatalabKeywordGroup,
  type DatalabCategoryGroup,
  type DatalabGender,
} from './naver-datalab'

// DataLab 가 인정하는 ages 코드: 1=10-, 2=10s, 3=20s ... 11=60+
// 우리는 묶음 단위로 6 버킷 사용 — 각 버킷은 2~3개 코드를 합쳐 호출.
const AGE_BUCKETS: Array<{ bucket: '10' | '20' | '30' | '40' | '50' | '60'; ages: string[] }> = [
  { bucket: '10', ages: ['1', '2'] },
  { bucket: '20', ages: ['3', '4'] },
  { bucket: '30', ages: ['5', '6'] },
  { bucket: '40', ages: ['7', '8'] },
  { bucket: '50', ages: ['9', '10'] },
  { bucket: '60', ages: ['11'] },
]
const GENDERS: DatalabGender[] = ['m', 'f']

// cron timeout(60s) 보호 — 호출량이 폭발하지 않도록 시드 상한
const DEMOGRAPHIC_SEED_LIMIT = 6
const DEMOGRAPHIC_DELAY_MS = 120 // Naver DataLab QPS 보호

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

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}

/**
 * 한 seed (keyword group 또는 category) 에 대해 6 ages × 2 gender = 12 segment 호출.
 * 결과를 jimscanner_trends_demographics 에 적재.
 *
 * caller (search vs shopping) 에 따라 다른 fetch 함수를 주입받음.
 *
 * 실패는 segment 단위로 격리 — 일부 실패해도 나머지 진행.
 * 반환값: 성공 적재된 row 수.
 */
async function collectSegmentsForSeed(
  admin: SupabaseClient,
  source: string,
  keyword: string,
  startDate: string,
  endDate: string,
  doFetch: (ages: string[], gender: DatalabGender) => Promise<number | null>,
): Promise<{ inserted: number; error?: string }> {
  const rows: Array<Record<string, unknown>> = []
  let lastErr: string | undefined
  for (const { bucket, ages } of AGE_BUCKETS) {
    for (const gender of GENDERS) {
      try {
        const ratio = await doFetch(ages, gender)
        rows.push({
          source,
          keyword,
          age_bucket: bucket,
          gender,
          ratio_index: ratio,
        })
      } catch (e) {
        lastErr = e instanceof Error ? e.message : String(e)
      }
      await sleep(DEMOGRAPHIC_DELAY_MS)
    }
  }
  if (rows.length === 0) return { inserted: 0, error: lastErr }
  const { error: insErr } = await admin.from('jimscanner_trends_demographics').insert(rows)
  if (insErr) return { inserted: 0, error: insErr.message }
  return { inserted: rows.length, error: lastErr }
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

  // ─── 연령·성별 분포 수집 (keyword group 단위) ───
  // seed 상한 적용. 한 group 의 첫 keyword 만 demographics 호출용으로 사용.
  for (const seed of seedList.slice(0, DEMOGRAPHIC_SEED_LIMIT)) {
    const groupName = seed.config.groupName ?? seed.label
    const keywords = seed.config.keywords ?? []
    if (keywords.length === 0) continue
    try {
      const res = await collectSegmentsForSeed(
        admin,
        source,
        groupName,
        startDate,
        endDate,
        async (ages, gender) => {
          const resp = await fetchSearchTrend({
            startDate,
            endDate,
            timeUnit: 'date',
            keywordGroups: [{ groupName, keywords }],
            ages,
            gender,
          })
          const data = resp.results?.[0]?.data ?? []
          return data[data.length - 1]?.ratio ?? null
        },
      )
      inserted += res.inserted
      if (res.error) lastErr = res.error
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

  // ─── 연령·성별 분포 수집 (category 단위) ───
  for (const seed of seedList.slice(0, DEMOGRAPHIC_SEED_LIMIT)) {
    const cid = seed.config.cid
    if (!cid) continue
    const name = seed.config.name ?? seed.label
    try {
      const res = await collectSegmentsForSeed(
        admin,
        source,
        name,
        startDate,
        endDate,
        async (ages, gender) => {
          const resp = await fetchShoppingCategories({
            startDate,
            endDate,
            timeUnit: 'date',
            category: [{ name, param: [cid] }],
            ages,
            gender,
          })
          const data = resp.results?.[0]?.data ?? []
          return data[data.length - 1]?.ratio ?? null
        },
      )
      inserted += res.inserted
      if (res.error) lastErr = res.error
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
