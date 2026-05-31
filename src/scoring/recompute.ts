/**
 * scoring/recompute.ts — DataLab 재정규화 체인링크 보정 엔진.
 *
 * ## 왜 필요한가
 * 네이버 DataLab 은 "요청 윈도의 최댓값 = 100" 으로 매 호출 재정규화한 ratio 만
 * 반환한다. 매일 30일 윈도를 호출해 적재하면, 새 스파이크가 윈도에 들어오는
 * 순간 과거 값이 일제히 축소(rebase)되어 시계열이 비정상(non-stationary)이 되고
 * velocity(trend_score) 가 왜곡된다 — trend_score 는 4점수 중 1순위 가중 신호라
 * 이 편향이 모든 하위 보드로 전파된다.
 *
 * ## 해법 (CPI 식 체인링킹)
 * 매일 호출이 직전 호출과 29일 겹치는 점을 이용한다. 인접한 두 윈도의 겹침 구간
 * 평균비로 스케일 팩터(link factor)를 구하고, 새 윈도의 비겹침 구간만 그 팩터로
 * 스케일해 기존 연속 지수에 이어 붙인다(splice). 결과는 윈도 재정규화의 영향을
 * 제거한 연속 수요지수(continuous demand index)이며, velocity 는 이 지수로 재계산.
 *
 * 통계청 CPI/물가지수의 chain-linking, 주가지수 splice 와 동일한 원리.
 *
 * 관련: supabase/trends_v5_chainlink_index.sql,
 *       src/lib/trends/collect.ts (윈도 적재 지점),
 *       supabase/trends_v4_seller_tools.sql (jimscanner_trends_scores)
 */

import type { SupabaseClient } from '@supabase/supabase-js'

// ── 순수 자료형 ─────────────────────────────────────────────────────────────

/** 한 점: 특정 날짜의 (윈도 재정규화된) ratio */
export type SeriesPoint = { date: string; ratio: number }

/** 하루치 DataLab 호출 결과 = 윈도 하나. 호출 시각 순으로 정렬되어 들어온다. */
export type Window = {
  /** 이 윈도를 끌어온 시각 (raw.created_at) — 정렬 키 */
  fetchedAt: string
  /** 윈도 내 일자별 ratio (period 오름차순) */
  points: SeriesPoint[]
}

/** 보정된 연속 지수 한 점 */
export type IndexPoint = { date: string; index: number }

export type ChainLinkResult = {
  /** 보정 연속 지수 (date 오름차순) */
  indexed: IndexPoint[]
  /** 가장 최근 윈도의 원본 ratio 시계열 (감사/오버레이용) */
  raw: SeriesPoint[]
  meta: {
    windows: number
    splicedPoints: number
    /** 적용된 link factor 중 최댓값 — 재정규화 충격의 크기 지표 */
    maxLinkFactor: number
    /** 1.0 에서 가장 멀리 벗어난 link factor (보정 강도) */
    correctionSpan: number
  }
}

// ── 체인링크 코어 (순수 함수, 테스트 가능) ──────────────────────────────────

/**
 * 인접 윈도의 겹침 구간 평균비로 link factor 를 구해 연속 지수를 만든다.
 *
 * - 첫(가장 오래된) 윈도의 ratio 를 그대로 지수 기준으로 채택한다.
 * - 이후 각 윈도에 대해, 이미 지수에 들어와 있는 날짜(=겹침)들의
 *   (기존 지수 합) / (이번 윈도 ratio 합) 을 link factor 로 삼고,
 *   아직 지수에 없는 날짜(=새 구간)만 ratio × linkFactor 로 splice 한다.
 *
 * 윈도는 fetchedAt 오름차순으로 정렬해 넘긴다 (정렬 안 돼 있어도 내부에서 정렬).
 */
export function chainLink(windows: Window[]): ChainLinkResult {
  const ordered = [...windows]
    .filter((w) => w.points.length > 0)
    .sort((a, b) => a.fetchedAt.localeCompare(b.fetchedAt))

  const index = new Map<string, number>()
  let splicedPoints = 0
  let maxLinkFactor = 1
  let correctionSpan = 0

  ordered.forEach((win, wi) => {
    // 날짜 중복 제거: 같은 윈도 내 마지막 값 채택
    const pts = dedupeByDate(win.points)

    if (wi === 0) {
      for (const p of pts) {
        if (Number.isFinite(p.ratio)) index.set(p.date, p.ratio)
      }
      return
    }

    // 겹침 구간 = 이미 지수에 있는 날짜
    let sumExisting = 0
    let sumNew = 0
    for (const p of pts) {
      const existing = index.get(p.date)
      if (existing !== undefined && Number.isFinite(p.ratio)) {
        sumExisting += existing
        sumNew += p.ratio
      }
    }

    // 겹침이 없거나 이번 윈도 합이 0 이면 보정 불가 → 직접 이어 붙임(factor=1)
    const linkFactor = sumNew > 0 && sumExisting > 0 ? sumExisting / sumNew : 1
    maxLinkFactor = Math.max(maxLinkFactor, linkFactor)
    correctionSpan = Math.max(correctionSpan, Math.abs(linkFactor - 1))

    // 새(비겹침) 날짜만 스케일해 splice
    for (const p of pts) {
      if (!index.has(p.date) && Number.isFinite(p.ratio)) {
        index.set(p.date, p.ratio * linkFactor)
        splicedPoints++
      }
    }
  })

  const indexed: IndexPoint[] = [...index.entries()]
    .map(([date, value]) => ({ date, index: round2(value) }))
    .sort((a, b) => a.date.localeCompare(b.date))

  const lastWin = ordered[ordered.length - 1]
  const raw = lastWin ? dedupeByDate(lastWin.points) : []

  return {
    indexed,
    raw,
    meta: {
      windows: ordered.length,
      splicedPoints,
      maxLinkFactor: round2(maxLinkFactor),
      correctionSpan: round2(correctionSpan),
    },
  }
}

