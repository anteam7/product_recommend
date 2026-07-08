/**
 * 비셀러 강력등급 그룹 → 네이버 스마트스토어 등록 (같은 그룹 변형 = 옵션 묶음).
 *   node --env-file=.env.local scripts/beseller-naver-register.mjs [--grade=strong] [--limit=N] [--margin=0.25] [--group=<key>] [--expose] [--dry]
 * 판매가 = ceil(공급가 / (1-FEE-MARGIN) /100)*100, MSP 하한. base=최저옵션, 옵션 추가금액=sell-base.
 * 기본 SUSPENSION(비노출). --expose 시 ON. jimscanner_naver_listings(source='beseller') 추적.
 */
import { naverApi, naverUpload } from './lib/naver-api.mjs'
import { createClient } from '@supabase/supabase-js'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const env = Object.fromEntries(readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8').split(/\r?\n/).filter((l) => l && !l.startsWith('#') && l.includes('=')).map((l) => { const i = l.indexOf('='); let v = l.slice(i + 1).trim(); if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1); return [l.slice(0, i).trim(), v] }))
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY)
const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.split('=').slice(1).join('=') : d }
const GRADES = (arg('grade', 'strong')).split(',').map((s) => s.trim()).filter(Boolean)
const LIMIT = parseInt(arg('limit') || '0') || 0
const MARGIN = parseFloat(arg('margin') || '0.25')
const ONE_GROUP = arg('group')
const EXPOSE = process.argv.includes('--expose')
const DRY = process.argv.includes('--dry')
const FEE = 0.06
const sleep = (ms) => new Promise((s) => setTimeout(s, ms))

const SHIP_ADDR = 106028428, RETURN_ADDR = 200357454, BUNDLE_GROUP = 54006647, CONTACT = '010-4164-3802'

// ── 판매가 ──
const sellOf = (supply, msp) => { const base = Math.ceil(supply / (1 - FEE - MARGIN) / 100) * 100; return Math.max(base, msp || 0) }

