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

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const env = Object.fromEntries(
  readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8').split(/\r?\n/).filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => { const i = l.indexOf('='); let v = l.slice(i + 1).trim(); if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1); return [l.slice(0, i).trim(), v] }),
)
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY)
const PORT = Number(env.ORDER_SERVER_PORT || 39201)
const BASE = env.GGSAN_BASE_URL || 'https://www.ggsan.com'
const esc = (s) => String(s ?? '').replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]))

// 주문 → ggsan goods_no + 수령인 해석
async function resolveOrder(orderId) {
  const { data: o } = await sb.from('jimscanner_coupang_orders')
    .select('order_id, seller_product_id, product_name, option_name, shipping_count, raw_payload, purchase_status')
    .eq('order_id', orderId).single()
  if (!o) return { error: `주문 #${orderId} 을(를) 찾을 수 없습니다` }
  const { data: L } = await sb.from('jimscanner_coupang_listings').select('source, source_goods_no').eq('seller_product_id', o.seller_product_id).limit(1)
  const src = L?.[0]?.source
  if (src && src !== 'ggsan') return { error: `ggsan 매입 상품이 아닙니다 (매입처: ${src}) — 해당 매입처에서 직접 주문하세요`, order: o }
  const goodsNo = L?.[0]?.source_goods_no
  if (!goodsNo) return { error: '매입처(ggsan) 미연결 — 이 주문 상품의 listing에 source_goods_no가 없습니다', order: o }
  const rc = o.raw_payload?.receiver || {}
  const recipient = { name: rc.name || '', zip: rc.postCode || '', addr1: rc.addr1 || '', addr2: rc.addr2 || '', phone: rc.safeNumber || rc.receiverNumber || '' }
  if (!recipient.name || !recipient.addr1) return { error: '수령인 주소 정보가 부족합니다(raw_payload.receiver)', order: o }
  return { order: o, goodsNo, recipient }
}

// 세금계산서 발행용 사업자 정보 (결제진행 자동주문 시 주문서에 입력). 더모어커머스.
const BIZ_INFO = {
  busiNo: '6072286441', company: '더모어커머스', ceo: '안승혁',
  service: '소매업', item: '전자상거래',
  zip: '08368', addr1: '서울특별시 구로구 항동로 72(항동, 하버라인 4단지)', addr2: '404-601',
}

// Playwright: ggsan 주문서 자동 작성 → 결제 직전 정지 (브라우저 열어둠)
async function runFlow(goodsNo, qty, recipient) {
  let chromium
  try { ({ chromium } = await import('playwright')) } catch { ({ chromium } = await import('playwright-core')) }
  const browser = await chromium.launch({ channel: 'chrome', headless: false })
  const ctx = await browser.newContext()
  ctx.on('dialog', (d) => d.accept().catch(() => {}))
  const page = await ctx.newPage()
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
  await op.evaluate(({ rcp, biz }) => {
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
  }, { rcp: recipient, biz: BIZ_INFO })
  await op.bringToFront().catch(() => {})
  // 브라우저는 닫지 않는다 — 사장님이 금액 확인 후 결제하기
  return { ok: true, msg: '주문서 작성 완료 — 열린 ggsan 창에서 금액·배송지 확인 후 [결제하기]를 직접 누르세요' }
}

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
    if (u.pathname === '/order') {
      const r = await resolveOrder(u.searchParams.get('id'))
      if (r.error) { htmlPage(res, `<h2>⚠ ${esc(r.error)}</h2><p>이 주문은 자동 진행할 수 없습니다. ggsan에서 직접 주문해 주세요.</p>`); return }
      htmlPage(res, `<h2>🛒 ggsan 자동 주문 확인</h2>
        <table style="border-collapse:collapse;width:100%"><tbody>
        <tr><td style="padding:6px 8px;color:#666">상품</td><td style="padding:6px 8px"><b>${esc(r.order.product_name)}</b>${r.order.option_name ? '<br><span style="color:#888;font-size:13px">' + esc(r.order.option_name) + '</span>' : ''}</td></tr>
        <tr><td style="padding:6px 8px;color:#666">수량</td><td style="padding:6px 8px">${r.order.shipping_count}</td></tr>
        <tr><td style="padding:6px 8px;color:#666">매입처</td><td style="padding:6px 8px">ggsan #${esc(r.goodsNo)}</td></tr>
        <tr><td style="padding:6px 8px;color:#666">수령인</td><td style="padding:6px 8px"><b>${esc(r.recipient.name)}</b> · ${esc(r.recipient.zip)}<br>${esc(r.recipient.addr1)} ${esc(r.recipient.addr2)}<br>${esc(r.recipient.phone)}</td></tr>
        </tbody></table>
        <p style="background:#fef3c7;color:#92400e;padding:10px 12px;border-radius:8px">⚠ <b>결제 직전까지만</b> 자동 작성합니다. 열리는 ggsan 창에서 <b>금액·배송지를 확인한 뒤 직접 [결제하기]</b>를 누르세요.</p>
        <p><a href="/run?id=${esc(u.searchParams.get('id'))}" style="display:inline-block;background:#2563eb;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600">결제진행 시작 → (ggsan 창 열림, ~1분)</a></p>`)
      return
    }
    if (u.pathname === '/run') {
      const r = await resolveOrder(u.searchParams.get('id'))
      if (r.error) { htmlPage(res, `<h2>⚠ ${esc(r.error)}</h2>`); return }
      const out = await runFlow(r.goodsNo, r.order.shipping_count, r.recipient)
      htmlPage(res, out.ok
        ? `<h2>✓ ${esc(out.msg)}</h2><p>열린 ggsan 창으로 가서 결제를 마치세요. 이 탭은 닫으셔도 됩니다.</p>`
        : `<h2>✗ ${esc(out.msg)}</h2><p>다시 시도하거나 ggsan에서 직접 주문하세요.</p>`)
      return
    }
    htmlPage(res, `<h2>주문 자동화 헬퍼 가동 중</h2><p>관리자 페이지의 <b>결제진행</b> 버튼으로 호출됩니다. (포트 ${PORT})</p>`)
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(`<body style="font-family:sans-serif"><h2>✗ 서버 오류: ${esc(e instanceof Error ? e.message : e)}</h2>`)
  }
}).listen(PORT, '127.0.0.1', () => console.log(`order-server 가동: http://127.0.0.1:${PORT}  (결제진행 버튼이 호출)`))
