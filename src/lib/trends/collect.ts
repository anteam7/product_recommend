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

// ── 인구통계 버킷 정의 ──────────────────────────────────────
// Naver DataLab 은 성별(m/f)·연령대(ages[]) 로 동일 검색어/카테고리를 쪼개 ratio 반환.
// 검색어 트렌드와 쇼핑 인사이트의 ages 코드 체계가 다르므로 source 별로 매핑한다.
//   - 검색어 트렌드 ages: '1'..'11' (1=0-12,2=13-18,3=19-24,...,11=60+)
//   - 쇼핑 인사이트 ages: '10','20','30','40','50','60' (10세 단위)
export type AgeBucketKey = '10s' | '20s' | '30s' | '40s' | '50s+'
export type GenderKey = 'm' | 'f'

const AGE_BUCKETS_SEARCH: Array<{ key: AgeBucketKey; ages: string[] }> = [
  { key: '10s', ages: ['2'] },
  { key: '20s', ages: ['3', '4'] },
  { key: '30s', ages: ['5', '6'] },
  { key: '40s', ages: ['7', '8'] },
  { key: '50s+', ages: ['9', '10', '11'] },
]

const AGE_BUCKETS_SHOPPING: Array<{ key: AgeBucketKey; ages: string[] }> = [
  { key: '10s', ages: ['10'] },
  { key: '20s', ages: ['20'] },
  { key: '30s', ages: ['30'] },
  { key: '40s', ages: ['40'] },
  { key: '50s+', ages: ['50', '60'] },
]

const GENDERS: GenderKey[] = ['m', 'f']

/** 데이터 포인트들의 평균 ratio (해당 세그먼트의 기간 평균 수요) */
function avgRatio(data: Array<{ ratio: number }> | undefined): number {
  if (!data || data.length === 0) return 0
  const sum = data.reduce((acc, d) => acc + (d.ratio ?? 0), 0)
  return sum / data.length
}

/** 레이트리밋 완화용 짧은 대기 */
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
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

/**
 * 인구통계 수집 — 검색어 트렌드 + 쇼핑 인사이트 시드 전체를
 * (성별 2종 × 연령버킷 5종) 으로 쪼개 jimscanner_trends_demographics 에 적재.
 *
 * 호출량: 시드당 10회(2×5) → 시드 N개면 10N회. 레이트리밋 보호를 위해
 * 호출마다 짧게 대기하고, 한 세그먼트 실패는 건너뛴다(부분성공 허용).
 * '전체 평균 한 점' 만 있던 기존 수집을 보완해 '누가 사는가' 를 채운다.
 */
export async function collectNaverDemographics(
  admin: SupabaseClient,
  triggeredBy: string,
): Promise<CollectSummary> {
  const startedAt = Date.now()
  const source = 'naver_demographics'

  const { data: seeds, error: sErr } = await admin
    .from('jimscanner_trends_seeds')
    .select('id, source, kind, label, config')
    .in('source', ['naver_search_trend', 'naver_shopping_insight'])
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
  const collectedAt = dateNDaysAgoKst(0) // KST 오늘 (업서트 키)

  let fetched = 0
  let inserted = 0
  let lastErr: string | undefined

  for (const seed of seedList) {
    const isShopping = seed.source === 'naver_shopping_insight'
    const buckets = isShopping ? AGE_BUCKETS_SHOPPING : AGE_BUCKETS_SEARCH

    const keywordName = seed.config.groupName ?? seed.config.name ?? seed.label
    const keywords = seed.config.keywords ?? []
    const cid = seed.config.cid
    // 검색어 시드는 keywords, 쇼핑 시드는 cid 가 있어야 호출 가능
    if (isShopping ? !cid : keywords.length === 0) continue

    const rows: Array<Record<string, unknown>> = []

    for (const gender of GENDERS) {
      for (const bucket of buckets) {
        try {
          const resp = isShopping
            ? await fetchShoppingCategories({
                startDate,
                endDate,
                timeUnit: 'date',
                category: [{ name: keywordName, param: [cid!] }],
                gender,
                ages: bucket.ages,
              })
            : await fetchSearchTrend({
                startDate,
                endDate,
                timeUnit: 'date',
                keywordGroups: [{ groupName: keywordName, keywords }],
                gender,
                ages: bucket.ages,
              })
          fetched++
          const ratio = avgRatio(resp.results?.[0]?.data)
          rows.push({
            source,
            keyword: keywordName,
            category: isShopping ? keywordName : null,
            gender,
            age_bucket: bucket.key,
            ratio,
            collected_at: collectedAt,
          })
          await sleep(120)
        } catch (e) {
          lastErr = e instanceof Error ? e.message : String(e)
        }
      }
    }

    if (rows.length > 0) {
      // 신규 테이블 — 생성된 DB 타입에 아직 없어 as any 캐스팅
      const { error: insErr } = await (admin as any)
        .from('jimscanner_trends_demographics')
        .upsert(rows, { onConflict: 'source,keyword,gender,age_bucket,collected_at' })
      if (insErr) lastErr = insErr.message
      else inserted += rows.length
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