/**
 * 보정 연속 지수로부터 velocity (0~100) 를 산출.
 *
 * 최근 K일 평균과 직전 K일 평균의 모멘텀 비율을 0~100 으로 매핑한다.
 * - 비율 1.0(변화 없음) → 50
 * - 비율 ≥ 2.0(2배 급등) → 100
 * - 비율 ≤ 0.0 → 0
 * 윈도 재정규화 편향이 제거된 지수 위에서 계산하므로 가짜 감속이 사라진다.
 */
export function velocityFromIndex(indexed: IndexPoint[], k = 7): number {
  if (indexed.length < 2) return 50
  const series = indexed.map((p) => p.index)
  const win = Math.min(k, Math.floor(series.length / 2))
  if (win < 1) return 50

  const recent = series.slice(series.length - win)
  const prior = series.slice(series.length - 2 * win, series.length - win)
  const recentAvg = mean(recent)
  const priorAvg = prior.length > 0 ? mean(prior) : recentAvg

  if (priorAvg <= 0) return recentAvg > 0 ? 100 : 50
  const ratio = recentAvg / priorAvg // 1.0 = flat
  // ratio 0..2 → 0..100, 클램프
  const score = (ratio / 2) * 100
  return clamp(round2(score), 0, 100)
}

// ── DB 오케스트레이션 ───────────────────────────────────────────────────────

type RawRow = {
  request_label: string | null
  payload: unknown
  created_at: string
}

type DatalabPayload = {
  results?: Array<{
    title?: string
    data?: Array<{ period?: string; ratio?: number }>
  }>
}

export type RecomputeSummary = {
  source: string
  keywords: number
  written: number
  status: 'ok' | 'partial' | 'error'
  error?: string
}

/**
 * 한 소스(naver_search_trend / naver_shopping_insight)의 raw 윈도들을 읽어
 * 키워드(group title)별로 체인링크 → velocity → jimscanner_trends_keyword_index 적재.
 *
 * raw payload 는 매일 30일 윈도 전체를 담고 있어 29일 겹침이 보장된다.
 */
export async function recomputeChainLinkedIndex(
  admin: SupabaseClient,
  source: string,
  opts: { lookbackDays?: number } = {},
): Promise<RecomputeSummary> {
  const lookback = opts.lookbackDays ?? 60
  const sinceIso = new Date(Date.now() - lookback * 86_400_000).toISOString()

  const { data, error } = await admin
    .from('jimscanner_trends_raw')
    .select('request_label, payload, created_at')
    .eq('source', source)
    .gte('created_at', sinceIso)
    .order('created_at', { ascending: true })

  if (error) {
    return { source, keywords: 0, written: 0, status: 'error', error: error.message }
  }

  const rawRows = (data ?? []) as RawRow[]
  if (rawRows.length === 0) {
    return { source, keywords: 0, written: 0, status: 'partial', error: 'no raw windows' }
  }

  // 키워드(title)별 윈도 묶기
  const byKeyword = new Map<string, Window[]>()
  for (const row of rawRows) {
    const payload = row.payload as DatalabPayload
    for (const group of payload?.results ?? []) {
      const title = group.title
      if (!title) continue
      const points: SeriesPoint[] = (group.data ?? [])
        .map((d) => ({ date: String(d.period ?? ''), ratio: Number(d.ratio ?? 0) }))
        .filter((p) => p.date.length > 0)
      if (points.length === 0) continue
      const arr = byKeyword.get(title) ?? []
      arr.push({ fetchedAt: row.created_at, points })
      byKeyword.set(title, arr)
    }
  }

  let written = 0
  let lastErr: string | undefined
  const rows: Array<Record<string, unknown>> = []

  for (const [keyword, windows] of byKeyword) {
    const result = chainLink(windows)
    if (result.indexed.length === 0) continue
    const velocity = velocityFromIndex(result.indexed)
    rows.push({
      keyword,
      source,
      indexed_series: result.indexed,
      raw_series: result.raw,
      velocity,
      meta: result.meta,
    })
  }

  if (rows.length > 0) {
    // 마이그레이션 후 테이블 — 타입 생성 전이므로 as any 캐스팅 (CLAUDE.md 규칙)
    const { error: insErr } = await admin
      .from('jimscanner_trends_keyword_index')
      .insert(rows as never)
    if (insErr) lastErr = insErr.message
    else written = rows.length
  }

  const status: RecomputeSummary['status'] = lastErr
    ? written > 0
      ? 'partial'
      : 'error'
    : 'ok'
  return { source, keywords: byKeyword.size, written, status, error: lastErr }
}

// ── 작은 유틸 ───────────────────────────────────────────────────────────────

function dedupeByDate(points: SeriesPoint[]): SeriesPoint[] {
  const m = new Map<string, number>()
  for (const p of points) m.set(p.date, p.ratio)
  return [...m.entries()]
    .map(([date, ratio]) => ({ date, ratio }))
    .sort((a, b) => a.date.localeCompare(b.date))
}

function mean(xs: number[]): number {
  if (xs.length === 0) return 0
  return xs.reduce((a, b) => a + b, 0) / xs.length
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x))
}

function round2(x: number): number {
  return Math.round(x * 100) / 100
}
