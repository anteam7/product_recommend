/**
 * 로컬 자동주문 헬퍼 서버 — 주문관리 페이지의 "결제진행" 링크가 호출한다.
 * ggsan 주문서를 Playwright로 자동 작성하고 **결제 직전에 멈춘다**(실결제는 사람이).
 *
 * 실행(PC에 상주): node --env-file=.env.local scripts/order-server.mjs
 * 보안: 127.0.0.1 만 바인드. 결제하기 버튼은 절대 누르지 않음(브라우저를 열어둠).
 *
 * 흐름: 관리자 페이지 [결제진행] → http://127.0.0.1:39201/order?id=<order_id> (새 탭, 확인페이지)
 *       → [결제진행 시작] → /run?id= → Playwright(chrome) 띄워 로그인→상품→바로구매→수령인 입력→정지
 */
import http from 'node:http'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { createClient } from '@supabase/supabase-js'
import { naverApi } from './lib/naver-api.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const env = Object.fromEntries(
  readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8').split(/\r?\n/).filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => { const i = l.indexOf('='); let v = l.slice(i + 1).trim(); if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1); return [l.slice(0, i).trim(), v] }),
)
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY)
const PORT = Number(env.ORDER_SERVER_PORT || 39201)
const BASE = env.GGSAN_BASE_URL || 'https://www.ggsan.com'
const esc = (s) => String(s ?? '').replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]))

// 자동주문 지원 매입처 (listings.source → 표시명)
const SUPPORTED_SOURCES = { ggsan: '건강산', upickb2b: '유픽B2B' }

// 주문 → 매입처(source) + goods_no + 수령인 해석
// id 자동 판별: 쿠팡 order_id 우선 → 없으면 네이버 product_order_id (체계가 달라 충돌 없음)
async function resolveOrder(orderId) {
  const { data: o } = await sb.from('jimscanner_coupang_orders')
    .select('*') // supplier_source/supplier_goods_no(오버라이드 컬럼)가 아직 없는 DB에서도 죽지 않게 명시 select 대신 * (없으면 undefined → 폴백)
    .eq('order_id', orderId).single()
  if (!o) return resolveNaverOrder(orderId)
  // 주문별 매입처 오버라이드(supplier_source/supplier_goods_no 둘 다 존재 시) 우선 — "이 주문에 한해서" 매입처 변경(네이버 resolveNaverOrder와 동일 규칙).
  // 오버라이드 시 listing의 detail_url·dome_price는 다른 상품 것이라 쓰지 않는다(금액 가드는 고객 결제액 기준만).
  const override = !!(o.supplier_source && o.supplier_goods_no)
  const { data: L } = override
    ? { data: null }
    : await sb.from('jimscanner_coupang_listings').select('source, source_goods_no, source_detail_url, dome_price_krw').eq('seller_product_id', o.seller_product_id).limit(1)
  const src = override ? o.supplier_source : (L?.[0]?.source || 'ggsan') // 구버전 listing은 source 미기록 → ggsan 간주
  if (!SUPPORTED_SOURCES[src]) return { error: `자동주문 미지원 매입처(${src}) — 해당 매입처에서 직접 주문하세요`, order: o }
  const goodsNo = override ? o.supplier_goods_no : L?.[0]?.source_goods_no
  if (!goodsNo) return { error: '매입처 미연결 — 이 주문 상품의 listing에 source_goods_no가 없습니다', order: o }
  const rc = o.raw_payload?.receiver || {}
  const recipient = { name: rc.name || '', zip: rc.postCode || '', addr1: rc.addr1 || '', addr2: rc.addr2 || '', phone: rc.safeNumber || rc.receiverNumber || '' }
  if (!recipient.name || !recipient.addr1) return { error: '수령인 주소 정보가 부족합니다(raw_payload.receiver)', order: o }
  const qty = o.shipping_count || 1
  return {
    order: o, source: src, sourceLabel: SUPPORTED_SOURCES[src], goodsNo, detailUrl: L?.[0]?.source_detail_url || null, recipient,
    kind: 'coupang', dbKey: o.order_id,
    paidAmount: o.paid_amount ?? o.order_price ?? null,                       // 고객 결제액(금액 가드 기준)
    domeCost: L?.[0]?.dome_price_krw ? L[0].dome_price_krw * qty : null,      // 예상 공급가 합
  }
}

