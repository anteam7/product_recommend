/**
 * 77bio → 쿠팡 Open API 등록 (jimscanner_bio77_products → jimscanner_coupang_listings, source='bio77')
 *   node --env-file=.env.local scripts/bio77-register.mjs [--limit=N] [--min-margin=0.15] [--dry] [--no-approval]
 *
 * coupang-register-batch-v2.mjs(ggsan) 패턴 재사용. 77bio 전용 차이점:
 *   - 카테고리 예측 생략: 77bio가 이미 검증된 쿠팡 표준 카테고리코드를 줌(coupang_category_code) — getMeta로 존재만 검증
 *   - 가격: msp_price_krw(77bio "판매가", 절대준수)를 그대로 salePrice로 사용. 마진 재계산 없이 지정가 그대로.
 *   - 속성(attributes): XLSM 옵션유형/값(options) → 메타 attributeTypeName 매칭 우선, 실패분만 ggsan 폴백 로직
 *   - 이미지: 대표=thumb_url, 상세=detail_html에서 <img src> 추출
 *   - 등록 성공 시 기본적으로 승인요청까지 진행(--no-approval로 끄기). vendorItemId는 검수 후(수시간~1-2일) 부여될 수 있음.
 */
import crypto from 'node:crypto'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { createClient } from '@supabase/supabase-js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const env = Object.fromEntries(readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8').split(/\r?\n/).filter(l => l && !l.startsWith('#') && l.includes('=')).map(l => { const i = l.indexOf('='); let v = l.slice(i + 1).trim(); if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1); return [l.slice(0, i).trim(), v] }))
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY)
const VENDOR_ID = env.COUPANG_VENDOR_ID
const ACCESS_KEY = env.COUPANG_ACCESS_KEY
const SECRET_KEY = env.COUPANG_SECRET_KEY
const HOST = env.COUPANG_API_HOST

// coupang-register-batch-v2.mjs와 동일 상수 (반품지/출고지/수수료율 이중관리 지점 — docs/coupang-integration-guide.md §9-7)
const OUTBOUND_SHIPPING_PLACE_CODE = 24724717
const RETURN_CENTER_CODE = '1002609354'
const RETURN_CHARGE_NAME = '신사로 반품'
const RETURN_CHARGE = 3000
const RETURN_ADDRESS = '서울특별시 관악구 신사로26길 38-8'
const RETURN_ADDRESS_DETAIL = '301'
const RETURN_ZIP_CODE = '08703'
const COMPANY_CONTACT = '010-4164-3802'
const OUTBOUND_SHIP = 3000
const COUPANG_FEE_RATE = 0.106

const args = process.argv.slice(2)
const DRY = args.includes('--dry')
const NO_APPROVAL = args.includes('--no-approval')
const LIMIT = +(args.find(a => a.startsWith('--limit='))?.split('=')[1] || 10)
const MIN_MARGIN = +(args.find(a => a.startsWith('--min-margin='))?.split('=')[1] || 0.15)

const metaCacheDir = path.join(__dirname, '..', '_tmp_meta_cache')
if (!existsSync(metaCacheDir)) mkdirSync(metaCacheDir, { recursive: true })
const sleep = ms => new Promise(s => setTimeout(s, ms))

function sign(method, urlPath, query = '') {
  const dt = new Date().toISOString().substring(2, 19).replace(/[-:]/g, '') + 'Z'
  return { datetime: dt, signature: crypto.createHmac('sha256', SECRET_KEY).update(dt + method + urlPath + query).digest('hex') }
}
async function api(method, urlPath, body = null) {
  const { datetime, signature } = sign(method, urlPath, '')
  const res = await fetch(`${HOST}${urlPath}`, {
    method,
    headers: { Authorization: `CEA algorithm=HmacSHA256, access-key=${ACCESS_KEY}, signed-date=${datetime}, signature=${signature}`, 'Content-Type': 'application/json;charset=UTF-8' },
    body: body ? JSON.stringify(body) : undefined,
  })
  const t = await res.text()
  try { return { status: res.status, body: JSON.parse(t) } } catch { return { status: res.status, body: t } }
}
async function getCategoryMeta(displayCategoryCode) {
  const cachePath = path.join(metaCacheDir, `${displayCategoryCode}_raw.json`)
  if (existsSync(cachePath)) return JSON.parse(readFileSync(cachePath, 'utf8'))
  const r = await api('GET', `/v2/providers/seller_api/apis/api/v1/marketplace/meta/category-related-metas/display-category-codes/${displayCategoryCode}`)
  if (r.status !== 200 || !r.body?.data) throw new Error(`meta fetch failed ${displayCategoryCode}: HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 150)}`)
  writeFileSync(cachePath, JSON.stringify(r.body.data, null, 2), 'utf8')
  return r.body.data
}

