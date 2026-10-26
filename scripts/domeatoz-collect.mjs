#!/usr/bin/env node
/**
 * 도매아토즈(domeatoz.com) 입점 공급사 상품 수집 → jimscanner_domeatoz_products upsert.
 *   node scripts/domeatoz-collect.mjs [--supplier=00002137,…] [--dry] [--only=3087184,…] [--verbose] [--details[=40]]
 *
 * 설계: docs/plan-domeatoz.md §1·§3 (2026-10-26 정찰)
 *  - 로그인: POST /login form(UserId/UserPass) → sid 쿠키. 브라우저 불필요. sid 는 롤링이라 응답마다 Set-Cookie 를 흡수한다.
 *  - 판매 상태: POST /search (searchType=5 공급사코드) 30건/쪽 JSON — ProductState 1 판매중 · 2 품절 · 3 판매중단. 목록에 없으면 gone.
 *  - 상품 정보: 상품DB 다운로드 — POST /dbDownload(공급사·전 상태) → {idx, tn} → POST /DbDownPage → tempdata(JSON 행 배열).
 *    상세설명 HTML·이미지·브랜드·제조사·원산지·고시(상품상세1~22)·옵션(JsonOption)이 한 번에 온다.
 *    상세 페이지(/product/{IDX})는 약 50회 조회 후 "조회 수가 많아 차단" → 기본 수집에 쓰지 않는다.
 *  - --details[=N]: 상세 페이지에만 있는 묶음배송 수량·주문마감·제주/도서 추가배송비를 아직 없는 판매중 상품 N건(기본 40)만 읽는다. 차단 문구가 나오면 즉시 멈춤.
 *  - 상세 이미지: 공급사 공통 배너(/common/ — 회사 소개·안내)는 제외. detail_html 은 공급사 원문 그대로(신뢰 불가) — 화면·등록에는 detail_images 만 쓴다.
 *  - auto_excluded_reason: 비식품·건강식품/다이어트·냉동/냉장·주류·분유·옵션 상품 → 시세 조회·등록 대상에서 뺀다(리포트용, 사람 판단 아님).
 */
import crypto from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { createClient } from '@supabase/supabase-js'
import { makeDomeatozSession, domeatozLogin, domeatozListSupplier, DOMEATOZ_XHR } from './lib/domeatoz-site.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const env = Object.fromEntries(readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8').split(/\r?\n/).filter((l) => l && !l.startsWith('#') && l.includes('=')).map((l) => { const i = l.indexOf('='); let v = l.slice(i + 1).trim(); if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1); return [l.slice(0, i).trim(), v] }))
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY)
const BASE = 'https://www.domeatoz.com'
const IMG_BASE = 'https://domeatoz.com/'
const TABLE = 'jimscanner_domeatoz_products'

const argv = process.argv.slice(2)
const arg = (k) => argv.find((a) => a.startsWith(`--${k}=`))?.split('=').slice(1).join('=')
const intArg = (k, d) => { const v = arg(k); if (v == null) return d; if (!/^\d+$/.test(v)) { console.error(`--${k} 는 0 이상 정수: ${v}`); process.exit(64) } return +v }
const DRY = argv.includes('--dry'), VERBOSE = argv.includes('--verbose')
const ONLY = new Set((arg('only') || '').split(',').map((s) => s.trim()).filter(Boolean))
const DETAILS = argv.includes('--details') ? 40 : intArg('details', 0)
const FULL_RUN = !ONLY.size
const sleep = (ms) => new Promise((s) => setTimeout(s, ms))

// 수집 대상 공급사(도매아토즈 공급사코드 → 이름). 새 공급사는 여기 한 줄.
const SUPPLIERS = { '00002137': '삼일유통' }
const supplierCodes = (arg('supplier') || Object.keys(SUPPLIERS).join(',')).split(',').map((s) => s.trim()).filter(Boolean)
for (const c of supplierCodes) if (!/^\d{8}$/.test(c)) { console.error(`공급사코드 형식 오류: ${c}`); process.exit(64) }

