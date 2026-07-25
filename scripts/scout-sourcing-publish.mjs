/**
 * 마진검증 배치 JSON → jimscanner_scout_sourcing 테이블에 발행(/admin/sourcing 비교 페이지용).
 * 도매꾹 getItemView 로 실단가·재고·옵션·대표이미지 URL 확정, 쿠팡 이미지 URL 은 scout_products 에서.
 *   node scripts/scout-sourcing-publish.mjs data/scout/reports/202607250122-마진검증.json
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { createClient } from '@supabase/supabase-js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.join(__dirname, '..')
const env = Object.fromEntries(
  readFileSync(path.join(REPO, '.env.local'), 'utf8').split(/\r?\n/).filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => { const i = l.indexOf('='); let v = l.slice(i + 1).trim(); if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1); return [l.slice(0, i).trim(), v] }),
)
const DKEY = env.DOMEGGOOK_API_KEY, DBASE = 'https://domeggook.com/ssl/api/'
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY)
const SRC = process.argv[2] || 'data/scout/reports/202607250122-마진검증.json'
const BULK = 30, COMMISSION = 0.108, BOX = 500, VAT = 1.1
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const all = JSON.parse(readFileSync(path.join(REPO, SRC), 'utf8'))
const strong = all.filter((r) => !r.dome_oversea && r.margin > 0 && r.sim >= 60 && r.rate >= 20)
console.log('발행 대상', strong.length, '건')

// 쿠팡 이미지 URL
const ids = strong.map((r) => r.product_id)
const cImg = {}
for (let i = 0; i < ids.length; i += 50) {
  const { data } = await sb.from('jimscanner_scout_products').select('product_id,image_url').in('product_id', ids.slice(i, i + 50))
  for (const r of (data || [])) if (!cImg[r.product_id] && r.image_url) cImg[r.product_id] = r.image_url
}

const batch = new Date().toISOString().slice(0, 10)
const rows = []
let n = 0
for (const c of strong) {
  n++
  let d = null
  try { const r = await fetch(`${DBASE}?ver=4.1&mode=getItemView&aid=${DKEY}&no=${c.dome_no}&om=json`); d = (JSON.parse(await r.text())?.domeggook) || null } catch { /* skip */ }
  await sleep(280)
  if (!d) continue
  const viewUnit = parseInt(d.price?.dome) || 0
  const unit = viewUnit >= 100 ? viewUnit : c.dome_supply
  const deliFee = parseInt(d.deli?.dome?.fee) || parseInt(d.deli?.fee) || 0
  const inbound = Math.round(deliFee / BULK)
  const landed = unit + inbound
  const margin = Math.round(c.sell - landed - (c.sell * COMMISSION + c.logi) * VAT - BOX)
  const rate = Math.round((margin / c.sell) * 100)
  rows.push({
    product_id: c.product_id, name: c.name, coupang_url: c.coupang_url, coupang_image: cImg[c.product_id] || null,
    dome_no: String(c.dome_no), dome_url: c.dome_url, dome_title: (d.basis?.title || '').slice(0, 80),
    dome_image: d.thumb?.original || d.thumb?.large || null,
    sell: c.sell, unit, inbound, landed, margin, rate,
    moq: parseInt(d.qty?.domeMoq) || c.dome_moq || 1, inventory: parseInt(d.qty?.inventory) || null,
    send_avg: d.deli?.sendAvg ? String(d.deli.sendAvg) : null,
    has_option: !!(d.selectOpt && Object.keys(d.selectOpt).length), tax: d.basis?.tax || null,
    sim: c.sim, review_count: c.review_count, batch,
  })
  if (n % 10 === 0) console.log(`  ${n}/${strong.length}...`)
}
rows.sort((a, b) => b.margin - a.margin).forEach((r, i) => { r.rank = i + 1 })

// 재발행: 이전 스냅샷 비우고 삽입(단일 최신 스냅샷 유지)
await sb.from('jimscanner_scout_sourcing').delete().neq('id', '00000000-0000-0000-0000-000000000000')
const { error } = await sb.from('jimscanner_scout_sourcing').insert(rows)
if (error) { console.error('삽입 오류:', error.message); process.exit(1) }
console.log(`발행 완료: ${rows.length}건 → jimscanner_scout_sourcing (batch ${batch})`)
