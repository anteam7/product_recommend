import type { SupabaseClient } from '@supabase/supabase-js'
import {
  fetchSearchTrend,
  dateNDaysAgoKst,
  chunk,
  type DatalabKeywordGroup,
  type DatalabDevice,
  type DatalabGender,
} from './naver-datalab'

/**
 * 인구·디바이스 페르소나 매트릭스 수집기.
 *
 * Naver DataLab `/v1/datalab/search` 의 ages·gender·device 파라미터를 셀 단위로 변경하며 호출.
 * - 연령: '2'(13-18), '3'(19-24), '4'(25-29), '5'(30-39), '6'(40-49), '7'(50-59) → 6 buckets
 * - 성별: 'm', 'f' → 2 buckets
 * - 디바이스: 'pc', 'mo' → 2 buckets
 * 셀 수 = 6×2×2 = 24, 키워드 그룹은 한 호출당 최대 5 → pinned 키워드 25개 가정 시 24×5 = 120 calls.
 *
 * ratio 는 호출 단위(셀)내 그룹간 정규화이므로 셀간 절대 비교 불가.
 * 키워드 단위로 24개 셀 ratio 의 합을 1 로 다시 정규화한 값을 `ratio_normalized` 로 저장 — 페르소나 비율.
 */

const AGE_BUCKETS = ['2', '3', '4', '5', '6', '7'] as const // 13-18 / 19-24 / 25-29 / 30s / 40s / 50s
const GENDERS: Exclude<DatalabGender, ''>[] = ['m', 'f']
const DEVICES: Exclude<DatalabDevice, ''>[] = ['pc', 'mo']

export type DemographicsSummary = {
  source: string
  fetched: number
  inserted: number
  durationMs: number
  status: 'ok' | 'partial' | 'error'
  error?: string
}

type KeywordTarget = { keyword: string; aliases?: string[] }

