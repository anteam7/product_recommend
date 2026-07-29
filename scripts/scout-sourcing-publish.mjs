/**
 * 마진검증 배치 JSON → jimscanner_scout_sourcing 테이블에 발행(/admin/sourcing 비교 페이지용).
 * 도매꾹 getItemView 로 실단가·재고·옵션·대표이미지 URL 확정, 쿠팡 이미지 URL 은 scout_products 에서.
 *   node scripts/scout-sourcing-publish.mjs data/scout/reports/202607250122-마진검증.json
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { createClient } from '@supabase/supabase-js'
import { commissionRate } from './lib/coupang-commission.mjs'
import { setQty, packCount } from './lib/set-qty.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.join(__dirname, '..')
const env = Object.fromEntries(
  readFileSync(path.join(REPO, '.env.local'), 'utf8').split(/\r?\n/).filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => { const i = l.indexOf('='); let v = l.slice(i + 1).trim(); if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1); return [l.slice(0, i).trim(), v] }),
)
const DKEY = env.DOMEGGOOK_API_KEY, DBASE = 'https://domeggook.com/ssl/api/'
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY)
const SRC = process.argv[2] || 'data/scout/reports/202607250122-마진검증.json'
const BULK = 30, BOX = 500, VAT = 1.1  // 판매수수료는 카테고리별(commissionRate). 로켓그로스 물류비는 c.logi.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let all
try { all = JSON.parse(readFileSync(path.join(REPO, SRC), 'utf8')) }
catch (e) { console.error(`소스 JSON 읽기 실패 (${SRC}): ${e.message}`); process.exit(1) }
if (!Array.isArray(all) || !all.length) { console.error(`소스 JSON 이 비었습니다: ${SRC}`); process.exit(1) }
const strong = all.filter((r) => !r.dome_oversea && r.margin > 0 && r.sim >= 60 && r.rate >= 20 && r.sell > 0)
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
const viewErrors = []
let n = 0, negative = 0
for (const c of strong) {
  n++
  let d = null
  try {
    const r = await fetch(`${DBASE}?ver=4.1&mode=getItemView&aid=${DKEY}&no=${c.dome_no}&om=json`)
    if (!r.ok) throw new Error(`HTTP ${r.status}`)     // 429/500 을 조용히 건너뛰면 후보가 소리없이 사라진다
    d = (JSON.parse(await r.text())?.domeggook) || null
    if (!d) throw new Error('응답에 domeggook 필드 없음')
  } catch (e) { viewErrors.push(`${c.dome_no} ${String(c.name).slice(0, 20)}: ${String(e.message).replaceAll(DKEY, '***')}`) }
  await sleep(280)
  if (!d) continue
  const viewUnit = parseInt(d.price?.dome) || 0
  const unit = viewUnit >= 100 ? viewUnit : c.dome_supply
  const deliFee = parseInt(d.deli?.dome?.fee) || parseInt(d.deli?.fee) || 0
  const inbound = Math.round(deliFee / BULK)
  const landed = unit + inbound
  // 매입수량 — 도매 공급가는 1개 단가라 "N개" 묶음 리스팅은 N배로 매입해야 한다.
  // 구버전 마진검증 JSON 에는 set_qty 가 없으므로 상품명에서 복원한다(규칙은 lib/set-qty.mjs 로 단일화).
  const qty = c.set_qty > 0 ? c.set_qty : setQty(c.name)
  const pack = c.pack_count > 0 ? c.pack_count : packCount(c.name)
  const cost = landed * qty
  const fee = commissionRate(c.name)                                            // 카테고리별 판매수수료
  const margin = Math.round(c.sell - cost - (c.sell * fee + c.logi) * VAT - BOX)   // 정상(물류비 포함)
  const rate = Math.round((margin / c.sell) * 100)
  const marginPromo = Math.round(c.sell - cost - (c.sell * fee) * VAT - BOX)   // 90일 프로모션(물류비 0)
  const ratePromo = Math.round((marginPromo / c.sell) * 100)
  if (margin <= 0) negative++            // 매입수량 반영으로 적자 전환된 건 — 화면에서 걸러지지만 건수는 알린다
  rows.push({
    commission: fee, margin_promo: marginPromo, rate_promo: ratePromo, set_qty: qty, pack_count: pack,
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

if (!rows.length) { console.error('발행할 행이 0건입니다 — 기존 스냅샷을 유지하고 중단합니다'); process.exit(1) }

// 재발행: 삽입 성공 후에 이전 스냅샷을 지운다.
// (먼저 지우면 삽입이 실패했을 때 테이블이 비어 페이지가 "후보 없음"이 된다 — 실제로 위험했던 순서)
const { data: prev, error: prevErr } = await sb.from('jimscanner_scout_sourcing').select('id')
if (prevErr) { console.error('기존 스냅샷 조회 실패:', prevErr.message); process.exit(1) }
const { error } = await sb.from('jimscanner_scout_sourcing').insert(rows)
if (error) { console.error('삽입 오류(기존 스냅샷 유지됨):', error.message); process.exit(1) }
const prevIds = (prev ?? []).map((r) => r.id)
for (let i = 0; i < prevIds.length; i += 100) {
  const { error: delErr } = await sb.from('jimscanner_scout_sourcing').delete().in('id', prevIds.slice(i, i + 100))
  if (delErr) { console.error('이전 스냅샷 삭제 실패 — 중복 표시 가능:', delErr.message); break }
}
if (viewErrors.length) console.log(`⚠ 도매꾹 상세조회 실패 ${viewErrors.length}건(발행에서 누락): ${viewErrors.slice(0, 3).join(' · ')}${viewErrors.length > 3 ? ' …' : ''}`)
const multi = rows.filter((r) => r.set_qty > 1).length
console.log(`발행 완료: ${rows.length}건 → jimscanner_scout_sourcing (batch ${batch}, 이전 ${prevIds.length}건 교체)`)
console.log(`  매입수량 ×N 상품 ${multi}건 반영 · 그 결과 적자 ${negative}건(화면에서 제외됨) · 흑자 ${rows.length - negative}건`)