// 네이버 주문(product_order_id) 해석 — raw_payload 는 { content: { order, productOrder } } 중첩 구조
async function resolveNaverOrder(orderId) {
  const { data: n } = await sb.from('jimscanner_naver_orders')
    .select('product_order_id, origin_product_no, product_name, option_name, quantity, raw_payload, purchase_status, supplier_source, supplier_goods_no, total_payment_amount')
    .eq('product_order_id', String(orderId)).single()
  if (!n) return { error: `주문 #${orderId} 을(를) 찾을 수 없습니다 (쿠팡·네이버 모두 없음)` }
  const order = { product_name: n.product_name, option_name: n.option_name, shipping_count: n.quantity ?? 1 }
  // 주문별 매입처 오버라이드(둘 다 존재 시) 우선 — "이 주문에 한해서" 매입처 변경 지원. 없으면 listing 매칭 폴백
  let src = null, goodsNo = null
  if (n.supplier_source && n.supplier_goods_no) {
    src = n.supplier_source
    goodsNo = n.supplier_goods_no
  } else {
    const { data: L } = await sb.from('jimscanner_naver_listings').select('source, source_goods_no').eq('origin_product_no', n.origin_product_no).limit(1)
    src = L?.[0]?.source
    goodsNo = L?.[0]?.source_goods_no
  }
  if (!SUPPORTED_SOURCES[src]) return { error: `자동주문 미지원 매입처(${src || '미연결'}) — 해당 매입처에서 직접 주문하세요`, order }
  if (!goodsNo) return { error: '매입처 미연결 — 이 주문 상품의 listing에 source_goods_no가 없습니다', order }
  const sa = n.raw_payload?.content?.productOrder?.shippingAddress || {}
  const recipient = { name: sa.name || '', zip: sa.zipCode || '', addr1: sa.baseAddress || '', addr2: sa.detailedAddress || '', phone: sa.tel1 || '' }
  if (!recipient.name || !recipient.addr1) return { error: '수령인 주소 정보가 부족합니다(raw_payload.content.productOrder.shippingAddress)', order }
  return {
    order, source: src, sourceLabel: SUPPORTED_SOURCES[src], goodsNo, detailUrl: null, recipient,
    kind: 'naver', dbKey: n.product_order_id,
    paidAmount: n.total_payment_amount ?? null, domeCost: null,
  }
}

// 세금계산서 발행용 사업자 정보 (결제진행 자동주문 시 주문서에 입력). 더모어커머스.
const BIZ_INFO = {
  busiNo: '6072286441', company: '더모어커머스', ceo: '안승혁',
  service: '소매업', item: '전자상거래',
  zip: '08368', addr1: '서울특별시 구로구 항동로 72(항동, 하버라인 4단지)', addr2: '404-601',
}

// ggsan 일반결제(무통장입금) 자동선택값 — 입금자명은 사업자 대표명(BIZ_INFO.ceo) 재사용(신규 PII 미도입),
// 입금은행은 공개 은행명 키워드로 매칭(계좌번호는 주문서 드롭다운에서 선택, 소스 미저장).
const GGSAN_DEPOSIT = { depositorName: BIZ_INFO.ceo, bankKeyword: '국민은행' }

// 보이는 Chrome 띄우기 (결제는 사람이 — 브라우저는 닫지 않음)
// onDialog 미지정 시 모든 대화상자 수락
async function openBrowser(onDialog) {
  let chromium
  try { ({ chromium } = await import('playwright')) } catch { ({ chromium } = await import('playwright-core')) }
  const browser = await chromium.launch({ channel: 'chrome', headless: false })
  const ctx = await browser.newContext()
  ctx.on('dialog', (d) => { try { (onDialog ? onDialog(d) : d.accept()).catch(() => {}) } catch { /* noop */ } })
  const page = await ctx.newPage()
  return { ctx, page }
}

// 완주 모드 공통: 총액 파싱 실패/금액 가드 초과 시 중단(브라우저 열어둠 = 기존 정지 동작으로 폴백)
function guardFail(kind, total, maxPay) {
  if (total == null) return `총 결제금액 파싱 실패 — 완주 중단. 열린 ${kind} 창에서 금액 확인 후 직접 결제하세요`
  if (total > maxPay) return `금액 가드 발동: 주문서 총액 ${total.toLocaleString()}원 > 허용 상한 ${Math.round(maxPay).toLocaleString()}원 — 완주 중단(장바구니 합산/수량 이상 여부를 열린 창에서 확인)`
  return null
}

