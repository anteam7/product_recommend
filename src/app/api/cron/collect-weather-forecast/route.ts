import { NextResponse, type NextRequest } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { isAuthorizedCron } from '@/lib/market-signals'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

// KMA 중기육상예보 (mid-term land forecast) → 3~10일 후 일 최저/최고/강수확률.
// 단기예보 (3일) 는 다른 endpoint. Phase 0 에선 중기로 lead-time 보드부터.
//
// 인증키 미설정 시 mock 데이터로 fallback (개발/preview 환경).
//
// 환경변수:
//   KMA_SERVICE_KEY    — 공공데이터포털 (data.go.kr) 발급 인증키
//   KMA_REG_ID_LAND    — 중기예보 지역 코드 (기본 '11B00000' = 서울/인천/경기)
//   KMA_REG_ID_TEMP    — 중기기온 지역 코드 (기본 '11B10101' = 서울)

const REG_ID_LAND_DEFAULT = '11B00000'
const REG_ID_TEMP_DEFAULT = '11B10101'

type ForecastRow = {
  region: string
  target_date: string
  lead_days: number
  temp_min: number | null
  temp_max: number | null
  temp_anomaly: number | null
  precipitation_mm: number | null
  precipitation_prob: number | null
  pm10: number | null
  pm25: number | null
  heat_wave: boolean
  cold_wave: boolean
  typhoon: boolean
  raw: Record<string, unknown>
  source: 'kma' | 'mock'
}

function toKstDate(offsetDays: number): string {
  const d = new Date(Date.now() + offsetDays * 86400_000)
  // KST yyyy-mm-dd
  const kst = new Date(d.getTime() + 9 * 3600_000)
  return kst.toISOString().slice(0, 10)
}

function fmtTmFc(now: Date): string {
  // KMA tmFc 포맷: yyyyMMddHHmm, 06시/18시만 발표
  const kst = new Date(now.getTime() + 9 * 3600_000)
  const h = kst.getUTCHours()
  const slot = h >= 18 ? 18 : 6
  const dateStr = kst.toISOString().slice(0, 10).replace(/-/g, '')
  return `${dateStr}${String(slot).padStart(2, '0')}00`
}

async function fetchKmaMidLandFcst(serviceKey: string, regId: string): Promise<any> {
  const url = new URL('https://apis.data.go.kr/1360000/MidFcstInfoService/getMidLandFcst')
  url.searchParams.set('serviceKey', serviceKey)
  url.searchParams.set('dataType', 'JSON')
  url.searchParams.set('pageNo', '1')
  url.searchParams.set('numOfRows', '10')
  url.searchParams.set('regId', regId)
  url.searchParams.set('tmFc', fmtTmFc(new Date()))
  const res = await fetch(url.toString())
  if (!res.ok) throw new Error(`KMA land ${res.status}`)
  return res.json()
}

async function fetchKmaMidTaFcst(serviceKey: string, regId: string): Promise<any> {
  const url = new URL('https://apis.data.go.kr/1360000/MidFcstInfoService/getMidTa')
  url.searchParams.set('serviceKey', serviceKey)
  url.searchParams.set('dataType', 'JSON')
  url.searchParams.set('pageNo', '1')
  url.searchParams.set('numOfRows', '10')
  url.searchParams.set('regId', regId)
  url.searchParams.set('tmFc', fmtTmFc(new Date()))
  const res = await fetch(url.toString())
  if (!res.ok) throw new Error(`KMA temp ${res.status}`)
  return res.json()
}