// ── 카테고리: 런타임 트리 + 큐레이션 규칙 + 말단명 매칭 + 폴백 ──
const CURATED = [
  // 김치
  [/파김치/, '50002029'], [/총각김치/, '50002021'], [/열무김치|열무.*김치/, '50002028'], [/갓김치/, '50002020'],
  [/깍두기/, '50002022'], [/오이소박이/, '50014081'], [/겉절이/, '50002023'], [/묵은지/, '50002026'], [/백김치/, '50002027'],
  [/동치미/, '50002025'], [/나박김치/, '50002024'], [/절임\s*배추/, '50002031'], [/포기김치|배추김치|김장김치/, '50002019'],
  [/고들빼기|파프리카김치|무김치|열무얼갈이|얼갈이|부추김치|갓\s|별미|보쌈무|무말랭이.*김치/, '50002030'],
  // 젓갈/장류(수산)
  [/새우젓/, '50004728'], [/명란젓|명란/, '50004727'], [/오징어젓/, '50004729'], [/낙지젓/, '50004730'],
  [/창난젓|창란젓/, '50004732'], [/조개젓/, '50004731'], [/연어장/, '50013840'], [/새우장|대하장/, '50002458'],
  [/게장|간장게장|양념게장|참소라장|가리비장|전복장/, '50004734'], [/어리굴젓|굴젓/, '50004736'], [/젓$|젓\s/, '50004736'],
  // 반찬
  [/장아찌/, '50001916'], [/장조림/, '50001917'], [/단무지/, '50014340'], [/무침|나물무침|생채/, '50018341'],
  [/조림/, '50002016'], [/볶음|볶은/, '50014360'], [/절임/, '50002015'], [/반찬\s*세트|모듬반찬/, '50002017'],
  [/우엉채|연근|도라지무침|고사리|취나물|시래기|무말랭이|고구마순|콩나물무침|얼갈이자박이|자박이/, '50002018'],
  // 냉동/간편
  [/만두|딤섬|교자/, '50001871'], [/어묵/, '50001874'], [/핫도그/, '50001868'], [/피자/, '50001867'],
  [/돈가스|돈까스/, '50004662'], [/튀김/, '50001877'], [/도시락/, '50006199'],
  // 면/떡/국밥/밀키트 (말단명 매칭이 애매한 것 보강)
  [/국수|소바|콩국수|막국수|메밀/, '50013960'], [/떡볶이/, '50014240'],
  [/인절미|가래떡|백설기|절편|송편|영양떡|찰떡|바람떡|꿀떡/, '50019139'],
  [/국밥|순대국|돼지국밥|설렁탕|곰탕|육개장|갈비탕|매운탕|해장국|우거지/, '50020779'],
  // 축산
  [/떡갈비/, '50004668'], [/족발/, '50004670'], [/순대/, '50004675'], [/삼계탕/, '50004678'], [/육포/, '50004676'],
  [/곱창|막창|대창/, '50013820'], [/la갈비|엘에이|양념갈비|불고기|주물럭|목살|삼겹|앞다리|한입갈비|갈비/i, '50013720'],
  [/한우|육우|사골|우족|양지|사태|등심|채끝|안심|제비추리|살치|부챗살|우삼겹/, '50004653'],
  [/닭가슴살/, '50013800'], [/닭발/, '50017901'], [/오리/, '50013640'], [/양갈비|양꼬치|램/, '50017780'],
  // 수산
  [/성게알|성게/, '50018200'], [/대게|홍게/, '50007076'], [/가리비/, '50007077'], [/전복/, '50004701'],
  [/새우(?!젓)/, '50004702'], [/오징어(?!젓)/, '50004710'], [/문어/, '50004707'], [/낙지(?!젓)/, '50004706'],
  [/굴비/, '50004684'], [/장어/, '50004685'], [/갈치/, '50004682'], [/고등어/, '50004683'], [/연어/, '50004693'],
  [/쥐포/, '50004738'], [/진미채/, '50004746'], [/황태|코다리/, '50004747'], [/멸치/, '50004737'], [/김\s|김밥용김|재래김|파래김/, '50004695'],
  // 과일/채소
  [/자두/, '50002181'], [/키위|참다래/, '50002176'], [/레몬/, '50002186'], [/자몽/, '50002191'], [/오렌지/, '50002190'],
  [/한라봉|천혜향|레드향|감귤|귤/, '50002163'], [/사과/, '50002160'], [/배(?!추)/, '50002161'], [/포도|샤인/, '50002180'],
  [/딸기/, '50002164'], [/멜론/, '50002170'], [/수박/, '50002175'], [/체리/, '50002185'], [/망고/, '50002187'],
  [/감자/, '50002215'], [/고구마/, '50002214'], [/마늘|깐마늘/, '50002203'], [/양파/, '50002200'], [/생강/, '50002206'],
  [/더덕/, '50002217'], [/도라지/, '50002218'], [/버섯|표고|느타리/, '50002205'],
  // 건강식품
  [/홍삼정|홍삼진|홍삼액|홍삼농축/, '50012080'], [/홍삼.*환|홍삼.*캡슐/, '50012101'], [/홍삼/, '50012080'],
  [/도라지.*배|배.*도라지|배즙/, '50014460'], [/양배추즙/, '50007001'], [/양파즙/, '50007002'], [/호박즙/, '50007003'],
  [/석류즙/, '50014380'], [/사과즙/, '50014400'], [/흑염소/, '50017240'], [/즙/, '50007007'],
  [/멀티\s*비타민|종합비타민/, '50002425'], [/유산균|프로바이오|바이오틱스/, '50007030'], [/밀크씨슬/, '50007031'],
  [/미숫가루|선식|분말|가루/, '50018980'], [/차$|차\s/, '50011861'],
]
const CATE_FALLBACK = { '김치/장류/반찬': '50002018', '가공식품': '50002018', '건강식품': '50002615', '농산물': '50002234', '수산물': '50004726', '청과물': '50002193', '축산물': '50000215' }

let FOOD_LEAVES = []
let LEAF_IDS = new Set()
async function loadLeaves() {
  const r = await naverApi('GET', '/v1/categories')
  const all = Array.isArray(r.body) ? r.body : []
  FOOD_LEAVES = all.filter((c) => c.last && /^식품>/.test(c.wholeCategoryName || '')).map((c) => ({ id: c.id, term: (c.wholeCategoryName || '').split('>').pop() }))
    .sort((a, b) => b.term.length - a.term.length) // 최장 말단명 우선
  LEAF_IDS = new Set(FOOD_LEAVES.map((l) => l.id))
}
function resolveCategory(title, cateLabel) {
  const t = title || ''
  for (const [re, id] of CURATED) if (re.test(t) && LEAF_IDS.has(id)) return id // 큐레이션은 leaf일 때만(중분류 자동 폴백)
  for (const lf of FOOD_LEAVES) if (lf.term.length >= 2 && t.includes(lf.term)) return lf.id
  return CATE_FALLBACK[cateLabel] || '50002234'
}