// Playwright: ggsan 주문서 자동 작성 → 결제 직전 정지 (브라우저 열어둠) / full 지정 시 무통장 결제 완주
async function runFlowGgsan(goodsNo, qty, recipient, full = null) {
  const { ctx, page } = await openBrowser()
  if (full) full.ctxRef = ctx   // 원격 잡이 완료 후 브라우저를 닫을 수 있게

  // 1) 로그인
  await page.goto(`${BASE}/member/login.php`, { waitUntil: 'domcontentloaded', timeout: 30000 })
  await page.fill('input[name=loginId]', env.GGSAN_USER)
  await page.fill('input[name=loginPwd]', env.GGSAN_PASS)
  await Promise.all([
    page.waitForNavigation({ timeout: 15000 }).catch(() => {}),
    page.evaluate(() => { const f = document.querySelector('input[name=loginPwd]')?.form; if (f) (f.requestSubmit ? f.requestSubmit() : f.submit()) }),
  ])
  await page.waitForTimeout(1500)
  if (!(await page.evaluate(() => /로그아웃|LOGOUT/i.test(document.body.innerText)))) return { ok: false, msg: 'ggsan 로그인 실패 — 자격증명 확인 필요' }
  // 2) 상품 페이지 + 수량
  await page.goto(`${BASE}/goods/goods_view.php?goodsNo=${goodsNo}`, { waitUntil: 'domcontentloaded', timeout: 30000 })
  await page.waitForTimeout(1000)
  if (qty > 1) await page.evaluate((q) => { const el = document.querySelector('input[name^="goodsCnt"]'); if (el) { el.value = String(q); el.dispatchEvent(new Event('change', { bubbles: true })) } }, qty)
  // 3) 바로구매 (보이지 않을 수 있어 JS 클릭)
  await page.evaluate(() => { const b = [...document.querySelectorAll('.btn_shop_buy, a, button, input')].find((x) => /바로구매/.test(x.innerText || x.value || '')); if (b) { b.scrollIntoView({ block: 'center' }); b.click() } })
  await page.waitForTimeout(3500)
  const op = ctx.pages().find((p) => /\/order\/order\.php/.test(p.url())) || page
  if (!/\/order\//.test(op.url())) return { ok: false, msg: '주문서로 이동 실패 — 품절/옵션 필요 여부 확인' }
  // 4) 배송지=직접입력 + 수령인 입력 (readonly 대비 JS set)
  await op.evaluate(({ rcp, biz, dep }) => {
    const set = (n, v) => { const el = document.querySelector(`[name="${n}"]`); if (el) { el.removeAttribute('readonly'); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })) } }
    // 배송지=직접입력 + 수령인
    const rs = [...document.querySelectorAll('input[name=shipping]')]
    const t = rs.find((r) => /신규|새로운|직접/.test((document.querySelector(`label[for="${r.id}"]`)?.innerText) || r.parentElement?.innerText || ''))
    if (t) { t.checked = true; t.click(); t.dispatchEvent(new Event('change', { bubbles: true })) }
    set('receiverName', rcp.name); set('receiverZonecode', rcp.zip); set('receiverAddress', rcp.addr1); set('receiverAddressSub', rcp.addr2); set('receiverCellPhone', rcp.phone)
    // 현금영수증/계산서 → 세금계산서 선택 + 사업자 정보 입력
    let taxRadio = document.querySelector('input[name=receiptFl][value="t"]')
    if (!taxRadio) taxRadio = [...document.querySelectorAll('input[name=receiptFl]')].find((r) => /세금계산서/.test((document.querySelector(`label[for="${r.id}"]`)?.innerText) || r.parentElement?.innerText || ''))
    if (taxRadio) { taxRadio.checked = true; taxRadio.click(); taxRadio.dispatchEvent(new Event('change', { bubbles: true })) }
    set('taxBusiNo', biz.busiNo); set('taxCompany', biz.company); set('taxCeoNm', biz.ceo)
    set('taxService', biz.service); set('taxItem', biz.item)
    set('taxZonecode', biz.zip); set('taxAddress', biz.addr1); set('taxAddressSub', biz.addr2)
    // 결제수단 = 일반결제(무통장입금) + 입금자명 + 입금은행 선택
    let payRadio = document.querySelector('input[name=settleKind][value="gb"]')
    if (!payRadio) payRadio = [...document.querySelectorAll('input[name=settleKind]')].find((r) => /무통장|일반결제/.test((document.querySelector(`label[for="${r.id}"]`)?.innerText) || r.parentElement?.innerText || ''))
    if (payRadio && !payRadio.checked) { payRadio.checked = true; payRadio.click(); payRadio.dispatchEvent(new Event('change', { bubbles: true })) }
    set('bankSender', dep.depositorName) // 입금자명
    // 입금은행: 국민은행(건강산) 계좌 옵션 선택 (계좌번호는 옵션 text에서 매칭, 소스 미저장)
    const bankSel = document.querySelector('select[name=bankAccount]')
    if (bankSel) {
      const opt = [...bankSel.options].find((o) => o.value && o.text.includes(dep.bankKeyword))
      if (opt) { bankSel.value = opt.value; bankSel.dispatchEvent(new Event('change', { bubbles: true })) }
    }
  }, { rcp: recipient, biz: BIZ_INFO, dep: GGSAN_DEPOSIT })
  await op.bringToFront().catch(() => {})
  if (!full) {
    // 브라우저는 닫지 않는다 — 사장님이 금액 확인 후 결제하기
    return { ok: true, msg: '주문서 작성 완료 — 열린 ggsan 창에서 금액·배송지 확인 후 [결제하기]를 직접 누르세요' }
  }

  // ── 완주(무통장): 동의 체크 → 금액 가드 → 결제하기 → 완료페이지 주문번호 파싱 ──
  // 무통장입금이라 [결제하기] = 주문 생성(입금대기)일 뿐 출금 없음. 입금은 사장님이 직접.
  await op.evaluate(() => { const c = document.querySelector('#termAgree_orderCheck'); if (c && !c.checked) c.click() })
  const total = await op.evaluate(() => {
    // 1순위: godomall 내부 정산가 hidden(가장 견고) — 프로브로 확인(settlePrice=상품+배송)
    const hid = document.querySelector('input[name=settlePrice]')
    if (hid && /^\d+$/.test(hid.value) && +hid.value > 0) return +hid.value
    // 2순위: 본문 표기 — ggsan은 "최종 결제 금액 17,000원" 형식
    const text = document.body.innerText
    for (const re of [/최종\s*결제\s*금액[^0-9]{0,40}([\d,]{4,})\s*원/, /총\s*결제\s*금액[^0-9]{0,40}([\d,]{4,})\s*원/, /합\s*계[^0-9]{0,40}([\d,]{4,})\s*원/]) {
      const m = re.exec(text)
      if (m) return parseInt(m[1].replace(/,/g, ''))
    }
    return null
  }).catch(() => null)
  const g = guardFail('ggsan', total, full.maxPay)
  if (g) return { ok: false, msg: g }
  // 결제수단이 무통장(gb)으로 선택돼 있을 때만 클릭 (카드/PG 자동결제 금지)
  const isCash = await op.evaluate(() => document.querySelector('input[name=settleKind][value="gb"]')?.checked === true)
  if (!isCash) return { ok: false, msg: '결제수단이 무통장입금이 아님 — 완주 중단(열린 창에서 직접 진행)' }
  await op.evaluate(() => { const b = document.querySelector('button.btn_order_buy'); if (b) { b.scrollIntoView({ block: 'center' }); b.click() } })
  const done = await op.waitForURL(/order_end|orderEnd/i, { timeout: 45000 }).then(() => true).catch(() => false)
  await op.waitForTimeout(1500)
  const orderNo = await op.evaluate(() => {
    const q = new URL(location.href).searchParams.get('orderNo') || new URL(location.href).searchParams.get('ordNo')
    if (q) return q
    const m = /주문\s*번호[^\d]{0,12}(\d{8,20})/.exec(document.body.innerText)
    return m ? m[1] : null
  }).catch(() => null)
  if (!done && !orderNo) return { ok: false, msg: '결제하기 이후 완료 페이지 확인 실패 — 열린 ggsan 창에서 주문 상태를 직접 확인하세요' }
  return { ok: true, done: true, orderNo, total, msg: `무통장 주문 완료 — 주문번호 ${orderNo ?? '(파싱 실패, 창에서 확인)'} · 총액 ${total.toLocaleString()}원 · 입금대기` }
}