function mergeKma(landJson: any, tempJson: any, region: string): ForecastRow[] {
  // KMA 중기예보 itemList 는 단일 row 에 3일후~10일후 컬럼들이 박혀있음.
  //   land item: rnSt3Am, rnSt3Pm, ... rnSt10 (강수확률), wf3Am ...
  //   temp item: taMin3, taMax3, ... taMin10, taMax10
  const landItem = landJson?.response?.body?.items?.item?.[0] ?? {}
  const tempItem = tempJson?.response?.body?.items?.item?.[0] ?? {}

  const rows: ForecastRow[] = []
  for (let lead = 3; lead <= 10; lead++) {
    const target = toKstDate(lead)
    const rnAm = Number(landItem[`rnSt${lead}Am`] ?? landItem[`rnSt${lead}`] ?? NaN)
    const rnPm = Number(landItem[`rnSt${lead}Pm`] ?? NaN)
    const rnProb = Number.isFinite(rnAm) || Number.isFinite(rnPm)
      ? Math.max(Number.isFinite(rnAm) ? rnAm : 0, Number.isFinite(rnPm) ? rnPm : 0)
      : null
    const taMin = Number(tempItem[`taMin${lead}`] ?? NaN)
    const taMax = Number(tempItem[`taMax${lead}`] ?? NaN)
    rows.push({
      region,
      target_date: target,
      lead_days: lead,
      temp_min: Number.isFinite(taMin) ? taMin : null,
      temp_max: Number.isFinite(taMax) ? taMax : null,
      temp_anomaly: null,
      precipitation_mm: null,
      precipitation_prob: rnProb,
      pm10: null,
      pm25: null,
      heat_wave: Number.isFinite(taMax) ? taMax >= 33 : false,
      cold_wave: Number.isFinite(taMin) ? taMin <= -12 : false,
      typhoon: false,
      raw: { land: landItem, temp: tempItem },
      source: 'kma',
    })
  }
  return rows
}

function mockForecast(region: string): ForecastRow[] {
  // 키 없을 때 데모용 — 폭염 시나리오 (D+3 부터 33°C 상승)
  const rows: ForecastRow[] = []
  for (let lead = 3; lead <= 10; lead++) {
    const target = toKstDate(lead)
    const baseTemp = 28 + Math.min(lead - 3, 5)
    const tempMax = baseTemp + (lead === 5 ? 6 : lead === 6 ? 7 : 2)
    const tempMin = tempMax - 9
    rows.push({
      region,
      target_date: target,
      lead_days: lead,
      temp_min: tempMin,
      temp_max: tempMax,
      temp_anomaly: tempMax - 28,
      precipitation_mm: lead === 7 ? 15 : 0,
      precipitation_prob: lead === 7 ? 70 : 10,
      pm10: 35 + lead * 2,
      pm25: 18 + lead,
      heat_wave: tempMax >= 33,
      cold_wave: false,
      typhoon: false,
      raw: { mock: true },
      source: 'mock',
    })
  }
  return rows
}

export async function GET(request: NextRequest) {
  if (!isAuthorizedCron(request))
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key)
    return NextResponse.json({ error: 'supabase env missing' }, { status: 500 })

  const admin = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  const region = 'KR'
  const serviceKey = process.env.KMA_SERVICE_KEY
  const regLand = process.env.KMA_REG_ID_LAND ?? REG_ID_LAND_DEFAULT
  const regTemp = process.env.KMA_REG_ID_TEMP ?? REG_ID_TEMP_DEFAULT

  const startedAt = new Date()
  let rows: ForecastRow[]
  let mode: 'kma' | 'mock' = 'mock'
  let fetchError: string | null = null
  try {
    if (serviceKey) {
      const [land, temp] = await Promise.all([
        fetchKmaMidLandFcst(serviceKey, regLand),
        fetchKmaMidTaFcst(serviceKey, regTemp),
      ])
      rows = mergeKma(land, temp, region)
      mode = 'kma'
    } else {
      rows = mockForecast(region)
    }
  } catch (e) {
    fetchError = e instanceof Error ? e.message : String(e)
    rows = mockForecast(region)
  }

  const { data: inserted, error: insertError } = await admin
    .from('jimscanner_weather_forecast' as never)
    .insert(rows as never)
    .select('id')

  const status = insertError ? 'error' : fetchError ? 'partial' : 'ok'
  await admin
    .from('jimscanner_trends_runs')
    .insert({
      source: 'weather_forecast',
      status,
      fetched_count: rows.length,
      inserted_count: inserted?.length ?? 0,
      duration_ms: Date.now() - startedAt.getTime(),
      error_message: insertError?.message ?? fetchError,
      triggered_by: 'cron',
      finished_at: new Date().toISOString(),
    } as never)

  return NextResponse.json({
    ok: !insertError,
    mode,
    region,
    fetched: rows.length,
    inserted: inserted?.length ?? 0,
    fetchError,
    insertError: insertError?.message ?? null,
  })
}