function pickUnit(usableUnits, preferences) {
  if (!usableUnits || usableUnits.length === 0) return ''
  for (const p of preferences) if (usableUnits.includes(p)) return p
  return usableUnits[0]
}
function pickNoticeCategory(noticeCategories) {
  if (!noticeCategories || noticeCategories.length === 0) return null
  // ggsan(coupang-register-batch-v2.mjs)과 동일 순서: "건강기능식품" 고시는 실제 MFDS 인증 기능정보/영양정보를
  // 요구해 placeholder("상세설명 참조")로 거절될 수 있음(2026-09-01 확인) — "가공식품" 고시가 더 관대해 우선 사용.
  const preferred = ['가공식품', '건강기능식품']
  for (const p of preferred) { const f = noticeCategories.find(n => n.noticeCategoryName === p); if (f) return f }
  return noticeCategories[0]
}
function buildNotices(noticeCategory, title) {
  if (!noticeCategory) return []
  const name = noticeCategory.noticeCategoryName
  const valueFor = (detailName) => {
    if (/제품명|품명|품목/.test(detailName)) return title
    if (/포장단위|용량.*중량|중량.*용량/.test(detailName)) return title
    if (/주의|안전/.test(detailName)) return '직사광선을 피하고 서늘한 곳에 보관하시기 바랍니다. 알레르기 체질 등 특이체질인 경우 원재료를 확인하신 후 섭취하시기 바랍니다.'
    if (/유전자변형|GMO/.test(detailName)) return '해당없음'
    if (/수입.*문구|수입.*여부/.test(detailName)) return '해당없음'
    if (/상담.*전화|전화번호/.test(detailName)) return COMPANY_CONTACT
    if (/원산지/.test(detailName)) return '국산'
    return '상세설명 참조'
  }
  const mandatory = (noticeCategory.noticeCategoryDetailNames ?? []).filter(dn => dn.required === 'MANDATORY')
  return mandatory.map(dn => ({ noticeCategoryName: name, noticeCategoryDetailName: dn.noticeCategoryDetailName, content: valueFor(dn.noticeCategoryDetailName) }))
}
// coupang-register-batch-v2.mjs(ggsan)와 동일한 검증된 EXPOSED 스킴을 그대로 쓰되,
// "개당 중량/용량/캡슐" 수치는 XLSM 구매옵션 실측값(options)에서 가져와 title 정규식 추측보다 정확하게 채운다.
// 주의: 개당 중량/중량 같은 이름 차이 때문에 XLSM 옵션유형명과 메타 attributeTypeName은 다르다 — 직접 문자열 매칭 금지, 반드시 정규식으로 느슨하게 찾을 것.
function parseOptionNum(options, typeRe) {
  const opt = (options ?? []).find(o => typeRe.test(String(o?.type || '')))
  if (!opt) return null
  const m = /([\d.]+)\s*([a-zA-Z가-힣]+)/.exec(String(opt.value || ''))
  return m ? { value: parseFloat(m[1]), unit: m[2] } : null
}
// 2026-09-01 실측(WebSearch로 확인): 쿠팡이 2026-02-02부터 "필수 구매옵션 입력 의무화" 정책을 시행함.
// 메타의 isAllowSingleItem이 false인 카테고리는 실제 옵션(변형)을 가진 상품만 등록 가능 — 단일 SKU에
// exposed:EXPOSED로 더미 값을 채워 넣는 방식(ggsan 구 방식, 73137/58927 등 옛 안정 카테고리도 현재는 false)은
// 통과하지 못함(회귀 확인). isAllowSingleItem=true인 카테고리만 단일상품으로 등록하고, false는 이번엔 SKIP한다
// (진짜 옵션조합 등록은 items[] 배열에 여러 variant를 넣는 별도 구현 필요 — 후속 작업, docs/coupang-integration-guide.md §9 참고).
function buildItemAttributes(categoryAttrs, options) {
  const hasSuryang = categoryAttrs.some(a => a.attributeTypeName === '수량')
  const fallbackName = hasSuryang ? '수량' : '총 수량'
  const capsule = parseOptionNum(options, /캡슐|정|개입/)
  const weight = parseOptionNum(options, /중량|무게/)
  const volume = parseOptionNum(options, /용량/)
  const isLiquid = volume != null

  const buildValue = (a) => {
    const name = a.attributeTypeName
    if (name === fallbackName) return `1 ${pickUnit(a.usableUnits, ['개', '박스', '세트', '팩'])}`
    if (name === '개당 캡슐/정') return `${capsule?.value ?? 30} ${pickUnit(a.usableUnits, ['정', '회분'])}`
    if (name === '개당 중량') return `${weight?.value ?? (isLiquid ? 1 : 0)} ${pickUnit(a.usableUnits, ['g', 'kg'])}`
    if (name === '개당 용량') return `${volume?.value ?? 0} ${pickUnit(a.usableUnits, ['ml', 'L'])}`
    return '상세설명 참조'
  }
  // groupNumber(캡슐/중량/용량처럼 상호배타)는 실제 상품형태에 맞는 것 하나만 채우고 나머지는 생략
  const groups = new Map()
  const rest = []
  for (const a of categoryAttrs) {
    const name = a.attributeTypeName
    if ((name === '수량' || name === '총 수량') && name !== fallbackName) continue // 중복 수량류 생략
    if (a.groupNumber && a.groupNumber !== 'NONE') {
      const cur = groups.get(a.groupNumber)
      const matched = (n) => (n === '개당 캡슐/정' && capsule) || (n === '개당 중량' && weight) || (n === '개당 용량' && volume)
      if (!cur || (matched(name) && !matched(cur.attributeTypeName))) groups.set(a.groupNumber, a)
    } else {
      rest.push(a)
    }
  }
  const selected = [...groups.values(), ...rest]
  const out = selected.map(a => {
    const isMandatoryNumeric = a.required === 'MANDATORY' && ['개당 캡슐/정', '개당 중량', '개당 용량'].includes(a.attributeTypeName)
    const value = (a.attributeTypeName === fallbackName || isMandatoryNumeric) ? buildValue(a) : ''
    // 단일상품(isAllowSingleItem=true)은 "옵션 선택"이 없는 상품이므로 아무것도 노출(EXPOSED)하지 않는다 —
    // 여기서 exposed:EXPOSED를 쓰면(구 ggsan 방식) 오히려 "존재하지 않는 옵션을 노출하려 한다"는 오류가 남.
    return { attributeTypeName: a.attributeTypeName, attributeValueName: value, exposed: 'NONE' }
  })
  const suryangVal = out.find(a => a.attributeTypeName === fallbackName)?.attributeValueName
  const itemName = suryangVal || '1 개'
  return { attributes: out, itemName }
}
function extractImgUrls(html) {
  return [...String(html || '').matchAll(/<img[^>]+src=["']([^"']+)["']/gi)].map(m => m[1])
}

