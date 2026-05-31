import type { SupabaseClient } from '@supabase/supabase-js'
import {
  fetchSearchTrend,
  fetchShoppingCategories,
  dateNDaysAgoKst,
  chunk,
  type DatalabKeywordGroup,
  type DatalabCategoryGroup,
  type DatalabResultGroup,
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

// ─────────────────────────────────────────
// 연간 시즌 선점 — trailing 13개월 월별 곡선에서 위상(phase) 산출
// ─────────────────────────────────────────

/** 현재 월 (1~12, KST) */
function currentMonthKst(): number {
  const kst = new Date(Date.now() + 9 * 3600_000)
  return kst.getUTCMonth() + 1
}

/** 월(1~12) 중순 기준 대략적 week-of-year (1~52) */
function monthToWeek(month: number): number {
  return Math.min(52, Math.max(1, Math.round((month - 0.5) * (52 / 12))))
}

export type SeasonalityRow = {
  source: string
  keyword: string
  peak_month: number | null
  peak_week: number | null
  trough_month: number | null
  amplitude: number | null
  current_ratio: number | null
  current_phase: number | null
  weeks_to_peak: number | null
  monthly_curve: Array<{ month: number; ratio: number }> | null
}

/**
 * 한 DataLab 결과 그룹(13개월 월별 시계열)에서 연간 위상 지표 산출.
 * - 마지막 12개월을 달력 월(1~12)에 매핑해 같은 월이 여러 번이면 평균.
 * - peak/trough/amplitude/현재위상/피크까지 주차 계산.
 */
export function computeSeasonality(
  source: string,
  group: DatalabResultGroup,
): SeasonalityRow {
  const data = group.data ?? []
  // 월별 버킷 (1~12) — 평균 ratio
  const sums = new Array<number>(13).fill(0)
  const counts = new Array<number>(13).fill(0)
  for (const d of data) {
    const m = Number(d.period.slice(5, 7)) // 'YYYY-MM-DD' → MM
    if (m >= 1 && m <= 12 && typeof d.ratio === 'number') {
      sums[m] += d.ratio
      counts[m] += 1
    }
  }
  const monthly: Array<{ month: number; ratio: number }> = []
  for (let m = 1; m <= 12; m++) {
    if (counts[m] > 0) monthly.push({ month: m, ratio: sums[m] / counts[m] })
  }

  const base: SeasonalityRow = {
    source,
    keyword: group.title,
    peak_month: null,
    peak_week: null,
    trough_month: null,
    amplitude: null,
    current_ratio: null,
    current_phase: null,
    weeks_to_peak: null,
    monthly_curve: monthly.length > 0 ? monthly : null,
  }
  if (monthly.length < 2) return base

  let peak = monthly[0]
  let trough = monthly[0]
  for (const mm of monthly) {
    if (mm.ratio > peak.ratio) peak = mm
    if (mm.ratio < trough.ratio) trough = mm
  }

  const nowM = currentMonthKst()
  // 가장 최근 데이터 포인트(= 현재 시점에 가장 가까운 월) 의 ratio
  const last = data[data.length - 1]
  const currentRatio = last?.ratio ?? null

  const peakWeek = monthToWeek(peak.month)
  const nowWeek = monthToWeek(nowM)
  // 연중 wrap: 피크가 이미 지났으면 내년 피크까지
  const weeksToPeak = ((peakWeek - nowWeek + 52) % 52)

  const range = peak.ratio - trough.ratio
  const phase =
    currentRatio != null && range > 0
      ? Math.min(1, Math.max(0, (currentRatio - trough.ratio) / range))
      : null

  return {
    ...base,
    peak_month: peak.month,
    peak_week: peakWeek,
    trough_month: trough.month,
    amplitude: Math.round((peak.ratio / Math.max(trough.ratio, 1)) * 100) / 100,
    current_ratio: currentRatio,
    current_phase: phase != null ? Math.round(phase * 100) / 100 : null,
    weeks_to_peak: weeksToPeak,
  }
}

/**
 * 시드 키워드별 trailing 13개월 월별 곡선을 별도 조회해 위상 산출 후
 * jimscanner_trends_seasonality 에 upsert.
 */
export async function collectNaverSeasonality(
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
    await logRun(admin, 'naver_seasonality', triggeredBy, startedAt, summary)
    return { ...summary, source: 'naver_seasonality', durationMs: Date.now() - startedAt }
  }
  const seedList = (seeds ?? []) as Seed[]
  if (seedList.length === 0) {
    const summary = { fetched: 0, inserted: 0, status: 'partial' as const, error: 'no active seeds' }
    await logRun(admin, 'naver_seasonality', triggeredBy, startedAt, summary)
    return { ...summary, source: 'naver_seasonality', durationMs: Date.now() - startedAt }
  }

  // trailing 13개월 (현재 진행월 포함 위해 1개월분 여유) — DataLab 월별
  const startDate = dateNDaysAgoKst(396) // ≈ 13개월
  const endDate = dateNDaysAgoKst(1)

  let fetched = 0
  let inserted = 0
  let lastErr: string | undefined

  for (const batch of chunk(seedList, 5)) {
    // 시드명 → seed_id 역참조 (groupName/label 기준)
    const seedByName = new Map<string, string>()
    for (const s of batch) {
      seedByName.set(s.config.groupName ?? s.label, s.id)
    }
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
        timeUnit: 'month',
        keywordGroups,
      })
      fetched++

      const rows = (resp.results ?? []).map((group) => {
        const s = computeSeasonality(source, group)
        return {
          seed_id: seedByName.get(group.title) ?? null,
          source: s.source,
          keyword: s.keyword,
          peak_month: s.peak_month,
          peak_week: s.peak_week,
          trough_month: s.trough_month,
          amplitude: s.amplitude,
          current_ratio: s.current_ratio,
          current_phase: s.current_phase,
          weeks_to_peak: s.weeks_to_peak,
          monthly_curve: s.monthly_curve as unknown as Record<string, unknown>,
          last_computed: new Date().toISOString(),
        }
      })
      if (rows.length > 0) {
        const { error: upErr } = await admin
          .from('jimscanner_trends_seasonality')
          .upsert(rows, { onConflict: 'source,keyword' })
        if (upErr) lastErr = upErr.message
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
  await logRun(admin, 'naver_seasonality', triggeredBy, startedAt, summary)
  return { ...summary, source: 'naver_seasonality', durationMs: Date.now() - startedAt }
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
