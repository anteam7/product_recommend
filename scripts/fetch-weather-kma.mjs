#!/usr/bin/env node
/**
 * KMA 단기예보 일일 적재 — jimscanner_weather_daily
 *
 * 사용:
 *   node --env-file=.env.local scripts/fetch-weather-kma.mjs
 *
 * 필요 환경변수:
 *   NEXT_PUBLIC_SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *   KMA_API_KEY        (data.go.kr 단기예보 인증키, urldecoded)
 *
 * KMA_API_KEY 가 없으면 실측 데이터 없이 종료 (cron 자체는 fail 하지 않음).
 *
 * 적재 정책:
 *   - 오늘 기준 D-0 ~ D+5 예보 (region=KR 단일, 서울 격자 60/127 사용)
 *   - 같은 (date, region, forecast=true) 는 UPSERT
 */

import { createClient } from '@supabase/supabase-js'

const SB_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const KMA_KEY = process.env.KMA_API_KEY

if (!SB_URL || !SB_KEY) {
  console.error('supabase env missing')
  process.exit(1)
}

const sb = createClient(SB_URL, SB_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
})

function kstDate(offsetDays = 0) {
  const now = new Date(Date.now() + offsetDays * 86400_000)
  const kst = new Date(now.getTime() + 9 * 3600_000)
  return kst.toISOString().slice(0, 10)
}

/**
 * KMA 단기예보 (getVilageFcst) 호출.
 * 격자: 서울 60/127. baseDate = 오늘 KST, baseTime = '0500' (05시 기준 발표).
 * 반환: Array<{date, tmin, tmax, humidity, precip}>
 */
async function fetchKmaVilageFcst() {
  if (!KMA_KEY) return []
  const base = kstDate()
  const baseDate = base.replace(/-/g, '')
  const baseTime = '0500'
  const url =
    `https://apis.data.go.kr/1360000/VilageFcstInfoService_2.0/getVilageFcst` +
    `?serviceKey=${encodeURIComponent(KMA_KEY)}` +
    `&pageNo=1&numOfRows=1000&dataType=JSON` +
    `&base_date=${baseDate}&base_time=${baseTime}` +
    `&nx=60&ny=127`

  const res = await fetch(url)
  if (!res.ok) {
    console.error(`KMA HTTP ${res.status}`)
    return []
  }
  const json = await res.json().catch(() => null)
  const items = json?.response?.body?.items?.item ?? []
  // category: TMN(최저), TMX(최고), TMP(시간기온), REH(습도), PCP(강수량), POP(강수확률)
  const byDate = new Map()
  for (const it of items) {
    const d = `${it.fcstDate.slice(0, 4)}-${it.fcstDate.slice(4, 6)}-${it.fcstDate.slice(6, 8)}`
    let v = byDate.get(d)
    if (!v) {
      v = { date: d, tmps: [], rehs: [], pcps: [], tmin: null, tmax: null }
      byDate.set(d, v)
    }
    const val = it.fcstValue
    if (it.category === 'TMN') v.tmin = parseFloat(val)
    else if (it.category === 'TMX') v.tmax = parseFloat(val)
    else if (it.category === 'TMP') v.tmps.push(parseFloat(val))
    else if (it.category === 'REH') v.rehs.push(parseFloat(val))
    else if (it.category === 'PCP') {
      const n = val === '강수없음' ? 0 : parseFloat(val) || 0
      v.pcps.push(n)
    }
  }

  function avg(arr) {
    if (!arr.length) return null
    return arr.reduce((a, b) => a + b, 0) / arr.length
  }
  function sum(arr) {
    if (!arr.length) return null
    return arr.reduce((a, b) => a + b, 0)
  }

  return [...byDate.values()].map((v) => {
    const tavg = avg(v.tmps)
    const humidity = avg(v.rehs)
    const precip = sum(v.pcps)
    // 체감온도 간이추정 (Wind chill 없이): tavg - 2*((100-humidity)/100*0.5) 같은 근사 대신
    // 그냥 tavg 사용 (Phase 0). humidity 높고 더우면 +1, 강수 있으면 -1 가벼운 보정.
    let feels = tavg
    if (feels != null && humidity != null && feels >= 25 && humidity >= 70) feels += 1
    if (feels != null && precip != null && precip >= 5) feels -= 1
    return {
      date: v.date,
      region: 'KR',
      tmin: v.tmin,
      tmax: v.tmax,
      tavg,
      humidity,
      precip,
      feels_like: feels,
      forecast: true,
      payload: { source: 'kma_vilage_fcst', nx: 60, ny: 127, baseDate, baseTime },
    }
  })
}

const t0 = Date.now()
const rows = await fetchKmaVilageFcst()
if (rows.length === 0) {
  console.log(`[weather] no rows (KMA_API_KEY missing or empty response) — skipping`)
  process.exit(0)
}

const { error } = await sb
  .from('jimscanner_weather_daily')
  .upsert(rows, { onConflict: 'date,region,forecast' })

if (error) {
  console.error(`[weather] upsert error: ${error.message}`)
  process.exit(1)
}

console.log(`[weather] upserted ${rows.length} rows in ${Date.now() - t0}ms`)