function buildPayload(row, meta) {
  const salePrice = row.msp_price_krw
  const originalPrice = Math.ceil(salePrice * 1.2 / 100) * 100
  const fee = Math.round(salePrice * COUPANG_FEE_RATE)
  const vat = Math.round(salePrice / 11)
  const realMargin = salePrice - (row.dome_price_krw + OUTBOUND_SHIP) - fee - vat
  const marginPct = parseFloat(((realMargin / salePrice) * 100).toFixed(2))

  const detailImgs = extractImgUrls(row.detail_html)
  const items_images = [
    { imageOrder: 0, imageType: 'REPRESENTATION', vendorPath: row.thumb_url },
  ]
  const contents = detailImgs.slice(0, 10).map(u => ({ contentsType: 'IMAGE_NO_SPACE', contentDetails: [{ content: u, detailType: 'IMAGE' }] }))

  const noticeCategory = pickNoticeCategory(meta.noticeCategories)
  const notices = buildNotices(noticeCategory, row.title)
  const { attributes: itemAttributes, itemName } = buildItemAttributes(meta.attributes ?? [], row.options)

  const items = [{
    itemName, originalPrice, salePrice,
    maximumBuyCount: 0, maximumBuyForPerson: 0, maximumBuyForPersonPeriod: 1,
    outboundShippingTimeDay: 2, unitCount: 1, adultOnly: 'EVERYONE', taxType: 'TAX',
    parallelImported: 'NOT_PARALLEL_IMPORTED', overseasPurchased: 'NOT_OVERSEAS_PURCHASED', pccNeeded: false,
    externalVendorSku: row.goods_no, images: items_images, notices, attributes: itemAttributes, contents, offerCondition: 'NEW',
  }]

  const payload = {
    vendorId: VENDOR_ID, sellerProductName: row.title, displayProductName: row.title,
    displayCategoryCode: row.coupang_category_code, brand: row.brand ?? row.title.split(/\s+/)[0],
    generalProductName: row.title, productGroup: row.title.split(/\s+/).slice(0, 3).join(' '),
    manufacture: '상세설명 참조', saleStartedAt: new Date().toISOString().slice(0, 19), saleEndedAt: '2099-12-31T00:00:00',
    deliveryMethod: 'SEQUENCIAL', deliveryCompanyCode: 'CJGLS', deliveryChargeType: 'FREE', deliveryCharge: 0,
    freeShipOverAmount: 0, deliveryChargeOnReturn: 3000, remoteAreaDeliverable: 'N', unionDeliveryType: 'NOT_UNION_DELIVERY',
    returnCenterCode: RETURN_CENTER_CODE, returnChargeName: RETURN_CHARGE_NAME, companyContactNumber: COMPANY_CONTACT,
    returnZipCode: RETURN_ZIP_CODE, returnAddress: RETURN_ADDRESS, returnAddressDetail: RETURN_ADDRESS_DETAIL,
    returnCharge: RETURN_CHARGE, outboundShippingPlaceCode: OUTBOUND_SHIPPING_PLACE_CODE, vendorUserId: 'anteam7',
    requested: false, items, notices: [], requiredDocuments: [],
  }
  return { payload, salePrice, fee, realMargin, marginPct }
}

