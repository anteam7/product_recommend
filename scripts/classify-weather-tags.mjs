#!/usr/bin/env node
/**
 * jimscanner_ggsan_products / jimscanner_trends_products 의 title 을 기반으로
 * weather_tags jsonb 컬럼을 채우는 룰 기반 분류기.
 *
 * 태그 차원: cool, heat, rain, dust, uv, humidity
 * 출력 형태: { cool: 0.9, heat: 0.0, rain: 0.3, ... } — 0~1 confidence
 *
 * 룰: 키워드 사전 매칭(앵커 단어 + 보조 단어).
 * LLM 보강은 추후 — 우선 룰로 80% 커버하고 V1 에서 LLM 합류.
 *
 * 사용법:
 *   node --env-file=.env.local scripts/classify-weather-tags.mjs
 *   node --env-file=.env.local scripts/classify-weather-tags.mjs --table=trends
 *   node --env-file=.env.local scripts/classify-weather-tags.mjs --force   # 기존 tag 덮어쓰기
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
if (!SUPABASE_URL || !SUPABASE_SERVICE) {
  console.error('NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing')
  process.exit(1)
}

const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE)

const args = process.argv.slice(2)
const force = args.includes('--force')
const tableArg = args.find((a) => a.startsWith('--table='))?.split('=')[1] ?? 'ggsan'

// 키워드 사전. 각 항목: [정규식 패턴, 점수 가중치]
const DICT = {
  cool: [
    [/쿨매트|쿨러|아이스조끼|쿨토시|쿨시트|얼음방석|얼음조끼|선풍기|에어컨|아이스팩|냉감|쿨링|쿨감/i, 0.95],
    [/얼음|시원/i, 0.4],
  ],
  heat: [
    [/발열조끼|발열패드|발열장갑|핫팩|온열매트|난방텐트|온수매트|전기장판|전기히터|히터|난로/i, 0.95],
    [/온풍|보온|방한/i, 0.6],
  ],
  rain: [
    [/우산|우비|장화|레인부츠|레인코트|방수가방|방수재킷|비옷|레인커버/i, 0.95],
    [/방수/i, 0.5],
  ],
  dust: [
    [/마스크|황사마스크|kf94|kf80|공기청정기|미세먼지/i, 0.9],
    [/필터|정화/i, 0.4],
  ],
  uv: [
    [/자외선|썬크림|선크림|선스틱|선블록|자외선차단|UV차단|모자|양산|아쿠아슈즈/i, 0.9],
    [/SPF|PA\+|자외선/i, 0.7],
  ],
  humidity: [
    [/제습기|제습제|건조기|곰팡이|습기제거/i, 0.95],
    [/가습기/i, 0.6],
  ],
}

function classifyTitle(title) {
  if (!title) return null
  const tags = { cool: 0, heat: 0, rain: 0, dust: 0, uv: 0, humidity: 0 }
  let any = false
  for (const [tag, rules] of Object.entries(DICT)) {
    let best = 0
    for (const [re, w] of rules) {
      if (re.test(title)) {
        if (w > best) best = w
      }
    }
    if (best > 0) {
      tags[tag] = best
      any = true
    }
  }
  return any ? tags : null
}

async function classifyTable(tableName, idCol) {
  let query = sb.from(tableName).select(`${idCol}, title, weather_tags`).limit(2000)
  if (!force) query = query.is('weather_tags', null)
  const { data, error } = await query
  if (error) {
    console.error(`[${tableName}] select error:`, error.message)
    return { updated: 0, skipped: 0 }
  }
  let updated = 0
  let skipped = 0
  for (const r of data ?? []) {
    const tags = classifyTitle(r.title)
    if (!tags) {
      skipped++
      continue
    }
    const { error: uerr } = await sb
      .from(tableName)
      .update({ weather_tags: tags })
      .eq(idCol, r[idCol])
    if (uerr) {
      console.warn(`[${tableName}] update ${r[idCol]} failed: ${uerr.message}`)
    } else {
      updated++
    }
  }
  return { updated, skipped }
}

async function main() {
  const t0 = Date.now()
  const tables =
    tableArg === 'trends'
      ? [{ name: 'jimscanner_trends_products', id: 'id' }]
      : tableArg === 'both'
      ? [
          { name: 'jimscanner_ggsan_products', id: 'goods_no' },
          { name: 'jimscanner_trends_products', id: 'id' },
        ]
      : [{ name: 'jimscanner_ggsan_products', id: 'goods_no' }]

  for (const t of tables) {
    const { updated, skipped } = await classifyTable(t.name, t.id)
    console.log(`[${t.name}] updated=${updated} skipped(no-match)=${skipped}`)
  }
  console.log(`done in ${Date.now() - t0}ms`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