// 등록 대상에서 자동 제외(시세 조회도 안 함). 순서대로 첫 사유.
const EXCLUDE_RULES = [
  [(r) => !r.group_1, '분류 없음'],
  [(r) => r.group_1 !== '식품', '비식품'],
  [(r) => /건강식품|다이어트/.test(r.group_2 || ''), '건강식품·다이어트(고시·인증 별도)'],
  [(r) => /아이스크림|냉동|냉장/.test(r.name_raw), '냉동·냉장'],
  [(r) => /소주|맥주|막걸리|와인|위스키|주류/.test(r.name_raw), '주류'],
  [(r) => /분유/.test(r.name_raw), '분유'],
  [(r) => /홍삼|유산균|오메가|비타민\s?[A-Z]?\d/.test(r.name_raw), '건강기능식품 의심'],
  [(r) => r.option_type === 'Y', '옵션 상품(1차 범위 밖)'],
  [(r) => !r.export_seen_at, '상품DB 정보 없음'],
]

// ── 세션 — 로그인·목록은 lib/domeatoz-site.mjs(재고 동기화와 공용) ──
const site = makeDomeatozSession(BASE)
const fx = site.fx
const XHR = DOMEATOZ_XHR

// 상품DB 다운로드: 공급사 전 상태 → 행 배열. 폼은 사이트 기본값 중 필요한 것만(가격 설정 0 = 원가 그대로).
async function exportSupplier(code) {
  const form = new URLSearchParams({
    solution: 'PL', fileItemCnt: '3000', dateType: 'date', companyCode: 'in', companyCodeList: code, productCode: 'in', tax: 'all', returnPossible: 'all', priceObey: 'free',
    deliveryTypeAll: 'on', hasOption: 'all', isAdult: 'all', Adult: 'N', productConditionAll: 'on', productConditionSale: 'on', productConditionSoldout: 'on', productConditionStop: 'on',
    deliveryTypepay_: 'pay', marginpay_: '0', etcpay_: '0', Roundspay_: '10', deliveryType_: 'pay', margin_: '0', commission_: '0', dc_: '0', point_: '0', etc_: '0', Rounds_: '10',
  })
  const res = await fx('/dbDownload', { method: 'POST', headers: XHR, body: form })
  const j = await res.json().catch(() => null)
  if (!j || j.Re !== 1 || !j.idx) throw new Error(`상품DB 요청 실패 ${code}: ${JSON.stringify(j).slice(0, 120)}`)
  const rows = []
  for (let n1 = 1; n1 <= j.tn; n1 += 3000) {
    const n2 = Math.min(j.tn, n1 + 2999)
    const p = await fx('/DbDownPage', { method: 'POST', headers: XHR, body: new URLSearchParams({ UserId: env.DOMEATOZ_ID, idx: String(j.idx), n1: String(n1), n2: String(n2), Solution: 'PL' }) })
    const d = await p.json().catch(() => null)
    if (!d || d.Re !== 1) throw new Error(`상품DB 페이지 실패 ${code} ${n1}-${n2}: ${String(d?.msg || '').slice(0, 80)}`)
    rows.push(...(typeof d.tempdata === 'string' ? JSON.parse(d.tempdata) : d.tempdata || []))
    await sleep(500)
  }
  if (rows.length !== j.tn) console.log(`  ⚠ 상품DB 행 수 ${rows.length} ≠ 요청 결과 ${j.tn}`)
  return rows
}