async function logRun(
  admin: SupabaseClient,
  source: string,
  triggeredBy: string,
  startedAt: number,
  summary: Omit<DemographicsSummary, 'durationMs' | 'source'>,
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

/**
 * pinned 키워드 + seeds 의 keyword_group 키워드를 합쳐 페르소나 매트릭스 수집.
 * 한 cron 당 호출 폭증을 막기 위해 최대 `maxKeywords` 개만 처리 (기본 25).
 */
export async function collectNaverDatalabDemographics(
  admin: SupabaseClient,
  triggeredBy: string,
  opts: { maxKeywords?: number } = {},
): Promise<DemographicsSummary> {
  const startedAt = Date.now()
  const source = 'naver_datalab_demographics'
  const maxKeywords = opts.maxKeywords ?? 25

  // 1) pinned 키워드 우선
  const pinnedRes = await admin
    .from('jimscanner_trends_pins')
    .select('keyword')
    .order('pinned_at', { ascending: false })
    .limit(maxKeywords)
  const pinnedKeywords: string[] = (((pinnedRes.data ?? []) as Array<{ keyword: string }>)
    .map((r) => r.keyword)
    .filter(Boolean))

  // 2) 부족분은 active seeds (keyword_group) 에서 보충
  let keywords: KeywordTarget[] = pinnedKeywords.map((k) => ({ keyword: k }))
  if (keywords.length < maxKeywords) {
    const seedRes = await admin
      .from('jimscanner_trends_seeds')
      .select('label, config')
      .eq('source', 'naver_search_trend')
      .eq('is_active', true)
      .order('display_order')
    const seedTargets: KeywordTarget[] = (
      ((seedRes.data ?? []) as Array<{ label: string; config: { keywords?: string[] } }>)
        .map((s) => ({
          keyword: s.label,
          aliases: s.config?.keywords && s.config.keywords.length > 0 ? s.config.keywords : [s.label],
        }))
    )
    for (const t of seedTargets) {
      if (keywords.length >= maxKeywords) break
      if (keywords.some((k) => k.keyword === t.keyword)) continue
      keywords.push(t)
    }
  }
  if (keywords.length === 0) {
    const summary = { fetched: 0, inserted: 0, status: 'partial' as const, error: 'no keywords' }
    await logRun(admin, source, triggeredBy, startedAt, summary)
    return { ...summary, source, durationMs: Date.now() - startedAt }
  }

  // 키워드별 본 키워드를 단일 alias 로 매핑 (DataLab keywords 배열은 동의어 묶음)
  const groups: DatalabKeywordGroup[] = keywords.map((k) => ({
    groupName: k.keyword,
    keywords: k.aliases && k.aliases.length > 0 ? k.aliases : [k.keyword],
  }))

  const startDate = dateNDaysAgoKst(30)
  const endDate = dateNDaysAgoKst(1)

  // cell ratio 누적: key = `${keyword}::${age}::${gender}::${device}` → ratio
  const cellRatio = new Map<string, number>()

  let fetched = 0
  let lastErr: string | undefined

  // 셀 순회: 6 × 2 × 2 = 24 cell, 그 안에서 키워드 그룹을 5개씩 청크
  outer: for (const age of AGE_BUCKETS) {
    for (const gender of GENDERS) {
      for (const device of DEVICES) {
        for (const groupBatch of chunk(groups, 5)) {
          try {
            const resp = await fetchSearchTrend({
              startDate,
              endDate,
              timeUnit: 'date',
              keywordGroups: groupBatch,
              ages: [age],
              gender,
              device,
            })
            fetched++
            for (const g of resp.results ?? []) {
              const last = g.data?.[g.data.length - 1]
              const r = last?.ratio
              if (typeof r === 'number') {
                cellRatio.set(`${g.title}::${age}::${gender}::${device}`, r)
              }
            }
          } catch (e) {
            lastErr = e instanceof Error ? e.message : String(e)
            // 단일 셀 실패는 무시하고 계속
          }
          // 시간 가드 — Vercel 60초 한도 근접 시 조기 종료
          if (Date.now() - startedAt > 55_000) {
            lastErr = `timeout guard at age=${age} gender=${gender} device=${device}`
            break outer
          }
        }
      }
    }
  }

  // 키워드별 정규화 — 셀 ratio 합으로 나눠 비율 산출
  const collectedAt = new Date().toISOString()
  type Row = {
    keyword: string
    age: string
    gender: string
    device: string
    ratio_raw: number
    ratio_normalized: number
    collected_at: string
  }
  const rows: Row[] = []
  for (const target of keywords) {
    const keyword = target.keyword
    let sum = 0
    const cells: Array<{ age: string; gender: string; device: string; ratio: number }> = []
    for (const age of AGE_BUCKETS) {
      for (const gender of GENDERS) {
        for (const device of DEVICES) {
          const r = cellRatio.get(`${keyword}::${age}::${gender}::${device}`) ?? 0
          cells.push({ age, gender, device, ratio: r })
          sum += r
        }
      }
    }
    if (sum <= 0) continue
    for (const c of cells) {
      rows.push({
        keyword,
        age: c.age,
        gender: c.gender,
        device: c.device,
        ratio_raw: c.ratio,
        ratio_normalized: c.ratio / sum,
        collected_at: collectedAt,
      })
    }
  }

  let inserted = 0
  if (rows.length > 0) {
    // chunked insert (대량 row 보호)
    for (const part of chunk(rows, 500)) {
      const { error: insErr } = await admin
        .from('jimscanner_trends_demographics')
        .insert(part as unknown as never)
      if (insErr) {
        lastErr = insErr.message
      } else {
        inserted += part.length
      }
    }
  }

  const status: DemographicsSummary['status'] = lastErr
    ? inserted > 0
      ? 'partial'
      : 'error'
    : 'ok'
  const summary = { fetched, inserted, status, error: lastErr }
  await logRun(admin, source, triggeredBy, startedAt, summary)
  return { ...summary, source, durationMs: Date.now() - startedAt }
}

/**
 * 분석 헬퍼 — 최신 페르소나 셀 row 배열을 받아 (1) 1등 페르소나 라벨, (2) 엔트로피, (3) 광고 매체 추천을 계산.
 */
export type DemographicCell = {
  keyword: string
  age: string
  gender: string
  device: string
  ratio_normalized: number | null
}

export type PersonaSummary = {
  keyword: string
  primaryLabel: string         // 예: "30대 여성·모바일 47%"
  primaryRatio: number         // 0~1
  entropy: number              // 0~ln(24) — 낮을수록 편중
  ageDist: Record<string, number>
  genderDist: Record<string, number>
  deviceDist: Record<string, number>
  adChannel: string            // 추천 광고 채널
  adReason: string
}

const AGE_LABEL: Record<string, string> = {
  '2': '10대',
  '3': '20대 초반',
  '4': '20대 후반',
  '5': '30대',
  '6': '40대',
  '7': '50대',
}
const GENDER_LABEL: Record<string, string> = { m: '남성', f: '여성' }
const DEVICE_LABEL: Record<string, string> = { pc: 'PC', mo: '모바일' }

export function summarizePersona(cells: DemographicCell[]): PersonaSummary | null {
  if (cells.length === 0) return null
  const keyword = cells[0].keyword
  let top = cells[0]
  let topRatio = 0
  const ageDist: Record<string, number> = {}
  const genderDist: Record<string, number> = {}
  const deviceDist: Record<string, number> = {}
  let entropy = 0
  for (const c of cells) {
    const r = c.ratio_normalized ?? 0
    if (r > topRatio) {
      topRatio = r
      top = c
    }
    ageDist[c.age] = (ageDist[c.age] ?? 0) + r
    genderDist[c.gender] = (genderDist[c.gender] ?? 0) + r
    deviceDist[c.device] = (deviceDist[c.device] ?? 0) + r
    if (r > 0) entropy -= r * Math.log(r)
  }

  const topAge = Object.entries(ageDist).sort((a, b) => b[1] - a[1])[0]?.[0] ?? '5'
  const topGender = Object.entries(genderDist).sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'f'
  const topDevice = Object.entries(deviceDist).sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'mo'

  const primaryLabel = `${AGE_LABEL[topAge] ?? topAge} ${GENDER_LABEL[topGender] ?? topGender}·${DEVICE_LABEL[topDevice] ?? topDevice} ${Math.round(topRatio * 100)}%`

  // 광고 매체 추천 — 단순 룰
  let adChannel = '네이버 검색광고'
  let adReason = '기본 추천'
  const youngMobile = (ageDist['2'] ?? 0) + (ageDist['3'] ?? 0) + (ageDist['4'] ?? 0)
  const old40plusPc = ((ageDist['6'] ?? 0) + (ageDist['7'] ?? 0)) * (deviceDist['pc'] ?? 0)
  if (youngMobile > 0.55 && (deviceDist['mo'] ?? 0) > 0.6) {
    adChannel = '인스타그램/틱톡 (SNS)'
    adReason = '10·20대 모바일 편중 — 숏폼 SNS 적합'
  } else if ((ageDist['6'] ?? 0) + (ageDist['7'] ?? 0) > 0.45 && (deviceDist['pc'] ?? 0) > 0.5) {
    adChannel = '네이버 검색광고 (PC)'
    adReason = '40·50대 PC 편중 — 네이버 검색 적합'
  } else if ((genderDist['f'] ?? 0) > 0.7 && (ageDist['5'] ?? 0) > 0.3) {
    adChannel = '카카오 모먼트 + 인스타'
    adReason = '30대 여성 편중'
  } else if ((genderDist['m'] ?? 0) > 0.7 && (deviceDist['mo'] ?? 0) > 0.55) {
    adChannel = '유튜브 + 구글 디스커버'
    adReason = '남성 모바일 편중'
  } else if (old40plusPc > 0.25) {
    adChannel = '네이버 검색 + 카카오톡 비즈보드'
    adReason = '40대+ PC 트래픽 비중 높음'
  }

  return {
    keyword,
    primaryLabel,
    primaryRatio: topRatio,
    entropy,
    ageDist,
    genderDist,
    deviceDist,
    adChannel,
    adReason,
  }
}

export const PERSONA_AGES = AGE_BUCKETS
export const PERSONA_AGE_LABEL = AGE_LABEL
export const PERSONA_GENDER_LABEL = GENDER_LABEL
export const PERSONA_DEVICE_LABEL = DEVICE_LABEL

// 기본 cell 노출 + summary helper에서 top cell이 직접 필요할 때 import 가능하게 export
void GENDERS
void DEVICES