// Playwright: upickb2b(Cafe24) 주문서 자동 작성 → 결제 직전 정지 (브라우저 열어둠)
// 필드 구조는 scripts/_upick-order-probe.mjs 정찰 결과 기준 (Cafe24 표준 orderform)
const UPICK_BASE = env.UPICKB2B_BASE_URL || 'https://upickb2b.com'
async function runFlowUpick(goodsNo, qty, recipient, detailUrl, full = null) {
  // "동일상품이 장바구니에 N개 있습니다. 함께 구매하시겠습니까?" → 취소(현재 선택 수량만) — 수락하면 잔여 장바구니가 합산됨
  const { ctx, page } = await openBrowser((d) => (/함께 구매/.test(d.message()) ? d.dismiss() : d.accept()))
  if (full) full.ctxRef = ctx   // 원격 잡이 완료 후 브라우저를 닫을 수 있게

  // 1) 로그인 (Cafe24: member_id / member_passwd)
  await page.goto(`${UPICK_BASE}/member/login.html`, { waitUntil: 'domcontentloaded', timeout: 30000 })
  await page.fill('input[name=member_id]', env.UPICKB2B_USER)
  await page.fill('input[name=member_passwd]', env.UPICKB2B_PASS)
  await Promise.all([
    page.waitForNavigation({ timeout: 15000 }).catch(() => {}),
    page.evaluate(() => { const f = document.querySelector('input[name=member_passwd]')?.form; if (f) (f.requestSubmit ? f.requestSubmit() : f.submit()) }),
  ])
  await page.waitForTimeout(1500)
  if (/member\/login/.test(page.url())) return { ok: false, msg: 'U-PICK 로그인 실패 — 자격증명 확인 필요' }
  // 2) 상품 페이지 + 수량
  await page.goto(detailUrl || `${UPICK_BASE}/product/x/${goodsNo}/category/1/display/1/`, { waitUntil: 'domcontentloaded', timeout: 30000 })
  await page.waitForTimeout(1200)
  if (qty > 1) await page.evaluate((q) => { const el = document.querySelector('input#quantity, input[name="quantity_opt[]"]'); if (el) { el.value = String(q); el.dispatchEvent(new Event('change', { bubbles: true })); el.dispatchEvent(new Event('blur', { bubbles: true })) } }, qty)
  // 3) BUY IT NOW → 주문서
  await page.evaluate(() => { const b = [...document.querySelectorAll('a.btnSubmit, button, input')].find((x) => /^BUY IT NOW$/.test((x.innerText || x.value || '').trim())); if (b) { b.scrollIntoView({ block: 'center' }); b.click() } })
  await page.waitForTimeout(5000)
  const op = ctx.pages().find((p) => /\/order\/orderform/.test(p.url())) || page
  if (!/\/order\/orderform/.test(op.url())) return { ok: false, msg: '주문서로 이동 실패 — 품절/옵션 필요 여부 확인' }
  // 4) 수령인: "주문자 정보와 동일" 해제 → Cafe24 클리어 핸들러가 비동기로 필드를 비우므로
  //    반드시 0.8초 기다린 뒤 입력 (해제 직후 바로 넣으면 전부 지워짐 — _upick-order-probe2 검증)
  const same = op.locator('#sameaddr0')
  if (await same.isChecked().catch(() => false)) { await same.click({ force: true }); await op.waitForTimeout(800) }
  const fillIf = async (sel, v) => { const l = op.locator(sel).first(); if (await l.count()) { await l.evaluate((el) => el.removeAttribute('readonly')); await l.fill(v).catch(() => {}) } }
  await fillIf('#rname', recipient.name)
  await fillIf('#rzipcode1', recipient.zip)
  await fillIf('#raddr1', recipient.addr1)
  await fillIf('#raddr2', recipient.addr2)
  await fillIf('#rphone1_', recipient.phone)
  // 세금계산서 신청(개인사업자) + 사업자 정보 (readonly 대비 JS set)
  await op.evaluate((biz) => {
    const set = (sel, v) => { const el = document.querySelector(sel); if (el) { el.removeAttribute('readonly'); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })) } }
    const tx = document.querySelector('#tax_request_regist0'); if (tx && !tx.checked) tx.click()
    const ty = document.querySelector('#tax_request_company_type0'); if (ty && !ty.checked) ty.click()
    set('#tax_request_company_regno', biz.busiNo); set('#tax_request_company_name', biz.company); set('#tax_request_president_name', biz.ceo)
    set('#tax_request_company_condition', biz.service); set('#tax_request_company_line', biz.item)
    set('#tax_request_zipcode', biz.zip); set('#tax_request_address1', biz.addr1); set('#tax_request_address2', biz.addr2)
    set('#tax_request_name', biz.ceo)
  }, BIZ_INFO)
  // 주문자 휴대전화 → 업무 연락처로 교체 (.env.local ORDER_CONTACT_PHONE, 2026-07-06 사용자 지정)
  if (env.ORDER_CONTACT_PHONE) {
    await op.evaluate((ph) => {
      const el = document.querySelector('#ophone1_, input[name=ophone1_], input[name=ophone1]')
      if (el) { el.removeAttribute('readonly'); el.value = ph; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })) }
    }, env.ORDER_CONTACT_PHONE.replace(/^(\d{3})(\d{3,4})(\d{4})$/, '$1-$2-$3'))
  }
  await op.bringToFront().catch(() => {})
  if (!full) return { ok: true, msg: '주문서 작성 완료 — 열린 U-PICK 창에서 금액·배송지·결제수단 확인 후 [결제하기]를 직접 누르세요' }

  // ── 완주(무통장): 무통장 확인 → 국민은행 + 입금자명 → 약관 전체동의 → 금액 가드 → 결제하기(2단) → 주문번호 파싱 ──
  const isCash = await op.evaluate(() => {
    const cash = document.querySelector('input[name=addr_paymethod][value=cash]')
    if (cash && !cash.checked) { cash.checked = true; cash.click(); cash.dispatchEvent(new Event('change', { bubbles: true })) }
    return cash ? cash.checked : false
  })
  if (!isCash) return { ok: false, msg: '무통장입금 결제수단을 찾지 못함 — 완주 중단(열린 창에서 직접 진행)' }
  await op.waitForTimeout(600)
  await op.evaluate((dep) => {
    // 입금은행(국민은행) + 입금자명
    const sel = document.querySelector('select#bankaccount')
    if (sel) { const o = [...sel.options].find((x) => x.value && x.text.includes(dep.bankKeyword)); if (o) { sel.value = o.value; sel.dispatchEvent(new Event('change', { bubbles: true })) } }
    const pn = document.querySelector('#pname, input[name=pname]')
    if (pn) { pn.value = dep.depositorName; pn.dispatchEvent(new Event('input', { bubbles: true })); pn.dispatchEvent(new Event('change', { bubbles: true })) }
    // 약관 전체동의
    const all = document.querySelector('#allAgree')
    if (all && !all.checked) all.click()
  }, GGSAN_DEPOSIT)
  await op.waitForTimeout(600)
  // 전체동의가 못 채운 [필수] 잔여 개별 체크
  await op.evaluate(() => {
    for (const c of document.querySelectorAll('input[type=checkbox]')) {
      const lab = (document.querySelector(`label[for="${c.id}"]`)?.innerText || c.parentElement?.innerText || '')
      if (/\[필수\]/.test(lab) && !c.checked) c.click()
    }
  })
  const total = await op.evaluate(() => {
    const b = document.querySelector('#btn_payment')
    const m = /([\d,]{3,})\s*원/.exec(b?.innerText || '')
    if (m) return parseInt(m[1].replace(/,/g, ''))
    const m2 = /총\s*결제\s*금액[^0-9]{0,30}([\d,]{3,})\s*원/.exec(document.body.innerText)
    return m2 ? parseInt(m2[1].replace(/,/g, '')) : null
  }).catch(() => null)
  const g = guardFail('U-PICK', total, full.maxPay)
  if (g) return { ok: false, msg: g }
  await op.evaluate(() => document.querySelector('#btn_payment')?.click())
  await op.waitForTimeout(1800)
  // Cafe24 확인 레이어(같은 금액의 결제하기 버튼)가 뜨면 한 번 더
  await op.evaluate(() => { const b = document.querySelector('#ec-shop_btn_layer_payment'); if (b && b.offsetParent !== null) b.click() }).catch(() => {})
  const done = await op.waitForURL(/order_result/i, { timeout: 45000 }).then(() => true).catch(() => false)
  await op.waitForTimeout(1500)
  const orderNo = await op.evaluate(() => {
    const q = new URL(location.href).searchParams.get('order_id')
    if (q) return q
    const m = /주문\s*번호[^\d]{0,12}(\d{8}-\d{6,9})/.exec(document.body.innerText)
    return m ? m[1] : null
  }).catch(() => null)
  if (!done && !orderNo) return { ok: false, msg: '결제하기 이후 완료 페이지 확인 실패 — 열린 U-PICK 창에서 주문 상태를 직접 확인하세요' }
  return { ok: true, done: true, orderNo, total, msg: `무통장 주문 완료 — 주문번호 ${orderNo ?? '(파싱 실패, 창에서 확인)'} · 총액 ${total.toLocaleString()}원 · 입금대기` }
}

