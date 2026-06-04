import { NextResponse, type NextRequest } from 'next/server'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import { isAuthorizedCron } from '@/lib/market-signals'
import type { WeatherMetric } from '@/app/admin/(dashboard)/trend-radar/weather-radar/rules'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

// 기상청 단기예보(getVilageFcst) — 무료. 발표 회차마다 +3일 TMX/TMN/강수확률 제공.
// 중기(10일)는 별도 통보문 파싱이 필요하므로 1차는 단기 3일 + 권역 격자로 시작한다.
// (KMA_API_KEY 없으면 skipped — build/배포는 막지 않음)
const KMA_BASE =
  'https://apis.data.go.kr/1360000/VilageFcstInfoService_2.0/getVilageFcst'

// 주요 소비권역 대표 격자 (nx, ny) — 수도권/영남/호남/중부
const REGIONS: { region: string; nx: number; ny: number }[] = [
  { region: '서울', nx: 60, ny: 127 },
  { region: '부산', nx: 98, ny: 76 },
  { region: '광주', nx: 58, ny: 74 },
  { region: '대전', nx: 67, ny: 100 },
]

interface ForecastInsert {
  base_date: string
  forecast_date: string
  region: string
  metric: WeatherMetric
  value: number | null
}

// KMA basedate/basetime: 단기예보 발표시각 02·05·08·11·14·17·20·23시. 안전하게 가장 최근 02시 회차 사용.
function kmaBase(now: Date): { baseDate: string; baseTime: string } {
  const kst = new Date(now.getTime() + 9 * 3_600_000) // UTC→KST 보정
  const y = kst.getUTCFullYear()
  const m = String(kst.getUTCMonth() + 1).padStart(2, '0')
  const d = String(kst.getUTCDate()).padStart(2, '0')
  return { baseDate: `${y}${m}${d}`, baseTime: '0200' }
}

function isoDate(yyyymmdd: string): string {
  return `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`
}

async function fetchRegion(
  key: string,
  baseDate: string,
  baseTime: string,
  r: { region: string; nx: number; ny: number },
): Promise<ForecastInsert[]> {
  const url =
    `${KMA_BASE}?serviceKey=${encodeURIComponent(key)}&dataType=JSON&numOfRows=1000&pageNo=1` +
    `&base_date=${baseDate}&base_time=${baseTime}&nx=${r.nx}&ny=${r.ny}`
  const res = await fetch(url, { cache: 'no-store' })
  if (!res.ok) throw new Error(`KMA ${r.region} ${res.status}`)
  const json: unknown = await res.json()

  const items =
    (json as { response?: { body?: { items?: { item?: unknown[] } } } })?.response?.body?.items?.item ?? []

  // category TMX(일최고)·TMN(일최저)·POP(강수확률) 만 추출
  const out: ForecastInsert[] = []
  for (const raw of items as Array<Record<string, unknown>>) {
    const category = String(raw.category ?? '')
    const fcstDate = String(raw.fcstDate ?? '')
    const fcstValueNum = Number(raw.fcstValue)
    if (!fcstDate || Number.isNaN(fcstValueNum)) continue

    let metric: WeatherMetric | null = null
    if (category === 'TMX') metric = 'tmax'
    else if (category === 'TMN') metric = 'tmin'
    else if (category === 'POP') metric = 'rain_prob'
    if (!metric) continue
    // POP 는 시간별 다수 → 일중 최대만 채택
    out.push({
      base_date: isoDate(baseDate),
      forecast_date: isoDate(fcstDate),
      region: r.region,
      metric,
      value: fcstValueNum,
    })
  }
  return out
}

// 같은 (date,region,metric) 중복 — rain_prob 는 max, 온도는 그대로 (TMX/TMN 은 일1회)
function dedupeMax(rows: ForecastInsert[]): ForecastInsert[] {
  const m = new Map<string, ForecastInsert>()
  for (const row of rows) {
    const key = `${row.forecast_date}:${row.region}:${row.metric}`
    const prev = m.get(key)
    if (!prev || (row.value ?? -Infinity) > (prev.value ?? -Infinity)) m.set(key, row)
  }
  return [...m.values()]
}

export async function GET(request: NextRequest) {
  if (!isAuthorizedCron(request))
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const key = process.env.KMA_API_KEY
  if (!key) {
    return NextResponse.json({
      ok: true,
      skipped: true,
      message: 'KMA_API_KEY 미설정 — 예보 적재 생략',
    })
  }

  const { baseDate, baseTime } = kmaBase(new Date())

  const settled = await Promise.allSettled(
    REGIONS.map((r) => fetchRegion(key, baseDate, baseTime, r)),
  )

  const rows: ForecastInsert[] = []
  const errors: string[] = []
  for (const s of settled) {
    if (s.status === 'fulfilled') rows.push(...s.value)
    else errors.push(s.reason instanceof Error ? s.reason.message : String(s.reason))
  }

  const deduped = dedupeMax(rows)
  let inserted = 0
  if (deduped.length > 0) {
    const admin = createAdminClient()
    // 새 테이블은 generated types 에 없음 → as any (마이그레이션 후 상태 가정)
    const { data, error } = await (admin as any)
      .from('jimscanner_weather_forecast')
      .upsert(deduped, { onConflict: 'dedup_key', ignoreDuplicates: false })
      .select('id')
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    inserted = (data as unknown[] | null)?.length ?? 0
  }

  return NextResponse.json({
    ok: true,
    base_date: isoDate(baseDate),
    fetched: rows.length,
    upserted: inserted,
    errors,
    executed_at: new Date().toISOString(),
  })
}
