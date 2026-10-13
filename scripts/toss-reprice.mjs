#!/usr/bin/env node
/**
 * 토스 등록 상품 가격을 쿠팡 판매가 기준으로 동기화 — 수수료 차이 보정(lib/toss-price.mjs) 포함.
 *   node scripts/toss-reprice.mjs --dry          # 변경 대상만 출력
 *   node scripts/toss-reprice.mjs                # 적용: originPrice(≥sale 유지) → salePrice 순으로 PUT, DB sale_price/origin_price 갱신
 *   node scripts/toss-reprice.mjs --ids=8561,8562  # 특정 토스 상품만
 *
 * 규칙: 목표가 = tossPriceFromCoupang(쿠팡 list_price_krw, source). MSP(쿠팡 msp_price_krw) 미만이면 MSP 로 올림(절대 하한).
 *       쿠팡 리스팅이 없거나 STOPPED/품절(auto_paused) 이면 건너뛰고 보고만(토스 숨김 여부는 사람이 판단).
 *       토스 쪽 REMOVED/RECAT_FAILED/FAILED 행·toss_item_id 없는 행은 제외. 변경 없으면 API 호출 안 함.
 * 2026-10-13 사용자 요청("토스 등록가에 수수료 차이 보정") — 그날 이전 등록분 일괄 적용용. 이후 쿠팡 가격이 바뀌면 다시 돌리면 된다(크론 미연결).
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createClient } from '@supabase/supabase-js'
import { tossSetSalePrice, tossSetOriginPrice } from './lib/toss-api.mjs'
import { tossPriceFromCoupang, tossPriceRatio } from './lib/toss-price.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const env = Object.fromEntries(readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8').split(/\r?\n/).filter((l) => l && !l.startsWith('#') && l.includes('=')).map((l) => { const i = l.indexOf('='); let v = l.slice(i + 1).trim(); if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1); return [l.slice(0, i).trim(), v] }))
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY)
const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.split('=').slice(1).join('=') : d }
const has = (k) => process.argv.includes(`--${k}`)
const DRY = has('dry')
const ONLY = new Set(arg('ids', '').split(',').map((s) => s.trim()).filter(Boolean).map(Number))
const EXCLUDED = new Set(['REMOVED', 'RECAT_FAILED', 'FAILED'])

async function fetchAll(build, orderCol = 'id') {
  const PAGE = 1000, out = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await build().order(orderCol, { ascending: true }).range(from, from + PAGE - 1)
    if (error) throw new Error(`DB 조회 실패: ${error.message}`)
    out.push(...(data ?? []))
    if ((data ?? []).length < PAGE) return out
  }
}

const toss = (await fetchAll(() => sb.from('jimscanner_toss_listings').select('id, toss_product_id, toss_item_id, coupang_seller_product_id, source, name, sale_price, origin_price, inspection_status')))
  .filter((t) => t.toss_product_id && t.toss_item_id && t.coupang_seller_product_id && !EXCLUDED.has(t.inspection_status) && (ONLY.size === 0 || ONLY.has(Number(t.toss_product_id))))
const spids = [...new Set(toss.map((t) => Number(t.coupang_seller_product_id)))]
const cps = []
for (let i = 0; i < spids.length; i += 200) { // .in() URL 길이 한계 회피
  const chunk = spids.slice(i, i + 200)
  cps.push(...await fetchAll(() => sb.from('jimscanner_coupang_listings').select('id, seller_product_id, source, status, auto_paused, list_price_krw, msp_price_krw').in('seller_product_id', chunk)))
}
const cpBy = new Map(cps.map((c) => [Number(c.seller_product_id), c]))

let changed = 0, same = 0, skipped = 0, failed = 0, dbFail = 0
const skips = []
for (const t of toss) {
  const c = cpBy.get(Number(t.coupang_seller_product_id))
  if (!c || !c.list_price_krw) { skipped++; skips.push(`${t.toss_product_id} 쿠팡 리스팅/가격 없음 (${(t.name || '').slice(0, 30)})`); continue }
  if (c.status !== 'APPROVED' || c.auto_paused) { skipped++; skips.push(`${t.toss_product_id} 쿠팡 ${c.status}${c.auto_paused ? '/품절' : ''} — 가격 동기화 보류 (${(t.name || '').slice(0, 30)})`); continue }
  const source = c.source || t.source
  let target = tossPriceFromCoupang(c.list_price_krw, source)
  if (c.msp_price_krw && target < c.msp_price_krw) target = c.msp_price_krw // 절대 하한
  if (target === t.sale_price) { same++; continue }
  const origin = Math.max(t.origin_price || 0, target)
  const line = `${t.toss_product_id} ${(t.name || '').slice(0, 28).padEnd(28)} ${String(t.sale_price).padStart(7)} → ${String(target).padStart(7)} (쿠팡 ${c.list_price_krw}, ×${tossPriceRatio(source).toFixed(4)}${c.msp_price_krw ? `, MSP ${c.msp_price_krw}` : ''})${origin !== t.origin_price ? ` origin ${t.origin_price}→${origin}` : ''}`
  if (DRY) { console.log('  ' + line); changed++; continue }
  // 정가(origin ≥ sale 제약) 먼저 → 판매가. 판매가 실패 시 정가를 되돌려 토스·DB 불일치를 막는다. 예외는 건별로 잡아 나머지를 계속 처리.
  try {
    const originChanged = origin !== t.origin_price
    if (originChanged) { const r = await tossSetOriginPrice(t.toss_product_id, t.toss_item_id, origin); if (!r.ok) { failed++; console.log(`  ✗ ${line} | origin 실패 ${JSON.stringify(r.error).slice(0, 100)}`); continue } }
    const r = await tossSetSalePrice(t.toss_product_id, t.toss_item_id, target)
    if (!r.ok) {
      failed++; console.log(`  ✗ ${line} | sale 실패 ${JSON.stringify(r.error).slice(0, 100)}`)
      if (originChanged && t.origin_price) { const back = await tossSetOriginPrice(t.toss_product_id, t.toss_item_id, t.origin_price); console.log(`    ↩ origin 되돌림 ${t.origin_price}: ${back.ok ? 'OK' : '실패 ' + JSON.stringify(back.error).slice(0, 80)}`) }
      continue
    }
    const { error } = await sb.from('jimscanner_toss_listings').update({ sale_price: target, origin_price: origin, msp_price_krw: c.msp_price_krw ?? null, updated_at: new Date().toISOString() }).eq('id', t.id)
    if (error) { dbFail++; console.log(`  ⚠ ${line} | 토스 반영됨, DB 갱신 실패: ${error.message} (다음 실행에서 '변경'으로 다시 잡히지만 API 는 같은 값이라 무해)`) }
    else console.log('  ✓ ' + line)
    changed++
  } catch (e) { failed++; console.log(`  ✗ ${line} | 예외 ${String(e.message).slice(0, 120)}`) }
}
console.log(`\n${DRY ? '[DRY] ' : ''}대상 ${toss.length}건: 변경 ${changed} · 동일 ${same} · 보류 ${skipped} · 실패 ${failed}${dbFail ? ` · DB갱신실패 ${dbFail}` : ''}`)
for (const s of skips) console.log('  - ' + s)
