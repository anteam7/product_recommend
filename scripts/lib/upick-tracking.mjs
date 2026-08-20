/**
 * 유픽B2B(Cafe24) 주문 추적 — 마이쇼핑 주문상세에서 주문처리상태 + 상품별 택배사/송장 수집.
 *
 * 실측 DOM(2026-08-20, 15건 검증 — CJ/한진 마크업 동일):
 *   주문처리상태: <th>주문처리상태</th><td> 배송중 <button …>            (배송전/상품준비중/배송중/배송완료/취소…)
 *   상품 블록:   .xans-myshop-orderhistorydetailindividual .prdBox
 *     .prdName                        상품명
 *     ul.info > li > a[href*="delivery_trace.php"…invoice_no=…]   텍스트 = 택배사명(한진택배/CJ대한통운)
 *     ul.info > li > a[onclick*="delivery_trace.php"]            텍스트 = [송장번호]
 *   미발송: 링크 텍스트 ''·'[]' 이고 invoice_no 없음.
 *   ⚠ CJ 송장은 '6995-6837-5375' 처럼 하이픈 포함으로 노출될 수 있음 → 호출측에서 normalizeInvoiceNo(숫자만).
 *
 * 세션: Playwright headless chromium. 로그인 = /member/login.html (member_id/member_passwd, order-server.mjs 와 동일).
 */
import { chromium } from 'playwright'

const CANCEL_LIKE_RE = /취소|반품|교환|환불/

/** 세션 열고 fn(page) 실행 후 닫는다. 로그인 실패 시 throw. */
export async function withUpickSession(env, fn) {
  const base = (env.UPICKB2B_BASE_URL || 'https://upickb2b.com').replace(/\/+$/, '')
  if (!env.UPICKB2B_USER || !env.UPICKB2B_PASS) throw new Error('UPICKB2B_USER/PASS 미설정(.env.local)')
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await (await browser.newContext({ locale: 'ko-KR' })).newPage()
    page.setDefaultTimeout(20000)
    await page.goto(`${base}/member/login.html`, { waitUntil: 'domcontentloaded' })
    await page.fill('input[name=member_id]', env.UPICKB2B_USER)
    await page.fill('input[name=member_passwd]', env.UPICKB2B_PASS)
    await Promise.all([
      page.waitForNavigation({ timeout: 15000 }).catch(() => {}),
      page.evaluate(() => { const f = document.querySelector('input[name=member_passwd]')?.form; if (f) (f.requestSubmit ? f.requestSubmit() : f.submit()) }),
    ])
    await page.waitForTimeout(800)
    if (/member\/login/.test(page.url())) throw new Error('upick login failed')
    return await fn(page, base)
  } finally {
    await browser.close().catch(() => {})
  }
}

/**
 * 주문 1건 상세 파싱.
 * @returns {{ found:boolean, status:string|null, cancelLike:boolean, items:Array<{name:string, carrier:string|null, invoiceRaw:string|null}>, invoiceRaw:string|null, carrier:string|null }}
 *   invoiceRaw/carrier = 첫 번째 송장 있는 상품 기준(주문 1건=상품 1종이 일반적). 하이픈 등 원문 그대로.
 */
export async function fetchUpickOrder(page, base, orderId) {
  // 잘못된 order_id 는 Cafe24 가 alert + 리다이렉트할 수 있어 dialog 는 자동 수락, 로드 완료까지 대기 후 평가
  const onDialog = (d) => d.accept().catch(() => {})
  page.on('dialog', onDialog)
  let r
  try {
    await page.goto(`${base}/myshop/order/detail.html?order_id=${encodeURIComponent(orderId)}`, { waitUntil: 'domcontentloaded' })
    await page.waitForLoadState('load').catch(() => {})
    await page.waitForTimeout(500)
    // 세션 만료 → 로그인 페이지로 튕김: '주문 없음'과 구분해 상위에서 회차 중단
    if (/member\/login/.test(page.url())) throw new Error('upick session expired')
    r = await page.evaluate(() => {
    const norm = (s) => (s || '').replace(/\s+/g, ' ').trim()
    let status = null
    for (const th of document.querySelectorAll('th')) {
      if (/주문처리상태/.test(th.textContent || '')) {
        const td = th.nextElementSibling
        // td 의 첫 텍스트 노드(버튼 텍스트 제외)
        const tn = td ? [...td.childNodes].find((n) => n.nodeType === 3 && norm(n.textContent)) : null
        status = norm(tn ? tn.textContent : td?.textContent) || null
        break
      }
    }
    const boxes = [...document.querySelectorAll('.xans-myshop-orderhistorydetailindividual .prdBox, .ec-base-prdInfo .prdBox')]
    const items = boxes.map((box) => {
      const name = norm(box.querySelector('.prdName')?.textContent)
      const info = box.querySelector('ul.info')
      let carrier = null, invoiceRaw = null
      if (info) {
        for (const a of info.querySelectorAll('a')) {
          const src = `${a.getAttribute('href') || ''} ${a.getAttribute('onclick') || ''}`
          const m = /invoice_no=([^&'"\s]+)/.exec(src)
          if (m && m[1]) {
            if (!invoiceRaw) { try { invoiceRaw = decodeURIComponent(m[1]) } catch { invoiceRaw = m[1] } }
            const t = norm(a.textContent)
            if (t && !/^\[.*\]$/.test(t) && !carrier) carrier = t
          }
        }
      }
      return { name, carrier, invoiceRaw }
    })
    const found = boxes.length > 0 || status != null
    return { found, status, items }
    })
  } finally {
    page.off('dialog', onDialog)
  }
  const first = r.items.find((it) => it.invoiceRaw) || null
  return {
    found: r.found,
    status: r.status,
    cancelLike: !!(r.status && CANCEL_LIKE_RE.test(r.status)),
    items: r.items,
    invoiceRaw: first?.invoiceRaw ?? null,
    carrier: first?.carrier ?? null,
  }
}

/** 유픽(Cafe24) 주문번호 형식: YYYYMMDD-NNNNNNN */
export const UPICK_ORDER_NO_RE = /^\d{8}-\d{6,9}$/
