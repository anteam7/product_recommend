#!/usr/bin/env node
/**
 * KMA(기상청) 단·중기 예보 수집 → jimscanner_weather_forecast 적재.
 *
 * 무료 API: data.kma.go.kr (인증키: KMA_SERVICE_KEY)
 *   - 단기예보(VilageFcst): 향후 3일, 1시간 단위
 *   - 중기예보(MidFcst):   3~10일, 일 단위
 *
 * 환경변수:
 *   KMA_SERVICE_KEY                  — data.kma.go.kr 발급키 (필수)
 *   WEATHER_REGION_GRID_NX           — 단기예보 격자 X (서울=60)
 *   WEATHER_REGION_GRID_NY           — 단기예보 격자 Y (서울=127)
 *   WEATHER_REGION_MID_LAND          — 중기 육상 코드 (서울=11B00000)
 *   WEATHER_REGION_MID_TEMP          — 중기 기온 코드 (서울=11B10101)
 *   WEATHER_REGION_NAME              — 표시명 (기본 '서울')
 *
 * 사용법:
 *   node --env-file=.env.local scripts/collect-weather-forecast.mjs
 *
 * 임계치(active_tags 산출):
 *   heat:     tmax >= 33      (폭염주의보 기준)
 *   cool:     tmax <= 26 & doy 6~9   (시원함 — 더위 제품 비수기 진입)
 *   cold:     tmin <= 0       (한파)
 *   rain:     rain_prob >= 60
 *   dust:     pm10 == 'bad' or 'very_bad'
 *   uv:       uv >= 7
 *   humidity: humidity >= 80
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { createClient } from '@supabase/supabase-js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

function loadEnvLocal() {
  try {
    return Object.fromEntries(
      readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8')
        .split(/\r?\n/)
        .filter((l) => l && !l.startsWith('#') && l.includes('='))
        .map((l) => {
          const i = l.indexOf('=')
          let v = l.slice(i + 1).trim()
          if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
          return [l.slice(0, i).trim(), v]
        }),
    )
  } catch {
    return {}
  }
}

const env = { ...loadEnvLocal(), ...process.env }
const SUPABASE_URL = env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_SERVICE = env.SUPABASE_SERVICE_ROLE_KEY
const KMA_KEY = env.KMA_SERVICE_KEY

if (!SUPABASE_URL || !SUPABASE_SERVICE) {
  console.error('NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing')
  process.exit(1)
}

const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE)

const REGION_NAME = env.WEATHER_REGION_NAME ?? '서울'
const REGION_CODE = env.WEATHER_REGION_MID_TEMP ?? '11B10101'

function kstNow() {
  const utc = new Date()
  return new Date(utc.getTime() + 9 * 3600 * 1000)
}

function fmtDate(d) {
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function computeTags(d) {
  const tags = []
  if (typeof d.tmax === 'number' && d.tmax >= 33) tags.push('heat')
  if (typeof d.tmin === 'number' && d.tmin <= 0) tags.push('cold')
  if (typeof d.rain_prob === 'number' && d.rain_prob >= 60) tags.push('rain')
  if (d.pm10 === 'bad' || d.pm10 === 'very_bad') tags.push('dust')
  if (typeof d.uv === 'number' && d.uv >= 7) tags.push('uv')
  if (typeof d.humidity === 'number' && d.humidity >= 80) tags.push('humidity')
  return tags
}

async function fetchKmaForecast() {
  // 실제 KMA API 호출. 키 미발급 상태에선 합리적 stub 데이터 생성하여 파이프라인을 가동 가능 상태로 유지.
  if (!KMA_KEY) {
    console.warn('KMA_SERVICE_KEY 없음 — stub 데이터로 폴백 (개발/CI 환경).')
    const today = kstNow()
    const daily = []
    for (let i = 0; i < 10; i++) {
      const d = new Date(today.getTime() + i * 86400000)
      const month = d.getUTCMonth() + 1
      const isSummer = month >= 6 && month <= 9
      const isWinter = month <= 2 || month === 12
      const baseHigh = isSummer ? 30 : isWinter ? 5 : 22
      const baseLow = isSummer ? 23 : isWinter ? -3 : 13
      const day = {
        date: fmtDate(d),
        tmax: baseHigh + Math.round((Math.sin(i) * 4)),
        tmin: baseLow + Math.round((Math.cos(i) * 3)),
        rain_prob: [10, 20, 30, 40, 50, 70][i % 6],
        pm10: ['normal', 'normal', 'bad', 'normal', 'very_bad', 'normal'][i % 6],
        uv: [3, 5, 6, 8, 9, 4][i % 6],
        humidity: 50 + ((i * 7) % 45),
      }
      day.alert_tags = computeTags(day)
      daily.push(day)
    }
    return { daily, raw: { stub: true, reason: 'KMA_SERVICE_KEY missing' } }
  }
  // TODO: 실제 KMA fetch (data.kma.go.kr/api/yna/getMidLandFcst, getMidTa, getVilageFcst).
  // KMA 응답을 일별로 머지하여 daily 배열 구성. (실 키 발급 후 구현)
  throw new Error('KMA real-fetch path not yet wired — supply stub or implement KMA endpoints.')
}

async function main() {
  const t0 = Date.now()
  const { daily, raw } = await fetchKmaForecast()
  const activeTags = Array.from(new Set(daily.flatMap((d) => d.alert_tags ?? [])))

  const { error } = await sb.from('jimscanner_weather_forecast').insert({
    region_code: REGION_CODE,
    region_name: REGION_NAME,
    forecast_base_at: new Date().toISOString(),
    daily,
    active_tags: activeTags,
    raw_payload: raw,
  })

  if (error) {
    console.error('insert error:', error.message)
    process.exit(1)
  }
  console.log(
    `[weather] inserted forecast (region=${REGION_NAME}, days=${daily.length}, tags=${activeTags.join(',') || 'none'}) in ${Date.now() - t0}ms`,
  )
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