// ── 결제진행 실행(공용) — /run 핸들러와 원격 큐 폴러가 같이 쓴다 ──
// fullMode=true: 무통장 완주 + 입금대기·주문번호·매입가 DB 기록. false: 직전 정지.
async function execPurchase(orderKey, fullMode) {
  const r = await resolveOrder(orderKey)
  if (r.error) return { ok: false, msg: r.error }
  let full = null
  if (fullMode) {
    // 금액 가드 상한 — 고객결제액·예상공급가 중 큰 쪽 기준(둘 다 없으면 완주 거부)
    const cands = []
    if (r.paidAmount > 0) cands.push(r.paidAmount * 1.25 + 3000)
    if (r.domeCost > 0) cands.push(r.domeCost * 1.35 + 8000)
    const maxPay = cands.length ? Math.min(Math.max(...cands), 1000000) : null
    if (!maxPay) return { ok: false, msg: '금액 가드 기준 없음(고객 결제액·공급가 미상) — 완주 불가. 직전 정지 모드로 진행 후 직접 결제하세요' }
    full = { maxPay }
  }
  const out = r.source === 'upickb2b'
    ? await runFlowUpick(r.goodsNo, r.order.shipping_count, r.recipient, r.detailUrl, full)
    : await runFlowGgsan(r.goodsNo, r.order.shipping_count, r.recipient, full)
  out.sourceLabel = r.sourceLabel
  out.ctxRef = full?.ctxRef ?? null   // 원격 잡이 완료 후 브라우저를 닫을 수 있게 노출
  // 완주 성공 → 주문상태=입금대기 + 매입처 주문번호·매입가 자동 기록
  if (out.ok && out.done) {
    const now = new Date().toISOString()
    const upd = { purchase_status: 'AWAITING_DEPOSIT', purchase_ordered_at: now, updated_at: now }
    if (out.total > 0) upd.purchase_total_cost = out.total
    if (r.kind === 'naver') {
      if (out.orderNo) upd.supplier_order_no = out.orderNo
      const { error } = await sb.from('jimscanner_naver_orders').update(upd).eq('product_order_id', r.dbKey)
      if (error) out.msg += ` (⚠ DB 기록 실패: ${error.message} — 관리자에서 수동 입력)`
    } else {
      if (out.orderNo) upd.ggsan_order_no = out.orderNo
      const { error } = await sb.from('jimscanner_coupang_orders').update(upd).eq('order_id', r.dbKey)
      if (error) out.msg += ` (⚠ DB 기록 실패: ${error.message} — 관리자에서 수동 입력)`
    }
  }
  return out
}