// ── 옵션 그룹명 판정 ──
function optionGroupName(labels) {
  const j = labels.join(' ')
  if (/kg|\bg\b|g\s|ml|리터|용량|중량/i.test(j)) return '중량'
  if (/개|포|봉|입|마리|박스|구|과|팩|병|세트/.test(j)) return '수량'
  return '종류'
}

// ── 이미지 업로드 ──
async function uploadOne(url) {
  try {
    if (!url) return null
    const r = await fetch(url); if (!r.ok) return null
    const buf = Buffer.from(await r.arrayBuffer()); if (buf.length < 800) return null
    // 매직바이트로 실제 이미지 타입 판별 (비셀러 URL 확장자 불량 .? / 무확장자 대비)
    let ct, ext
    if (buf[0] === 0x89 && buf[1] === 0x50) { ct = 'image/png'; ext = 'png' }
    else if (buf[0] === 0x47 && buf[1] === 0x49) { ct = 'image/gif'; ext = 'gif' }
    else if (buf[0] === 0xFF && buf[1] === 0xD8) { ct = 'image/jpeg'; ext = 'jpg' }
    else if (buf.length > 12 && buf.slice(8, 12).toString('ascii') === 'WEBP') { ct = 'image/webp'; ext = 'webp' }
    else return null // 이미지 아님
    const fd = new FormData(); fd.append('imageFiles', new Blob([buf], { type: ct }), `img.${ext}`)
    const up = await naverUpload('/v1/product-images/upload', fd); return up.status === 200 ? (up.body?.images?.[0]?.url ?? null) : null
  } catch { return null }
}

const seoName = (title, gk) => (title || gk || '').replace(/\d+\s*(kg|g|ml|개|포|봉|마리|박스|구|과)\b/gi, ' ').replace(/[^0-9A-Za-z가-힣()\-·\[\]/&+,~.\s]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 90)

// 고시 — 전부 상품상세참조
const noticeAllRef = (keys) => Object.fromEntries(keys.map((k) => [k, '상품상세참조']))
function buildNotice(isHealth) {
  if (isHealth) {
    const dietFood = { ...noticeAllRef(['returnCostReason', 'noRefundReason', 'qualityAssuranceStandard', 'compensationProcedure', 'troubleShootingContents', 'productName', 'producer', 'location', 'expirationDateText', 'consumptionDateText', 'storageMethod', 'weight', 'amount', 'ingredients', 'nutritionFacts', 'specification', 'cautionAndSideEffect', 'nonMedicinalUsesMessage', 'consumerSafetyCaution', 'customerServicePhoneNumber']), geneticallyModified: false, importDeclarationCheck: false }
    return { productInfoProvidedNoticeType: 'DIET_FOOD', dietFood }
  }
  // GENERAL_FOOD(일반가공식품) 필수 필드(네이버 프로브 확인) — 전부 상품상세참조 + 전화
  const generalFood = { ...noticeAllRef(['productName', 'foodType', 'producer', 'location', 'ingredients', 'weight', 'amount', 'packDateText', 'consumptionDateText', 'consumerSafetyCaution']), customerServicePhoneNumber: CONTACT, geneticallyModified: false, importDeclarationCheck: false }
  return { productInfoProvidedNoticeType: 'GENERAL_FOOD', generalFood }
}

// ── 그룹 로드 ──
async function loadTargets() {
  const { data: cmp } = await sb.from('jimscanner_beseller_price_compare').select('*').in('grade', GRADES).order('margin_rate', { ascending: false })
  let groups = cmp || []
  if (ONE_GROUP) groups = groups.filter((g) => g.group_key === ONE_GROUP)
  if (LIMIT) groups = groups.slice(0, LIMIT)
  // 각 그룹의 active 변형
  const out = []
  for (const g of groups) {
    const { data: vs } = await sb.from('jimscanner_beseller_products').select('branduid, title, variant_label, supply_price, min_sell_price, thumb_url, detail_images, origin, cate_label, tax_note, status')
      .eq('group_key', g.group_key).eq('status', 'active').gt('supply_price', 0).order('supply_price', { ascending: true })
    if (vs && vs.length) out.push({ g, variants: vs })
  }
  return out
}

