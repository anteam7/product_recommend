/**
 * 77bio(GodoMall) 주문 추적 — mypage/order_view.php 에서 주문상태 + 택배사/송장 수집.
 *
 * 실측 DOM(2026-09-02, orderNo=2609021345535788 배송중 / 2609022051464871 상품준비중):
 *   tr[data-order-no][data-order-status] — data-order-status 는 내부 코드(g1=상품준비중, d1=배송중 등, 미확정)
 *   주문상태 td = tr.children[4] (날짜/상품주문번호/상품정보/가격수량/주문상태/수취인 6열 고정)
 *     <em> 배송중 (CJ택배) </em>                     상태어 + 택배사(괄호)
 *     <button class="js_btn_invoice_copy" data-invoice-no="600105777954">   송장번호(숫자만, 하이픈 없음)
 *   미발송(상품준비중 등): <em> 상품준비중 </em> 만 있고 버튼 없음 → invoiceRaw null.
 *
 * 세션: Playwright headless chromium. 로그인 = /member/login.php (loginId/loginPwd, order-server.mjs runFlowBio77 와 동일).
 */
import { chromium } from 'playwright'

const CANCEL_LIKE_RE = /취소|반품|교환|환불/

/** 세션 열고 fn(page, base) 실행 후 닫는다. 로그인 실패 시 throw. */
export async function withBio77Session(env, fn) {
  const base = (env.BIO77_BASE_URL || 'https://77bio.co.kr').replace(/\/+$/, '')
  if (!env.BIO77_USER || !env.BIO77_PASS) throw new Error('BIO77_USER/PASS 미설정(.env.local)')
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await (await browser.newContext({ locale: 'ko-KR' })).newPage()
    page.setDefaultTimeout(20000)
    await page.goto(`${base}/member/login.php`, { waitUntil: 'domcontentloaded' })
    await page.fill('input[name=loginId]', env.BIO77_USER)
    await page.fill('input[name=loginPwd]', env.BIO77_PASS)
    await Promise.all([
      page.waitForNavigation({ timeout: 15000 }).catch(() => {}),
      page.evaluate(() => { const f = document.querySelector('input[name=loginPwd]')?.form; if (f) (f.requestSubmit ? f.requestSubmit() : f.submit()) }),
    ])
    await page.waitForTimeout(1200)
    if (!(await page.evaluate(() => /로그아웃/.test(document.body.innerText)))) throw new Error('bio77 login failed')
    return await fn(page, base)
  } finally {
    await browser.close().catch(() => {})
  }
}

/**
 * 주문 1건 상세 파싱.
 * @returns {{ found:boolean, status:string|null, cancelLike:boolean, carrier:string|null, invoiceRaw:string|null }}
 */
export async function fetchBio77Order(page, base, orderNo) {
  await page.goto(`${base}/mypage/order_view.php?orderNo=${encodeURIComponent(orderNo)}`, { waitUntil: 'domcontentloaded' })
  await page.waitForLoadState('load').catch(() => {})
  await page.waitForTimeout(300)
  // 세션 만료 시 로그인 페이지로 리다이렉트 — 상위에서 회차 중단 판단할 수 있게 구분해 던진다.
  if (/member\/login/.test(page.url())) throw new Error('bio77 session expired')
  const r = await page.evaluate((expectedOrderNo) => {
    const norm = (s) => (s || '').replace(/\s+/g, ' ').trim()
    const tr = document.querySelector(`tr[data-order-no="${CSS.escape(String(expectedOrderNo))}"]`)
    if (!tr) return { found: false, status: null, carrier: null, invoiceRaw: null }
    // 주문상태 열 index는 thead 헤더 텍스트로 확정(마크업 변경/열순서 변동에도 안전).
    const headers = [...(tr.closest('table')?.querySelectorAll('thead th') ?? [])]
    let statusIdx = headers.findIndex((th) => /주문상태/.test(th.textContent || ''))
    if (statusIdx < 0) statusIdx = 4 // 폴백(실측 고정 6열: 날짜/상품주문번호/상품정보/가격수량/주문상태/수취인)
    const statusTd = tr.children[statusIdx] || null
    const emText = norm(statusTd?.querySelector('em')?.textContent)
    const invoiceRaw = statusTd?.querySelector('button[data-invoice-no]')?.getAttribute('data-invoice-no') || null
    const carrierMatch = emText.match(/\(([^)]+)\)/)
    const carrier = carrierMatch ? carrierMatch[1].trim() : null
    const status = norm(emText.replace(/\([^)]*\)/, '')) || null
    return { found: true, status, carrier, invoiceRaw }
  }, orderNo)
  return {
    found: r.found,
    status: r.status,
    cancelLike: !!(r.status && CANCEL_LIKE_RE.test(r.status)),
    carrier: r.carrier,
    invoiceRaw: r.invoiceRaw,
  }
}

/** 77bio 주문번호 형식: 숫자만(YYMMDD+10자리, 총 16자리) — ggsan(10~18자리 숫자)과 자릿수가 겹치므로
 * 절대 이 정규식만으로 ggsan 과 구분하지 말 것. 실제 매입처 판별은 listings.source/supplier_source 로 한다. */
export const BIO77_ORDER_NO_RE = /^\d{14,18}$/