// ── 원격 결제진행 큐 폴러 — Vercel 어드민(모바일 등)에서 등록한 잡을 이 PC가 집어 실행 ──
// 직렬 처리(jobBusy). 서버가 죽어 running에 고착된 잡은 새 잡으로 다시 등록하면 됨.
let jobBusy = false
setInterval(async () => {
  if (jobBusy) return
  jobBusy = true
  try {
    const { data: jobs } = await sb.from('jimscanner_purchase_jobs').select('id, order_key, mode').eq('status', 'queued').order('id', { ascending: true }).limit(1)
    const job = jobs?.[0]
    if (!job) return
    await sb.from('jimscanner_purchase_jobs').update({ status: 'running', started_at: new Date().toISOString() }).eq('id', job.id)
    console.log(`[job ${job.id}] 원격 결제진행 시작 — 주문 ${job.order_key} (${job.mode})`)
    const out = await execPurchase(job.order_key, job.mode !== 'stage')
    // 완주 성공한 원격 잡은 브라우저를 닫는다(무인 PC 창 누적 방지). 실패/정지는 열어둬 귀가 후 확인.
    if (out.ok && out.done && out.ctxRef) { try { await out.ctxRef.browser()?.close() } catch { /* noop */ } }
    await sb.from('jimscanner_purchase_jobs').update({
      status: out.ok ? 'done' : 'error', result_msg: out.msg, order_no: out.orderNo ?? null, finished_at: new Date().toISOString(),
    }).eq('id', job.id)
    console.log(`[job ${job.id}] ${out.ok ? '완료' : '실패'}: ${out.msg}`)
  } catch (e) { console.error('[job-poller]', e instanceof Error ? e.message : e) } finally { jobBusy = false }
}, 4000)

