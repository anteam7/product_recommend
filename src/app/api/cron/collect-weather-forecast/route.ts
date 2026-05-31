/**
 * collect-weather-forecast — 기상청(KMA) 단기예보 수집 cron.
 *
 * 적재 대상:
 *  - jimscanner_weather_forecast (region × forecast_date upsert)
 *  - jimscanner_trends_runs      (감사 로그, source='weather_forecast')
 *
 * KMA 단기예보 getVilageFcst:
 *   https://apis.data.go.kr/1360000/VilageFcstInfoService_2.0/getVilageFcst
 *   serviceKey=KMA_SERVICE_KEY, 격자 nx/ny, base_date/base_time 필요.
 *   응답 category: TMN(최저)/TMX(최고)/POP(강수확률)/PCP(강수량).
 *
 * 이벤트 플래그 임계값: 폭염 TMX>=33 / 한파 TMN<=-12 / 강수 POP>=60 / 미세먼지 pm10>=81.
 * pm10/pm25 는 KMA 단기예보에 없으므로 본 cron 에선 비움(보조 소스에서 별도 백필).
 */
import { NextResponse, type NextRequest } from 'next/server'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import { isAuthorizedCron } from '@/lib/market-signals'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

const SOURCE = 'weather_forecast'

// 운영 지역 ↔ KMA 격자(nx, ny). 수도권 우선 (위탁 수요 중심).
const REGIONS: { region: string; label: string; nx: number; ny: number }[] = [
  { region: 'seoul', label: '서울', nx: 60, ny: 127 },
  { region: 'busan', label: '부산', nx: 98, ny: 76 },
  { region: 'daegu', label: '대구', nx: 89, ny: 90 },
]

type KmaItem = {
  fcstDate: string // 'YYYYMMDD'
  fcstTime: string // 'HHmm'
  category: string // 'TMN' | 'TMX' | 'POP' | 'PCP' ...
  fcstValue: string
}

/** 단기예보 발표시각(02,05,08,11,14,17,20,23시) 중 직전 것을 base 로 잡는다. */
function resolveBase(now: Date): { baseDate: string; baseTime: string } {
  const kst = new Date(now.getTime() + 9 * 3600 * 1000) // UTC→KST
  const hours = [23, 20, 17, 14, 11, 8, 5, 2]
  let h = hours.find((x) => kst.getUTCHours() >= x + 1) // 발표 후 ~10분 지연 → +1h 여유
  const d = new Date(kst)
  if (h === undefined) {
    // 새벽(02시 발표 전) → 전날 23시 발표 사용
    d.setUTCDate(d.getUTCDate() - 1)
    h = 23
  }
  const yyyy = d.getUTCFullYear()
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(d.getUTCDate()).padStart(2, '0')
  return { baseDate: `${yyyy}${mm}${dd}`, baseTime: `${String(h).padStart(2, '0')}00` }
}

function ymdToIso(ymd: string): string {
  return `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`
}

function pcpToMm(v: string): number {
  // KMA PCP: '강수없음' | '1.0mm 미만' | '30.0~50.0mm' | '50.0mm 이상' 등
  if (!v || v.includes('없음')) return 0
  const m = v.match(/[\d.]+/)
  return m ? Number(m[0]) : 0
}

async function fetchRegion(
  r: { region: string; label: string; nx: number; ny: number },
  base: { baseDate: string; baseTime: string },
  key: string,
): Promise<KmaItem[]> {
  const params = new URLSearchParams({
    serviceKey: key,
    dataType: 'JSON',
    numOfRows: '900',
    pageNo: '1',
    base_date: base.baseDate,
    base_time: base.baseTime,
    nx: String(r.nx),
    ny: String(r.ny),
  })
  const url = `https://apis.data.go.kr/1360000/VilageFcstInfoService_2.0/getVilageFcst?${params}`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`KMA ${r.region} HTTP ${res.status}`)
  const json: any = await res.json()
  const header = json?.response?.header
  if (header?.resultCode && header.resultCode !== '00')
    throw new Error(`KMA ${r.region} ${header.resultCode} ${header.resultMsg}`)
  return (json?.response?.body?.items?.item ?? []) as KmaItem[]
}

type DayAgg = {
  forecast_date: string
  temp_min: number | null
  temp_max: number | null
  precip_prob: number | null
  precip_mm: number
}