// ── 대상 선정 ──
const { data: candidates } = await sb.from('jimscanner_bio77_products').select('*').eq('coupang_sellable', true).eq('status', '정상').not('coupang_category_code', 'is', null)
const { data: existing } = await sb.from('jimscanner_coupang_listings').select('source_goods_no').eq('source', 'bio77')
const existingSet = new Set((existing ?? []).map(r => r.source_goods_no))

const withMargin = (candidates ?? [])
  .filter(r => !existingSet.has(r.goods_no) && r.dome_price_krw > 0 && r.msp_price_krw > 0)
  .map(r => {
    const fee = Math.round(r.msp_price_krw * COUPANG_FEE_RATE)
    const vat = Math.round(r.msp_price_krw / 11)
    const margin = r.msp_price_krw - (r.dome_price_krw + OUTBOUND_SHIP) - fee - vat
    return { ...r, marginPct: margin / r.msp_price_krw }
  })
  .filter(r => r.marginPct >= MIN_MARGIN)
  .sort((a, b) => b.marginPct - a.marginPct)
  .slice(0, LIMIT)

console.log(`=== bio77 → 쿠팡 등록 ${DRY ? '[DRY]' : ''} ===`)
console.log(`대상: ${withMargin.length}건 (마진 ${(MIN_MARGIN * 100).toFixed(0)}%↑, 이미등록 ${existingSet.size}건 제외, limit=${LIMIT})\n`)

