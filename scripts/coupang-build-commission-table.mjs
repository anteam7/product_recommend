/**
 * 쿠팡 카테고리별 판매수수료 표 구축 — 카테고리 트리를 크롤해 jimscanner_coupang_category_commission 적재.
 *   node scripts/coupang-build-commission-table.mjs [--root=59258] [--dry] [--reuse]
 *
 * 왜 필요한가: 수수료율이 마진 계산의 가장 큰 변수인데, 쿠팡 OpenAPI 에는 카테고리별 수수료 조회가 없다.
 * 사용자 제공 수수료표(scripts/lib/coupang-commission.mjs, 2026-07)는 대분류 이름 기준이라
 * 실제 등록에 쓰이는 말단 카테고리(루테인·건강분말 등)와 연결되지 않는다(128건 중 95건이 기본값으로 빠졌다).
 * → 카테고리 트리에서 전체 경로를 받아 "경로 기준"으로 수수료를 결정한다.
 *
 * 규칙 (사용자 확정 2026-09-18)
 *   식품 > 건강식품 > 건강식품 > *  → 0.076 (영양제·비타민/미네랄)
 *   그 외 식품 하위                → 0.106 (전통건강식품·환/분말·가루/조미료·다이어트식품·신선식품·차류)
 *
 * 트리 API: GET /meta/display-categories/{code} → { name, child[] }. 부모는 안 주므로 루트에서 내려가며 경로를 만든다.
 * 레이트리밋이 있어 순차 + 120ms 간격 + 3회 재시도로 돈다(식품 전체 1,527개 ≈ 4분).
 */
import crypto from 'node:crypto'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { createClient } from '@supabase/supabase-js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const env = Object.fromEntries(readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8').split(/\r?\n/).filter(l => l && !l.startsWith('#') && l.includes('=')).map(l => { const i = l.indexOf('='); let v = l.slice(i + 1).trim(); if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1); return [l.slice(0, i).trim(), v] }))
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY)
const { COUPANG_ACCESS_KEY: AK, COUPANG_SECRET_KEY: SK, COUPANG_API_HOST: HOST } = env

const args = process.argv.slice(2)
const argOf = k => args.find(a => a.startsWith(`--${k}=`))?.split('=')[1]
const ROOT = +(argOf('root') || 59258)      // 59258 = 식품
const DRY = args.includes('--dry')
const REUSE = args.includes('--reuse')      // 이미 받아둔 _tmp_coupang_food_tree.json 재사용
const CACHE = path.join(__dirname, '..', '_tmp_coupang_food_tree.json')
const BASE = '/v2/providers/seller_api/apis/api/v1/marketplace/meta/display-categories'
const sleep = ms => new Promise(s => setTimeout(s, ms))

/** 경로 → 수수료율. 규칙을 한 곳에 모아둔다. */
export function rateForPath(p) {
  if (!Array.isArray(p) || p[0] !== '식품') return null
  if (p[1] === '건강식품' && p[2] === '건강식품') return 0.076
  return 0.106
}

async function api(p, tries = 3) {
  for (let i = 0; i < tries; i++) {
    const dt = new Date().toISOString().substring(2, 19).replace(/[-:]/g, '') + 'Z'
    const sig = crypto.createHmac('sha256', SK).update(dt + 'GET' + p).digest('hex')
    const r = await fetch(HOST + p, { headers: { Authorization: `CEA algorithm=HmacSHA256, access-key=${AK}, signed-date=${dt}, signature=${sig}`, 'Content-Type': 'application/json;charset=UTF-8' } })
    if (r.ok) return (await r.json())?.data
    await sleep(800 * (i + 1))
  }
  return null
}

async function crawl() {
  const paths = {}
  const queue = [[ROOT, []]]
  let calls = 0, fails = 0
  while (queue.length) {
    const [code, parent] = queue.shift()
    const d = await api(`${BASE}/${code}`); calls++
    if (!d) { fails++; continue }
    const here = [...parent, d.name]
    paths[code] = here
    for (const c of (d.child ?? [])) queue.push([c.displayItemCategoryCode, here])
    if (calls % 100 === 0) console.log(`  …${calls}회 · 수집 ${Object.keys(paths).length} · 대기 ${queue.length}`)
    await sleep(120)
  }
  console.log(`크롤 완료: ${Object.keys(paths).length}개 (호출 ${calls} · 실패 ${fails})`)
  writeFileSync(CACHE, JSON.stringify(paths), 'utf8')
  return paths
}

const paths = (REUSE && existsSync(CACHE)) ? JSON.parse(readFileSync(CACHE, 'utf8')) : await crawl()
const rows = []
for (const [code, p] of Object.entries(paths)) {
  const rate = rateForPath(p)
  if (rate == null) continue
  rows.push({ display_category_code: +code, name: p[p.length - 1], path: p.join(' > '), branch: p.slice(0, 3).join(' > '), rate })
}
const dist = rows.reduce((m, r) => { m[r.rate] = (m[r.rate] ?? 0) + 1; return m }, {})
console.log(`적재 대상 ${rows.length}건 · 수수료 분포: ${Object.entries(dist).map(([k, v]) => `${(+k * 100).toFixed(1)}% ${v}건`).join(' · ')}`)
if (DRY) { console.log('[dry] 적재 생략'); process.exit(0) }
for (let i = 0; i < rows.length; i += 500) {
  const { error } = await sb.from('jimscanner_coupang_category_commission').upsert(rows.slice(i, i + 500), { onConflict: 'display_category_code' })
  if (error) { console.error('upsert 실패:', error.message); process.exit(1) }
}
console.log(`✓ jimscanner_coupang_category_commission 적재 완료 (${rows.length}건)`)