function aggregate(items: KmaItem[]): DayAgg[] {
  const byDate = new Map<string, DayAgg>()
  for (const it of items) {
    const iso = ymdToIso(it.fcstDate)
    let d = byDate.get(iso)
    if (!d) {
      d = { forecast_date: iso, temp_min: null, temp_max: null, precip_prob: null, precip_mm: 0 }
      byDate.set(iso, d)
    }
    const val = Number(it.fcstValue)
    switch (it.category) {
      case 'TMN':
        if (!Number.isNaN(val)) d.temp_min = d.temp_min === null ? val : Math.min(d.temp_min, val)
        break
      case 'TMX':
        if (!Number.isNaN(val)) d.temp_max = d.temp_max === null ? val : Math.max(d.temp_max, val)
        break
      case 'POP':
        if (!Number.isNaN(val)) d.precip_prob = d.precip_prob === null ? val : Math.max(d.precip_prob, val)
        break
      case 'PCP':
        d.precip_mm += pcpToMm(it.fcstValue)
        break
    }
  }
  return [...byDate.values()].sort((a, b) => a.forecast_date.localeCompare(b.forecast_date))
}

async function recordRun(opts: {
  status: 'ok' | 'partial' | 'error'
  fetched: number
  inserted: number
  durationMs: number
  errorMessage?: string
}) {
  const sb = createAdminClient() as any
  await sb.from('jimscanner_trends_runs').insert({
    source: SOURCE,
    status: opts.status,
    fetched_count: opts.fetched,
    inserted_count: opts.inserted,
    duration_ms: opts.durationMs,
    error_message: opts.errorMessage ?? null,
    triggered_by: 'cron',
    finished_at: new Date().toISOString(),
  })
}

export async function GET(request: NextRequest) {
  if (!isAuthorizedCron(request))
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const t0 = Date.now()
  const key = process.env.KMA_SERVICE_KEY
  if (!key) {
    await recordRun({ status: 'error', fetched: 0, inserted: 0, durationMs: 0, errorMessage: 'KMA_SERVICE_KEY 미설정' }).catch(() => {})
    return NextResponse.json({ ok: false, error: 'KMA_SERVICE_KEY 미설정' }, { status: 500 })
  }

  const base = resolveBase(new Date())
  const sb = createAdminClient() as any
  const collectedAt = new Date().toISOString()
  const errors: { region: string; reason: string }[] = []
  let fetched = 0
  const rows: any[] = []

  for (const r of REGIONS) {
    try {
      const items = await fetchRegion(r, base, key)
      fetched += items.length
      for (const day of aggregate(items)) {
        rows.push({
          region: r.region,
          region_label: r.label,
          forecast_date: day.forecast_date,
          temp_min: day.temp_min,
          temp_max: day.temp_max,
          precip_prob: day.precip_prob,
          precip_mm: day.precip_mm,
          pm10: null,
          pm25: null,
          is_heatwave: day.temp_max !== null && day.temp_max >= 33,
          is_coldwave: day.temp_min !== null && day.temp_min <= -12,
          is_rainy: day.precip_prob !== null && day.precip_prob >= 60,
          is_dusty: false,
          raw_payload: { base_date: base.baseDate, base_time: base.baseTime, nx: r.nx, ny: r.ny },
          collected_at: collectedAt,
        })
      }
    } catch (e) {
      errors.push({ region: r.region, reason: e instanceof Error ? e.message : String(e) })
    }
  }

  let inserted = 0
  if (rows.length > 0) {
    const { error } = await sb
      .from('jimscanner_weather_forecast')
      .upsert(rows, { onConflict: 'region,forecast_date' })
    if (error) {
      await recordRun({ status: 'error', fetched, inserted: 0, durationMs: Date.now() - t0, errorMessage: error.message }).catch(() => {})
      return NextResponse.json({ ok: false, error: error.message }, { status: 500 })
    }
    inserted = rows.length
  }

  const status = errors.length === 0 ? 'ok' : inserted > 0 ? 'partial' : 'error'
  await recordRun({ status, fetched, inserted, durationMs: Date.now() - t0, errorMessage: errors.length ? JSON.stringify(errors) : undefined })

  return NextResponse.json({
    ok: status !== 'error',
    base,
    regions: REGIONS.length,
    fetched,
    inserted,
    errors,
    executed_at: collectedAt,
  })
}