const summary = { success: 0, fail: 0, approved: 0, errors: [] }
for (let i = 0; i < withMargin.length; i++) {
  const row = withMargin[i]
  const idx = `[${i + 1}/${withMargin.length}]`
  try {
    // 77bio가 준 실제 쿠팡 카테고리코드를 그대로 사용(더 이상 73137로 강제폴백하지 않음 — 아래 참고).
    const registerCategoryCode = row.coupang_category_code
    const meta = await getCategoryMeta(registerCategoryCode)
    // 쿠팡 "필수 구매옵션 입력 의무화"(2026-02-02~) 이후 isAllowSingleItem=false 카테고리는 진짜 옵션(변형)
    // 상품만 등록 가능 — 단일 SKU 등록은 이번 스코프 밖(별도 옵션조합 구현 필요)이라 SKIP.
    // ggsan의 기존 안정 폴백(73137/58927)도 현재 둘 다 isAllowSingleItem=false로 바뀌어 있어 폴백 자체가 무의미해짐(2026-09-01 확인).
    if (meta.isAllowSingleItem === false) {
      console.log(`${idx} ⏭ ${row.goods_no} [${registerCategoryCode}] ${row.title.slice(0, 36).padEnd(36)} | isAllowSingleItem=false — 단일상품 등록 불가, SKIP`)
      if (!DRY) {
        await sb.from('jimscanner_coupang_listings').insert({
          vendor_id: VENDOR_ID, source: 'bio77', source_goods_no: row.goods_no, source_detail_url: row.detail_url,
          registered_title: row.title, display_category_code: registerCategoryCode, display_category_name: row.coupang_category_name,
          brand: row.brand ?? row.title.split(/\s+/)[0], dome_price_krw: row.dome_price_krw, msp_price_krw: row.msp_price_krw,
          list_price_krw: row.msp_price_krw, status: 'SKIPPED', displayable: false,
          rejection_reason: 'isAllowSingleItem=false — 옵션조합 등록 미구현으로 보류',
        })
      }
      summary.fail++
      await sleep(300); continue
    }
    const built = buildPayload(row, meta)
    if (DRY) {
      console.log(`${idx} (dry) ${row.goods_no} ${row.title.slice(0, 36).padEnd(36)} | ${built.salePrice.toLocaleString().padStart(7)}원 (${built.marginPct}%) [${row.coupang_category_code}]`)
      continue
    }
    const r = await api('POST', '/v2/providers/seller_api/apis/api/v1/marketplace/seller-products', built.payload)
    const success = r.status === 200 && r.body?.code === 'SUCCESS'
    const sellerProductId = typeof r.body?.data === 'number' ? r.body.data : null

    const listingRow = {
      seller_product_id: sellerProductId, vendor_id: VENDOR_ID, source: 'bio77',
      source_goods_no: row.goods_no, source_detail_url: row.detail_url, registered_title: row.title,
      display_category_code: registerCategoryCode, display_category_name: row.coupang_category_name, brand: built.payload.brand,
      dome_price_krw: row.dome_price_krw, source_shipping_fee_krw: 0, outbound_shipping_fee_krw: OUTBOUND_SHIP,
      msp_price_krw: row.msp_price_krw, list_price_krw: built.salePrice,
      estimated_fee_krw: built.fee, estimated_margin_krw: built.realMargin, estimated_margin_pct: built.marginPct,
      status: success ? 'TEMPORARY_SAVE' : 'FAILED', displayable: false,
      rejection_reason: success ? null : (r.body?.message ?? String(r.body).slice(0, 500)),
      request_payload: built.payload, last_response: r.body,
      registered_at: success ? new Date().toISOString() : null, last_synced_at: new Date().toISOString(),
    }
    const { data: inserted, error: insertErr } = await sb.from('jimscanner_coupang_listings').insert(listingRow).select('id').single()
    if (insertErr) {
      // 쿠팡 등록 자체는 API 응답상 success일 수 있으나 DB 기록 실패 — 이후 승인요청 단계를 진행하면 추적 불가 상태가 되므로 여기서 중단.
      summary.fail++
      summary.errors.push({ goods_no: row.goods_no, title: row.title.slice(0, 40), cat: row.coupang_category_code, reason: `listings insert 실패: ${insertErr.message}` })
      console.log(`${idx} ⚠ ${row.goods_no} 쿠팡 등록 success=${success}이나 DB insert 실패: ${insertErr.message}`)
      await sleep(500); continue
    }

    if (!success) {
      summary.fail++
      const reason = (r.body?.message ?? '').slice(0, 150)
      summary.errors.push({ goods_no: row.goods_no, title: row.title.slice(0, 40), cat: row.coupang_category_code, reason })
      console.log(`${idx} ✗ ${row.goods_no} [${row.coupang_category_code}] ${row.title.slice(0, 36).padEnd(36)} | ${reason}`)
      await sleep(500); continue
    }
    summary.success++
    console.log(`${idx} ✓ ${row.goods_no} ${row.title.slice(0, 36).padEnd(36)} | ${built.salePrice.toLocaleString().padStart(7)}원 (${built.marginPct}%) | sellerPID=${sellerProductId}`)

    if (!NO_APPROVAL && sellerProductId) {
      await sleep(500)
      const appr = await api('PUT', `/v2/providers/seller_api/apis/api/v1/marketplace/seller-products/${sellerProductId}/approvals`)
      const apprOk = appr.status === 200 && (appr.body?.code === 'SUCCESS' || appr.body?.code === 200)
      if (apprOk) {
        await sb.from('jimscanner_coupang_listings').update({ status: 'PENDING_APPROVAL', last_synced_at: new Date().toISOString() }).eq('id', inserted.id)
        summary.approved++
        console.log(`      → 승인요청 완료 (PENDING_APPROVAL)`)
        await sleep(1500)
        const detail = await api('GET', `/v2/providers/seller_api/apis/api/v1/marketplace/seller-products/${sellerProductId}`)
        const vendorItemIds = (detail.body?.data?.items ?? []).map(it => it.vendorItemId).filter(Boolean)
        if (vendorItemIds.length) {
          const qty = Math.min(row.stock_qty || 5, 30)
          for (const vid of vendorItemIds) {
            await api('PUT', `/v2/providers/seller_api/apis/api/v1/marketplace/vendor-items/${vid}/quantities/${qty}`)
            await sleep(300)
          }
          console.log(`      → 재고 ${qty}개 설정 (vendorItemId ${vendorItemIds.join(',')})`)
        } else {
          console.log(`      → vendorItemId 미부여 (쿠팡 검수 대기, 수시간~1-2일)`)
        }
      } else {
        console.log(`      → 승인요청 실패: ${JSON.stringify(appr.body).slice(0, 150)}`)
        await sb.from('jimscanner_coupang_listings').update({ rejection_reason: `승인요청 실패: ${JSON.stringify(appr.body).slice(0, 300)}`, last_synced_at: new Date().toISOString() }).eq('id', inserted.id)
      }
    }
  } catch (e) {
    summary.fail++
    summary.errors.push({ goods_no: row.goods_no, title: row.title.slice(0, 40), reason: e.message })
    console.log(`${idx} ✗ ${row.goods_no} ERROR: ${e.message}`)
  }
  await sleep(500)
}

console.log('\n=== 완료 ===')
console.log(`성공: ${summary.success}건 / 승인요청: ${summary.approved}건 / 실패: ${summary.fail}건`)
if (summary.errors.length) {
  console.log('\n실패 사유:')
  summary.errors.forEach(e => console.log(`  - ${e.goods_no} [${e.cat ?? '?'}] ${e.title}: ${e.reason}`))
}