const htmlPage = (res, body) => { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(`<!doctype html><html lang=ko><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><body style="font-family:system-ui,sans-serif;max-width:620px;margin:48px auto;padding:0 18px;line-height:1.6;color:#111">${body}</body></html>`) }

http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, `http://127.0.0.1:${PORT}`)
    // /health 만 CORS 허용 — HTTPS 어드민(Vercel)에서 결제진행 버튼이 서버 생존 프로브에 사용.
    // 데이터 없는 'ok' 응답이라 origin 제한 불필요. PNA(사설망 접근) preflight 대응 포함.
    if (u.pathname === '/health') {
      const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Allow-Private-Network': 'true' }
      if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return }
      res.writeHead(200, { 'Content-Type': 'text/plain', ...cors }); res.end('ok'); return
    }
    // 네이버 발주확인 — Vercel 어드민의 confirm이 IP 허용목록(GW.IP_NOT_ALLOWED)으로 실패할 때
    // 브라우저가 이 로컬 헬퍼(집 PC = 허용 IP)로 폴백 호출한다. CORS는 어드민 origin만 허용.
    if (u.pathname === '/naver-confirm') {
      const origin = req.headers.origin || ''
      const allowed = ['https://product-recommend-nine.vercel.app', 'http://localhost:3001', 'http://localhost:3000'].includes(origin)
      const cors = {
        'Access-Control-Allow-Origin': allowed ? origin : 'null',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Private-Network': 'true',
        'Content-Type': 'application/json; charset=utf-8',
      }
      if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return }
      if (!allowed || req.method !== 'POST') { res.writeHead(403, cors); res.end(JSON.stringify({ ok: false, detail: '허용되지 않은 origin/method' })); return }
      const id = String(u.searchParams.get('id') || '').trim()
      if (!/^\d{10,20}$/.test(id)) { res.writeHead(400, cors); res.end(JSON.stringify({ ok: false, detail: 'id 형식 오류' })); return }
      // DB에 존재하는 우리 주문인지 확인(임의 id 발주확인 방지)
      const { data: ord } = await sb.from('jimscanner_naver_orders').select('id, product_order_id, place_order_status').eq('product_order_id', id).single()
      if (!ord) { res.writeHead(404, cors); res.end(JSON.stringify({ ok: false, detail: '주문 없음' })); return }
      if (ord.place_order_status === 'OK') { res.writeHead(200, cors); res.end(JSON.stringify({ ok: true, detail: '이미 발주확인됨' })); return }
      const r = await naverApi('POST', '/v1/pay-order/seller/product-orders/confirm', { productOrderIds: [id] })
      const success = r.body?.data?.successProductOrderIds?.map(String)?.includes(id) ?? false
      const fail = r.body?.data?.failProductOrderInfos?.find((f) => String(f.productOrderId) === id)
      const alreadyDone = /이미.{0,10}(발주|확인)|ALREADY/i.test(fail?.message ?? '')
      if (r.status === 200 && (success || alreadyDone)) {
        await sb.from('jimscanner_naver_orders').update({ place_order_status: 'OK', updated_at: new Date().toISOString() }).eq('id', ord.id)
        res.writeHead(200, cors); res.end(JSON.stringify({ ok: true, detail: alreadyDone ? '이미 발주확인됨' : 'OK' }))
      } else {
        res.writeHead(502, cors)
        res.end(JSON.stringify({ ok: false, detail: `HTTP ${r.status} ${fail?.code ?? ''} ${fail?.message ?? JSON.stringify(r.body).slice(0, 150)}` }))
      }
      return
    }
    if (u.pathname === '/order') {
      const r = await resolveOrder(u.searchParams.get('id'))
      if (r.error) { htmlPage(res, `<h2>⚠ ${esc(r.error)}</h2><p>이 주문은 자동 진행할 수 없습니다. 매입처에서 직접 주문해 주세요.</p>`); return }
      htmlPage(res, `<h2>🛒 ${esc(r.sourceLabel)} 자동 주문 확인</h2>
        <table style="border-collapse:collapse;width:100%"><tbody>
        <tr><td style="padding:6px 8px;color:#666">상품</td><td style="padding:6px 8px"><b>${esc(r.order.product_name)}</b>${r.order.option_name ? '<br><span style="color:#888;font-size:13px">' + esc(r.order.option_name) + '</span>' : ''}</td></tr>
        <tr><td style="padding:6px 8px;color:#666">수량</td><td style="padding:6px 8px">${r.order.shipping_count}</td></tr>
        <tr><td style="padding:6px 8px;color:#666">매입처</td><td style="padding:6px 8px">${esc(r.sourceLabel)} #${esc(r.goodsNo)}</td></tr>
        <tr><td style="padding:6px 8px;color:#666">수령인</td><td style="padding:6px 8px"><b>${esc(r.recipient.name)}</b> · ${esc(r.recipient.zip)}<br>${esc(r.recipient.addr1)} ${esc(r.recipient.addr2)}<br>${esc(r.recipient.phone)}</td></tr>
        </tbody></table>
        <p style="background:#fef3c7;color:#92400e;padding:10px 12px;border-radius:8px">⚠ 두 방식 모두 <b>출금은 없습니다</b>(무통장입금). <b>완주</b>는 동의·결제하기까지 자동 진행해 주문을 생성하고 주문상태를 <b>💰입금대기</b>로 기록합니다 — 입금(이체)은 직접 하신 뒤 관리자에서 [입금완료]로 바꾸세요.</p>
        <p style="display:flex;gap:10px;flex-wrap:wrap">
        <a href="/run?id=${esc(u.searchParams.get('id'))}&mode=full" style="display:inline-block;background:#059669;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600">💳 결제 완주 (무통장 주문완료 + 입금대기 기록)</a>
        <a href="/run?id=${esc(u.searchParams.get('id'))}" style="display:inline-block;background:#2563eb;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600">결제 직전까지만 (직접 결제)</a></p>`)
      return
    }
    if (u.pathname === '/run') {
      const out = await execPurchase(u.searchParams.get('id'), u.searchParams.get('mode') === 'full')
      htmlPage(res, out.ok
        ? (out.done
          ? `<h2>✓ ${esc(out.msg)}</h2><p style="background:#fef3c7;color:#92400e;padding:10px 12px;border-radius:8px">💰 관리자 주문상태가 <b>입금대기</b>로 기록됐습니다. <b>${esc(GGSAN_DEPOSIT.bankKeyword)} 계좌로 이체</b>한 뒤 관리자에서 <b>[입금완료]</b>를 눌러주세요.</p>`
          : `<h2>✓ ${esc(out.msg)}</h2><p>열린 ${esc(out.sourceLabel ?? '매입처')} 창으로 가서 결제를 마치세요. 이 탭은 닫으셔도 됩니다.</p>`)
        : `<h2>✗ ${esc(out.msg)}</h2><p>다시 시도하거나 매입처에서 직접 주문하세요.</p>`)
      return
    }
    htmlPage(res, `<h2>주문 자동화 헬퍼 가동 중</h2><p>관리자 페이지의 <b>결제진행</b> 버튼으로 호출됩니다. (포트 ${PORT})</p>`)
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(`<body style="font-family:sans-serif"><h2>✗ 서버 오류: ${esc(e instanceof Error ? e.message : e)}</h2>`)
  }
}).listen(PORT, '127.0.0.1', () => console.log(`order-server 가동: http://127.0.0.1:${PORT}  (결제진행 버튼이 호출)`))
