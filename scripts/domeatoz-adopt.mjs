#!/usr/bin/env node
/**
 * 도매아토즈 다른 공급사 상품을 골라서 받아오기 — OPEN API /productInfo(상품별) → jimscanner_domeatoz_products upsert. (2026-11-06)
 *   node scripts/domeatoz-adopt.mjs --idx=781474,1301941 [--cat=3084022:80393,1754410:79402] [--dry]
 *
 * 왜: 전체 공급사 쿠팡 가격 비교(파트너스 대기열, scripts/partners-price-queue.mjs)에서 "가능"으로 걸러진 상품만 등록한다(사장님 2026-11-05).
 *     공급사 하나가 3천~9천 개라 수집기(domeatoz-collect.mjs — 공급사 전체 목록·상품DB)로 받지 않고, 고른 상품만 API 로 받는다.
 *  - 받은 행은 auto_excluded_reason=null 이라 드립(domeatoz-register.mjs --no-market)이 일반 상품 경로로 등록한다.
 *  - 받지 않는 상품(사유 출력, DB 기록 없음): 판매중 아님 · 해외배송 · 의료기기/건강기능식품 · 성인 · 판매가 준수(MSP — 등록기가 하한을 모름) ·
 *    착불/화물 배송 · KC 인증 의심(전기·배터리·충전·조명 등 — 인증 번호 입력 미지원) · 어린이제품(KC) · 판매 옵션 10개 초과(사장님 2026-11-06) · 옵션 전부 품절.
 *  - 상세 이미지: 상품설명 HTML 의 <img> 중 공급사 공통 배너(/common/)·배송/교환/안내 배너(파일명)·빈 줄(높이 100px 미만)을 빼고,
 *    http 는 https 로 바꿔 열리는 것만(쿠팡 상세는 https 라 http 이미지는 안 보인다). 2026-11-06 실측: 공급사 자체 배송·반품 정책 배너가 섞여 있음.
 *  - 쿠팡 카테고리: 도매아토즈가 주는 cupangCode, --cat=idx:코드 로 바꿀 수 있다(예: 패딩조끼 79403 '여성 바람막이 점퍼' → 79402 '여성 패딩/다운패딩조끼').
 *  - 재고: local-cron-stock-sync.mjs 가 대상이 적은 공급사는 /productInfo 상품별로 확인한다(공급사 목록 전체를 훑지 않음).
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import sharp from 'sharp'
import { createClient } from '@supabase/supabase-js'
import { createDomeatozApi, domeatozLiveOptions } from './lib/domeatoz-api.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const env = Object.fromEntries(readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8').split(/\r?\n/).filter((l) => l && !l.startsWith('#') && l.includes('=')).map((l) => { const i = l.indexOf('='); let v = l.slice(i + 1).trim(); if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1); return [l.slice(0, i).trim(), v] }))
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY)
const api = createDomeatozApi(env)
const TABLE = 'jimscanner_domeatoz_products'
const MAX_OPTIONS = 10 // domeatoz-register.mjs MAX_OPTIONS 와 같은 값

const argv = process.argv.slice(2)
const arg = (k) => argv.find((a) => a.startsWith(`--${k}=`))?.split('=').slice(1).join('=')
const DRY = argv.includes('--dry')
const IDS = [...new Set((arg('idx') || '').split(',').map((s) => s.trim()).filter(Boolean))]
if (!IDS.length || IDS.some((s) => !/^\d{1,9}$/.test(s))) { console.error('사용법: --idx=781474,1301941 [--cat=idx:쿠팡카테고리,…] [--dry]'); process.exit(64) }
const CAT = Object.fromEntries((arg('cat') || '').split(',').filter(Boolean).map((p) => p.split(':').map((s) => s.trim())))
for (const [k, v] of Object.entries(CAT)) if (!/^\d+$/.test(k) || !/^\d+$/.test(v ?? '')) { console.error(`--cat 형식 오류: ${k}:${v}`); process.exit(64) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// KC 인증 의심 — 전기·전자·배터리·조명 등. 쿠팡 인증 번호 입력을 지원하지 않으므로 받지 않는다(campingmoon kc_suspect 와 같은 취지)
const KC_SUSPECT = /배터리|밧데리|건전지|충전|전동|전기|전자|LED|램프|조명|어댑터|아답터|히터|난로|온열|모터|로봇|선풍기|가습기|제습기|드라이어|블루투스|무선|이어폰|스피커|청소기|전열|멀티탭|콘센트/i
const KIDS = /유아|아동|키즈|어린이|베이비|신생아|출산|완구|장난감/
const FOOD_EXCLUDE = /아이스|냉동|냉장|소주|맥주|막걸리|와인|위스키|주류|분유|홍삼|유산균|오메가|비타민|건강식품|다이어트/
// 상세에서 뺄 배너 파일명(공급사 배송·교환·반품·공지·인트로 안내)
const BANNER_FILE = /deliv|배송|info|intro|notice|공지|imgend|end_\d|banner|qna|openchat|kakao|return|exchange|교환|반품|guide|안내|event|footer|header|top_img|bottom/i

function skipReason(d) {
  const name = String(d.productName || ''), groups = [d.categoryGroup_1, d.categoryGroup_2, d.categoryGroup_3, d.categoryGroup_4].filter(Boolean).join(' ')
  if (Number(d.productState) !== 1) return `판매중 아님(상태 ${d.productState})`
  if (d.overseas === 'Y') return '해외배송'
  if (/[MH]/.test(d.productAttr || '')) return `판매허가 상품(${d.productAttr === 'M' ? '의료기기' : '건강기능식품'})`
  if (d.adultType === 'Y' || d.minorType === 'N') return '성인용품'
  if (d.priceType === 'Y') return `판매가 준수(MSP ${d.consumerPrice}) — 등록기 하한 미지원`
  if (d.deliveryType !== '배송비선불' || d.deliveryMethod !== '택배') return `배송 ${d.deliveryType}/${d.deliveryMethod}`
  if (!(Number(d.price) > 0)) return '도매가 없음'
  if (KC_SUSPECT.test(`${name} ${groups}`)) return 'KC 인증 의심(전기·배터리·조명 등)'
  if (KIDS.test(`${name} ${groups}`)) return '어린이제품(KC)'
  if (d.categoryGroup_1 === '식품' && FOOD_EXCLUDE.test(`${name} ${groups}`)) return '식품 제외 품목(냉동·주류·건강식품 등)'
  const hasOpt = Number(d.arOption?.optionType || 0) > 0, live = domeatozLiveOptions(d).length
  if (hasOpt && !live) return '옵션 전부 품절'
  if (live > MAX_OPTIONS) return `옵션 많음(판매 옵션 ${live}개 > ${MAX_OPTIONS})`
  return null
}

/** 상품설명 HTML → 상세 이미지(배너·빈 줄 제외, https 로 열리는 것만) */
async function detailImages(html) {
  const urls = [...String(html || '').matchAll(/<img[^>]+src=['"]?([^'" >]+)/gi)].map((m) => m[1].trim())
  const out = []
  for (const raw of [...new Set(urls)].slice(0, 20)) {
    let u
    try { u = new URL(raw.replace(/^\/\//, 'https://')) } catch { continue }
    const last = u.pathname.split('/').pop() || ''
    let file = last
    try { file = decodeURIComponent(last) } catch { /* 깨진 %인코딩 — 원문으로 판정 */ }
    if (/\/common\//i.test(u.pathname) || BANNER_FILE.test(file)) { console.log(`    - 배너 제외 ${u.href}`); continue }
    u.protocol = 'https:'
    if (u.port === '80') u.port = ''
    try {
      const r = await fetch(u.href, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(20000) })
      if (r.status !== 200 || !/image\//.test(r.headers.get('content-type') || '')) { console.log(`    - https 로 안 열림(${r.status}) ${u.href}`); continue }
      const m = await sharp(Buffer.from(await r.arrayBuffer())).metadata()
      if ((m.height ?? 0) < 100 || (m.width ?? 0) < 300) { console.log(`    - 빈 줄/작은 이미지 제외 ${m.width}x${m.height} ${u.href}`); continue }
      out.push(u.href)
    } catch (e) { console.log(`    - 이미지 확인 실패 ${u.href} (${e.message})`) }
    if (out.length >= 10) break
  }
  return out
}

const cleanName = (s) => String(s || '').replace(/^\s*[([][^)\]]{1,20}[)\]]\s*/, '').replace(/\s+/g, ' ').trim()

let adopted = 0, skipped = 0, failed = 0
for (const id of IDS) {
  let d
  try { d = await api.productInfo(id) } catch (e) { failed++; console.log(`✗ ${id} 조회 실패: ${e.message}`); await sleep(2000); continue }
  const why = skipReason(d)
  if (why) { skipped++; console.log(`⏭ ${id} [${d.companyCode}] ${d.productName} — ${why}`); await sleep(2000); continue }
  console.log(`· ${id} [${d.companyCode}] ${d.productName}`)
  const imgs = await detailImages(d.contents)
  const hasOpt = Number(d.arOption?.optionType || 0) > 0
  const cupang = CAT[id] ?? (/^\d+$/.test(String(d.cupangCode || '')) ? String(d.cupangCode) : null)
  const now = new Date().toISOString()
  const row = {
    idx: String(d.idx), product_code: d.productCode, supplier_code: d.companyCode, supplier_name: null,
    name_raw: d.productName, name_clean: cleanName(d.productName), category_code: d.categoryCode,
    group_1: d.categoryGroup_1 || null, group_2: d.categoryGroup_2 || null, group_3: d.categoryGroup_3 || null, group_4: d.categoryGroup_4 || null,
    wholesale_price: Number(d.price), consumer_price: Number(d.consumerPrice) || 0, delivery_price: Number(d.deliveryPrice) || 0, delivery_type: d.deliveryType,
    jeju_extra: Number(d.jejuDeliveryPrice) || null, island_extra: Number(d.islandsDeliveryPrice) || null, bundle_qty: Number(d.bundledDeliveryCount) || null,
    product_state: Number(d.productState), soldout: false, status: 'active',
    option_type: hasOpt ? 'Y' : 'N', options: hasOpt ? d.arOption : null, tax_type: d.taxType === 'N' ? '면세' : '과세',
    ship_area: d.deliveryArea ?? null, returnable: d.returnType ?? null, origin: d.made || null, maker: d.manufacture || null,
    model_name: d.modelName && !/^null$/i.test(d.modelName) ? d.modelName : null, minor_ok: d.minorType === 'Y', overseas: d.overseas || null,
    keywords: String(d.keyword || '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 30),
    notice: { code: d.noticeCategoryCode ?? null, items: Array.from({ length: 18 }, (_, i) => d[`noticeItem_${i + 1}`] ?? ''), etc: [1, 2, 3, 4].map((i) => d[`noticeEtc_${i}`] ?? '') },
    thumb_url: d.thumbnailUrl || null, images: d.thumbnailUrl ? [d.thumbnailUrl] : [], detail_images: imgs, detail_html: d.contents || null,
    return_price: Number(d.returnPrice) || null, site_registered_on: d.setDay || null, site_updated_on: d.ModifyDay || null,
    coupang_category_code: cupang ? Number(cupang) : null, coupang_category_name: null, coupang_category_predicted_at: null,
    auto_excluded_reason: null, export_seen_at: now, last_seen_at: now, last_changed_at: now, updated_at: now,
  }
  const live = domeatozLiveOptions(d)
  console.log(`  도매 ${row.wholesale_price} + 배송 ${row.delivery_price} · 쿠팡 카테고리 ${row.coupang_category_code ?? '(등록 때 예측)'}${CAT[id] ? ' (지정)' : ''} · 상세 이미지 ${imgs.length}장${hasOpt ? ` · 판매 옵션 ${live.length}개 ${JSON.stringify(d.arOption.optionName)} 추가금 ${JSON.stringify([...new Set(live.map((x) => x.addPrice))])}` : ''}`)
  if (!imgs.length) console.log('  ℹ 상세 이미지 0장 — 등록기가 대표 이미지를 상세로 쓴다')
  if (!DRY) {
    // register_excluded 는 넣지 않는다(이미 사람이 제외한 행이면 그대로 유지)
    const { error } = await sb.from(TABLE).upsert(row, { onConflict: 'idx' })
    if (error) { failed++; console.log(`  ✗ DB 기록 실패: ${error.message}`); await sleep(2000); continue }
  }
  adopted++
  await sleep(2000) // 도매아토즈 API 연달아 부르면 가끔 ECONNRESET
}
console.log(`\n${DRY ? '[DRY] ' : ''}받음 ${adopted} · 건너뜀 ${skipped} · 실패 ${failed}`)