const toInt = (s) => { const n = parseInt(String(s ?? '').replace(/[^\d-]/g, ''), 10); return Number.isFinite(n) ? n : null }
const htmlText = (h) => String(h || '').replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<!--|-->/g, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim()
const cleanName = (s) => String(s || '').replace(/\s+/g, ' ').trim()
const sha = (s) => crypto.createHash('sha1').update(s).digest('hex')
const imgUrl = (u) => { const s = String(u || '').trim(); if (!s) return null; if (/^https?:\/\//i.test(s)) return s.replace(/^http:\/\//i, 'https://'); return IMG_BASE + s.replace(/^\/+/, '') }
const detailImagesOf = (html) => [...new Set([...String(html || '').matchAll(/<img[^>]+src=["']([^"']+)["']/gi)].map((m) => m[1].trim().replace(/^http:\/\//i, 'https://')))]
  .filter((u) => /^https:\/\//.test(u) && !/\/common\//i.test(u))

function fromExport(x) {
  const notice = {}
  for (let i = 1; i <= 22; i++) {
    const v = String(x[`상품상세${i}`] || '').trim()
    if (!v) continue
    const m = v.match(/^([^:]{1,40}):([\s\S]*)$/)
    notice[m ? m[1].trim() : `항목${i}`] = (m ? m[2] : v).trim()
  }
  let options = null
  try { options = x.JsonOption ? JSON.parse(x.JsonOption) : null } catch { options = null }
  const images = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((i) => imgUrl(x[`*이미지${i}URL`] ?? x[`이미지${i}URL`])).filter(Boolean)
  return {
    model_name: x['모델명'] || null, brand: x['브랜드'] || null, maker: x['제조사'] || null, origin: x['*원산지'] || null,
    export_name: cleanName(x['*상품명']), export_price: toInt(x['원가']),
    tax_type: x['*과세여부'] === 'N' ? '면세' : x['*과세여부'] === 'Y' ? '과세' : null,
    thumb_url: images[0] || null, images, detail_html: x['*상세설명'] || null, detail_images: detailImagesOf(x['*상세설명']),
    keywords: String(x['키워드'] || '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 30),
    notice: Object.keys(notice).length ? { 고시코드: x['상품상세코드'] ?? null, ...notice } : null,
    options, option_type: options?.items?.length ? 'Y' : 'N', return_price: toInt(x.ReturnPrice),
  }
}

const STATUS_BY_STATE = { 1: 'active', 2: 'soldout', 3: 'stopped' }
function fromList(x, code) {
  return {
    idx: String(x.IDX), product_code: x.PorductCode || null, supplier_code: code, supplier_name: SUPPLIERS[code] || null,
    name_raw: x.ProductName, name_clean: cleanName(x.ProductName), category_code: x.Category || null,
    group_1: x.IP_Group_1 || null, group_2: x.IP_Group_2 || null, group_3: x.IP_Group_3 || null, group_4: x.IP_Group_4 || null,
    wholesale_price: toInt(x.WholesalePrice), consumer_price: toInt(x.ConsumerPrice), delivery_price: toInt(x.DeliveryPrice), delivery_type: x.DeliveryType || null,
    product_state: toInt(x.ProductState), soldout: Number(x.ProductState) !== 1, status: STATUS_BY_STATE[x.ProductState] || 'stopped', overseas: x.Overseas || null,
  }
}
// 해시 = 사이트가 바꿀 수 있는 내용(상태·시세·판정 제외)
const hashOf = (r) => sha(JSON.stringify([r.name_raw, r.wholesale_price, r.delivery_price, r.group_1, r.group_2, r.group_3, r.model_name, r.brand, r.maker, r.origin, r.tax_type, r.images, r.detail_html, r.keywords, r.notice, r.options, r.return_price]))

// 상세 페이지 전용 필드(묶음배송·마감·제주/도서) — 조회 제한이 있어 소량만
const HEAD_LABELS = ['상품코드', '공급사코드', '상품 등록일', '상품 수정일', '묶음배송 가능 수량', '배송방법', '관심상품 담기', '도매가', '과세여부', '배송가능지역', '반품가능여부', '미성년자 판매여부', '원산지', '제조사/수입사', '모델명', '특별공지', '주문마감 시간', '기본 배송비', '제주 추가배송비', '도서산간 추가배송비', '반품배송비', '구매수량']
function headFields(text) {
  const start = text.indexOf('상품코드 AZ'), end = text.indexOf('구매수량', start)
  const seg = start >= 0 ? text.slice(start, end > start ? end + 4 : start + 3000) : ''
  const pos = HEAD_LABELS.map((l) => [l, seg.indexOf(l)]).filter(([, i]) => i >= 0).sort((a, b) => a[1] - b[1])
  const out = {}
  pos.forEach(([l, i], k) => { out[l] = seg.slice(i + l.length, k + 1 < pos.length ? pos[k + 1][1] : undefined).trim() })
  return out
}
async function fetchDetailPage(idx) {
  const res = await fx(`/product/${idx}`)
  const html = await res.text()
  if (/조회 수가 많아 차단/.test(html)) return { blocked: true }
  if (!/aJson\.Idx/.test(html)) return { err: `상세 형식 이상(HTTP ${res.status})` }
  const f = headFields(htmlText(html))
  const date = (s) => (String(s || '').match(/\d{4}-\d{2}-\d{2}/) || [])[0] || null
  return {
    bundle_qty: toInt(f['묶음배송 가능 수량']), cutoff_text: f['주문마감 시간'] || null, jeju_extra: toInt(f['제주 추가배송비']), island_extra: toInt(f['도서산간 추가배송비']),
    ship_area: (f['배송가능지역'] || '').split(' ')[0] || null, returnable: (f['반품가능여부'] || '').split(' ')[0] || null,
    minor_ok: f['미성년자 판매여부'] ? /가능/.test(f['미성년자 판매여부']) : null,
    site_registered_on: date(f['상품 등록일']), site_updated_on: date(f['상품 수정일']), detail_fetched_at: new Date().toISOString(),
  }
}

// ── 실행 ──
await domeatozLogin(site, { user: env.DOMEATOZ_ID, pass: env.DOMEATOZ_PW })
const exRows = []
for (let from = 0; ; from += 1000) {
  const { data, error } = await sb.from(TABLE).select('idx, content_hash, detail_fetched_at').order('idx').range(from, from + 999)
  if (error) throw new Error(`기존 행 조회 실패: ${error.message}`)
  exRows.push(...(data || [])); if ((data || []).length < 1000) break
}
const existing = new Map(exRows.map((r) => [r.idx, r]))

let rows = []
const listedBySupplier = new Map()
const now = new Date().toISOString()
for (const code of supplierCodes) {
  const list = await domeatozListSupplier(site, code)
  listedBySupplier.set(code, list.map((x) => String(x.IDX)))
  const exp = await exportSupplier(code)
  const byIdx = new Map(exp.map((x) => [String(toInt(String(x['*업체상품코드'] || '').replace(/^AZ/i, ''))), x]))
  console.log(`공급사 ${code} ${SUPPLIERS[code] || ''}: 목록 ${list.length}건 (판매중 ${list.filter((x) => +x.ProductState === 1).length} · 품절 ${list.filter((x) => +x.ProductState === 2).length} · 판매중단 ${list.filter((x) => +x.ProductState === 3).length}) · 상품DB ${exp.length}행`)
  let priceDiff = 0, nameDiff = 0, missing = 0
  for (const x of list) {
    const r = fromList(x, code)
    const e = byIdx.get(r.idx)
    if (e) {
      const { export_name, export_price, ...rest } = fromExport(e)
      if (export_price && r.wholesale_price && export_price !== r.wholesale_price) { priceDiff++; if (VERBOSE) console.log(`  ⚠ ${r.idx} 목록 도매가 ${r.wholesale_price} ≠ 상품DB 원가 ${export_price}`) }
      if (export_name && export_name !== r.name_clean) nameDiff++
      Object.assign(r, rest, { export_seen_at: now })
    } else if (r.product_state === 1) missing++
    rows.push(r)
  }
  if (priceDiff || nameDiff || missing) console.log(`  목록↔상품DB 차이: 도매가 ${priceDiff} · 상품명 ${nameDiff} · 판매중인데 상품DB 없음 ${missing}`)
}
if (ONLY.size) rows = rows.filter((r) => ONLY.has(r.idx))

if (DETAILS) {
  const need = rows.filter((r) => r.product_state === 1 && !existing.get(r.idx)?.detail_fetched_at).slice(0, DETAILS)
  console.log(`상세 페이지(묶음·마감) ${need.length}건 — 조회 제한 때문에 2초 간격`)
  for (const r of need) {
    let d
    try { d = await fetchDetailPage(r.idx) } catch (e) { d = { err: String(e?.message || e).slice(0, 100) } }
    if (d.blocked) { console.log('  ⚠ "조회 수가 많아 차단" — 상세 수집 중단(나머지는 다음 실행)'); break }
    if (d.err) console.log(`  ✗ ${r.idx} ${d.err}`)
    else Object.assign(r, d)
    await sleep(2000) // 실패해도 간격 유지(조회 제한)
  }
}

let changed = 0, unchanged = 0, failed = 0
for (const r of rows) {
  const ex = existing.get(r.idx)
  r.keywords ??= []
  r.auto_excluded_reason = EXCLUDE_RULES.find(([test]) => test(r))?.[1] || null
  r.content_hash = hashOf(r)
  if (VERBOSE || rows.length <= 30) console.log(`  ${r.soldout ? '⛔' : '✅'} ${r.idx} ${r.name_clean.slice(0, 34).padEnd(34)} 도매 ${r.wholesale_price} 배송 ${r.delivery_price} ${r.brand || '-'} 상세 ${(r.detail_images || []).length}장${r.bundle_qty != null ? ` 묶음 ${r.bundle_qty} 마감 ${r.cutoff_text}` : ''}${r.auto_excluded_reason ? ` [제외: ${r.auto_excluded_reason}]` : ''}`)
  if (DRY) continue
  const base = { last_seen_at: now, updated_at: now }
  if (ex && !r.export_seen_at) {
    // 이번 상품DB 에 빠진 기존 상품: 상태만 갱신(목록 값만으로 해시를 다시 쓰면 저장된 상품DB 필드와 어긋난다). 제외 사유는 '상품DB 정보 없음'으로 — 정보가 빠진 채 등록되지 않게
    const { error } = await sb.from(TABLE).update({ ...base, status: r.status, soldout: r.soldout, product_state: r.product_state, auto_excluded_reason: r.auto_excluded_reason }).eq('idx', r.idx)
    if (error) { failed++; console.log(`  ✗ update ${r.idx} ${error.message}`) } else unchanged++
  } else if (ex && ex.content_hash === r.content_hash) {
    const patch = { ...base, status: r.status, soldout: r.soldout, product_state: r.product_state, auto_excluded_reason: r.auto_excluded_reason, ...(r.export_seen_at ? { export_seen_at: r.export_seen_at } : {}) }
    for (const f of ['bundle_qty', 'cutoff_text', 'jeju_extra', 'island_extra', 'ship_area', 'returnable', 'minor_ok', 'site_registered_on', 'site_updated_on', 'detail_fetched_at']) if (r[f] !== undefined) patch[f] = r[f]
    const { error } = await sb.from(TABLE).update(patch).eq('idx', r.idx)
    if (error) { failed++; console.log(`  ✗ update ${r.idx} ${error.message}`) } else unchanged++
  } else {
    const { error } = await sb.from(TABLE).upsert({ ...r, ...base, last_changed_at: now }, { onConflict: 'idx' })
    if (error) { failed++; console.log(`  ✗ upsert ${r.idx} ${error.message}`) } else changed++
  }
}
let gone = 0
if (FULL_RUN && !DRY) {
  for (const [code, idxs] of listedBySupplier) {
    if (idxs.length < 50) { console.log(`  (공급사 ${code} 목록 ${idxs.length}건 — 너무 적어 gone 처리 건너뜀)`); continue }
    const { data, error } = await sb.from(TABLE).update({ status: 'gone', soldout: true, updated_at: now }).eq('supplier_code', code).not('idx', 'in', `(${idxs.join(',')})`).neq('status', 'gone').select('idx')
    if (error) console.log(`  ✗ gone 처리 실패 ${error.message}`); else gone += data.length
  }
}

const cnt = (arr, f) => arr.reduce((o, r) => { const k2 = f(r); o[k2] = (o[k2] || 0) + 1; return o }, {})
const live = rows.filter((r) => r.product_state === 1)
console.log(`\n=== 목록 ${rows.length}건 · 판매중 ${live.length} ===`)
console.log('판매중 자동 제외:', JSON.stringify(cnt(live.filter((r) => r.auto_excluded_reason), (r) => r.auto_excluded_reason)), `→ 시세 조회 대상 ${live.filter((r) => !r.auto_excluded_reason).length}`)
console.log('판매중 상세 이미지 수:', JSON.stringify(cnt(live, (r) => String((r.detail_images || []).length))), '· 과세:', JSON.stringify(cnt(live, (r) => r.tax_type ?? '?')))
if (!DRY) console.log(`DB: 변경 ${changed} · 동일 ${unchanged} · 실패 ${failed} · gone ${gone}`)
if (failed) process.exitCode = 1