// ── 등록 ──
async function registerGroup({ g, variants }) {
  const rep = variants[0]
  const isHealth = (rep.cate_label || '') === '건강식품'
  const leaf = resolveCategory(rep.title, rep.cate_label)
  // 이미지: 대표 = 최저옵션 썸네일, 상세 = 합집합 detail_images(최대 8)
  const repUrl = await uploadOne(rep.thumb_url)
  const detailSrc = [...new Set(variants.flatMap((v) => v.detail_images || []))].slice(0, 8)
  const detailUrls = []
  for (const u of detailSrc) { const r = await uploadOne(u); if (r) detailUrls.push(r) }
  const finalRep = repUrl || detailUrls[0]
  if (!finalRep) return { ok: false, reason: '이미지 업로드 실패' }
  const detailHtml = `<div>${(detailUrls.length ? detailUrls : [finalRep]).map((u) => `<p><img src="${u}" alt="상품 상세이미지"></p>`).join('\n')}<p style="margin-top:16px;padding:10px;font-size:12px;color:#888;line-height:1.6;border-top:1px solid #eee">판매업소 : 더모어커머스 · 원산지/구성/유통기한 등 자세한 정보는 상세 이미지를 참고해 주세요.</p></div>`

  // 옵션 구성 (라벨 중복 제거). 네이버 옵션명 금지문자 \ * ? " < > 제거(*는 x로).
  const cleanLabel = (s) => (s || '기본').replace(/\*/g, 'x').replace(/[\\?"<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 25) || '기본'
  const pricedAll = variants.map((v) => ({ ...v, sell: sellOf(v.supply_price, v.min_sell_price), label: cleanLabel(v.variant_label || v.title) }))
  const usedLabel = new Set()
  for (const p of pricedAll) { let lb = p.label, n = 2; while (usedLabel.has(lb)) lb = `${p.label} (${n++})`; p.label = lb; usedLabel.add(lb) }
  // 네이버 옵션가 = base의 ±50% 이내 + 옵션가 0원 옵션 1개 필수 → base는 실제 옵션가여야 함(그 옵션 델타=0).
  // 실제 옵션가를 base 후보로 순회, 밴드[±50%] 커버리지 최대화. 밴드 밖 옵션은 제외.
  const sells = pricedAll.map((p) => p.sell)
  const minSell = Math.min(...sells)
  let bestBase = minSell, bestKept = [], bestScore = -1
  for (const cand of sells) {
    const kept = pricedAll.filter((p) => p.sell >= cand * 0.5 && p.sell <= cand * 1.5)
    // 경쟁력의 근거인 최저옵션 포함을 최우선, 그다음 커버리지 최대
    const score = (kept.some((p) => p.sell === minSell) ? 1000 : 0) + kept.length
    if (score > bestScore || (score === bestScore && cand < bestBase)) { bestBase = cand; bestKept = kept; bestScore = score }
  }
  const base = bestBase
  const priced = bestKept.length ? bestKept : [pricedAll[0]]
  const dropped = pricedAll.filter((p) => !priced.includes(p))
  const groupName = optionGroupName(priced.map((p) => p.label))
  const optionCombinations = priced.map((p) => ({ optionName1: p.label, stockQuantity: 5, price: p.sell - base, usable: true }))
  const optionMap = Object.fromEntries(priced.map((p) => [p.label, { branduid: p.branduid, supply: p.supply_price, sell: p.sell }]))

  const single = priced.length === 1
  const optionInfo = single
    ? { simpleOptionSortType: 'CREATE', optionSimple: [], optionCustom: [], optionCombinationSortType: 'CREATE', standardOptionGroups: [], optionStandards: [], useStockManagement: true, optionDeliveryAttributes: [] }
    : { optionCombinationSortType: 'CREATE', optionCombinationGroupNames: { optionGroupName1: groupName }, optionCombinations, useStockManagement: true }

  const brand = ((rep.title || '').split(/\s+/)[0] || '비셀러').replace(/[\\*?"<>()[\]]/g, '').trim().slice(0, 20) || '비셀러'
  const originContent = rep.origin ? rep.origin.slice(0, 30) : '상세설명 참조'
  const payload = {
    originProduct: {
      statusType: 'SALE', saleType: 'NEW', leafCategoryId: leaf, name: seoName(rep.title, g.group_key), detailContent: detailHtml,
      images: { representativeImage: { url: finalRep }, optionalImages: detailUrls.slice(0, 9).map((u) => ({ url: u })) },
      salePrice: base, stockQuantity: 5,
      deliveryInfo: { deliveryType: 'DELIVERY', deliveryAttributeType: 'NORMAL', deliveryCompany: 'CJGLS', deliveryBundleGroupUsable: true, deliveryBundleGroupId: BUNDLE_GROUP, deliveryFee: { deliveryFeeType: 'FREE', baseFee: 0 }, claimDeliveryInfo: { returnDeliveryCompanyPriorityType: 'PRIMARY', returnDeliveryFee: 3000, exchangeDeliveryFee: 6000, shippingAddressId: SHIP_ADDR, returnAddressId: RETURN_ADDR, freeReturnInsuranceYn: false }, installationFee: false },
      detailAttribute: {
        naverShoppingSearchInfo: { manufacturerName: brand, brandName: brand, catalogMatchingYn: false },
        afterServiceInfo: { afterServiceTelephoneNumber: CONTACT, afterServiceGuideContent: '네이버 톡톡이나 문의 글 남겨주시면 빠르게 처리 도와드리겠습니다.' },
        originAreaInfo: { originAreaCode: '03', content: originContent, plural: false },
        unitCapacity: { unitPriceYn: false }, // 가격표시제 대상 카테고리(축산/농산) 필수
        optionInfo,
        purchaseReviewInfo: { purchaseReviewExposure: true }, taxType: 'TAX', certificationTargetExcludeContent: { greenCertifiedProductExclusionYn: true }, sellerCommentUsable: false, minorPurchasable: true,
        productInfoProvidedNotice: buildNotice(isHealth), itselfProductionProductYn: false,
      },
    },
    smartstoreChannelProduct: { storeKeepExclusiveProduct: false, naverShoppingRegistration: true, channelProductDisplayStatusType: EXPOSE ? 'ON' : 'SUSPENSION' },
  }

  if (DRY) { writeFileSync(path.join(__dirname, '..', `_tmp_beseller_reg_${g.group_key.slice(0, 20).replace(/\W/g, '_')}.json`), JSON.stringify({ payload, optionMap }, null, 2)); return { ok: true, dry: true, leaf, base, options: priced.length } }
  const res = await naverApi('POST', '/v2/products', payload)
  const ok = res.status === 200 && res.body?.originProductNo
  if (ok) {
    await sb.from('jimscanner_naver_listings').upsert({
      origin_product_no: res.body.originProductNo, channel_product_no: res.body.smartstoreChannelProductNo,
      source: 'beseller', source_goods_no: g.group_key, leaf_category_id: leaf, name: payload.originProduct.name,
      sale_price: base, status_type: EXPOSE ? 'SALE' : 'SUSPENSION', rep_image_url: finalRep, seller_tags: null,
      request_payload: { option_map: optionMap, group_key: g.group_key, margin: MARGIN }, last_response: res.body, registered_at: new Date().toISOString(),
    }, { onConflict: 'origin_product_no' })
  }
  return { ok, originProductNo: res.body?.originProductNo, leaf, base, options: priced.length, reason: ok ? null : JSON.stringify({ m: res.body?.message, inv: res.body?.invalidInputs }).slice(0, 700) }
}

// ── main ──
await loadLeaves()
console.log(`식품 leaf ${FOOD_LEAVES.length}개 로드`)
// 이미 등록된 group_key skip
const { data: done } = await sb.from('jimscanner_naver_listings').select('source_goods_no').eq('source', 'beseller')
const doneSet = new Set((done || []).map((r) => r.source_goods_no))
const targets = (await loadTargets()).filter((t) => ONE_GROUP || !doneSet.has(t.g.group_key))
console.log(`=== 비셀러→네이버 등록 ${DRY ? '[DRY]' : ''} | ${EXPOSE ? 'ON(노출)' : 'SUSPENSION(비노출)'} | 대상 ${targets.length}그룹 | 마진 ${(MARGIN * 100).toFixed(0)}% ===\n`)

let ok = 0, fail = 0
for (let i = 0; i < targets.length; i++) {
  const t = targets[i]
  try {
    const r = await registerGroup(t)
    if (r.ok) { ok++; console.log(`[${i + 1}/${targets.length}] ✓ ${t.g.group_key.slice(0, 26).padEnd(26)} | cat ${r.leaf} | base ${r.base?.toLocaleString()} | 옵션 ${r.options} ${r.dry ? '(dry)' : `| origin ${r.originProductNo}`}`) }
    else { fail++; console.log(`[${i + 1}/${targets.length}] ✗ ${t.g.group_key.slice(0, 26)} | ${r.reason}`) }
  } catch (e) { fail++; console.log(`[${i + 1}/${targets.length}] ✗ ${t.g.group_key} ERROR ${e.message}`) }
  await sleep(500)
}
console.log(`\n=== 완료: 성공 ${ok} / 실패 ${fail} ===`)
