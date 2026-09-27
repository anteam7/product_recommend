/**
 * Cafe24(AuthSSL 로그인) 매입처 공통 주문 추적 — 마이쇼핑 주문상세에서 주문처리상태 + 택배사/송장 수집.
 * 사용처: 웰루트(scripts/lib/wellroot-tracking.mjs 가 감쌈) · K-홀세일 — scripts/local-cron-ggsan-sync.mjs
 * (유픽B2B는 AuthSSL 이전 방식의 전용 파서 scripts/lib/upick-tracking.mjs 를 그대로 쓴다)
 *
 * 실측(웰루트 2026-09-27, 예치금 충전 주문): 상단 표 th '주문번호'/'주문처리상태', 상품 영역
 *   .xans-myshop-orderhistorydetailindividual 은 스킨마다 다르다(웰루트=표, 유픽=.prdBox).
 * 송장: Cafe24 플랫폼 공통 배송조회 링크(href/onclick 의 invoice_no=…)를 스킨과 무관하게 찾는다.
 *   ⚠ 웰루트·K홀세일 모두 실발송 건으로는 미검증 — 매입처별 첫 발송 건이 첫 검증.
 * 함정(웰루트 실측):
 *   - 주문처리상태 칸에 [주문취소] 버튼이 붙어 textContent 를 통째로 쓰면 '취소' 오인 → a/button 제거 후 읽는다.
 *   - 사이트 푸터에 'CJ대한통운(1588-1225)' 같은 안내문이 상존 → 택배사명은 상품 영역 안에서만 찾는다.
 *   - 없는 주문번호는 alert 후 이전/목록 페이지로 돌아가 다른 주문 상태가 읽힌다 → found=false 면 전부 비운다.
 * 로그인: 스킨 스크립트가 로드 직후 입력값을 지우므로 load 대기 + 값 유지될 때까지 재입력 + Enter.
 */
import { chromium } from 'playwright'

const CANCEL_LIKE_RE = /취소|반품|교환|환불/

/** 세션 열고 fn(page, base) 실행 후 닫는다. 로그인 실패 시 throw('… login failed'). */
export async function withCafe24Session({ base, user, pass, label }, fn) {
  base = String(base).replace(/\/+$/, '')
  if (!user || !pass) throw new Error(`${label} 자격증명 미설정(.env.local)`)
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  try {
    const page = await (await browser.newContext({ locale: 'ko-KR' })).newPage()
    page.setDefaultTimeout(20000)
    await page.goto(`${base}/member/login.html`, { waitUntil: 'load', timeout: 45000 })
    for (let i = 0; i < 4; i++) {
      await page.waitForTimeout(600)
      await page.locator('#member_id').fill(user)
      await page.locator('#member_passwd').fill(pass)
      if ((await page.locator('#member_id').inputValue()) === user && (await page.locator('#member_passwd').inputValue()) === pass) break
    }
    await Promise.all([
      page.waitForURL((u) => !/\/member\/login\.html/.test(u.toString()), { timeout: 30000 }).catch(() => {}),
      page.press('#member_passwd', 'Enter'),
    ])
    if (/member\/login/.test(page.url())) throw new Error(`${label} login failed`)
    return await fn(page, base)
  } finally {
    await browser.close().catch(() => {})
  }
}

/**
 * 주문 1건 상세 파싱.
 * @returns {{ found:boolean, status:string|null, cancelLike:boolean, carrier:string|null, invoiceRaw:string|null, itemStatuses:string[] }}
 *   invoiceRaw = 첫 번째 송장(원문 — 하이픈 등 포함 가능 → 호출측 normalizeInvoiceNo)
 */
export async function fetchCafe24Order(page, base, orderId, label = 'cafe24') {
  const onDialog = (d) => d.accept().catch(() => {})
  page.on('dialog', onDialog)
  let r
  try {
    await page.goto(`${base}/myshop/order/detail.html?order_id=${encodeURIComponent(orderId)}`, { waitUntil: 'domcontentloaded' })
    await page.waitForLoadState('load').catch(() => {})
    await page.waitForTimeout(500)
    // 세션 만료 → 로그인 페이지로 튕김: '주문 없음'과 구분해 상위에서 회차 중단
    if (/member\/login/.test(page.url())) throw new Error(`${label} session expired`)
    r = await page.evaluate((expected) => {
      const norm = (s) => (s || '').replace(/\s+/g, ' ').trim()
      const cellText = (td) => { const c = td.cloneNode(true); c.querySelectorAll('a, button, input, select').forEach((e) => e.remove()); return norm(c.textContent) }
      let found = false, status = null
      for (const th of document.querySelectorAll('th')) {
        const k = norm(th.textContent)
        const td = th.nextElementSibling
        if (!td) continue
        if (/^주문번호/.test(k) && norm(td.textContent).includes(expected)) found = true
        if (/주문처리상태/.test(k) && status == null) status = cellText(td) || null
      }
      const areas = [...document.querySelectorAll('.xans-myshop-orderhistorydetailindividual')]
      const roots = areas.length ? areas : [document.body]
      let invoiceRaw = null, carrier = null
      for (const root of roots) {
        for (const a of root.querySelectorAll('a')) {
          const src = `${a.getAttribute('href') || ''} ${a.getAttribute('onclick') || ''}`
          const m = /invoice_no=([^&'"\s)]+)/.exec(src)
          if (!m || !m[1]) continue
          if (!invoiceRaw) { try { invoiceRaw = decodeURIComponent(m[1]) } catch { invoiceRaw = m[1] } }
          const t = norm(a.textContent)
          if (t && !/^\[.*\]$/.test(t) && !/^[\d-]+$/.test(t) && !/배송조회/.test(t) && !carrier) carrier = t
        }
      }
      if (invoiceRaw && !carrier && areas.length) {
        const m = /(CJ\s*대한통운|한진택배|롯데택배|우체국택배|로젠택배|경동택배|대신택배)/.exec(areas.map((e) => e.innerText).join(' '))
        if (m) carrier = m[1].replace(/\s+/g, '')
      }
      const itemStatuses = []
      for (const table of areas.flatMap((a) => [...a.querySelectorAll('table')])) {
        const heads = [...table.querySelectorAll('thead th')].map((th) => norm(th.textContent))
        const idx = heads.findIndex((h) => /주문처리상태/.test(h))
        if (idx < 0) continue
        for (const tr of table.querySelectorAll('tbody tr')) {
          const td = tr.children[idx]
          const s = td ? cellText(td) : ''
          if (s) itemStatuses.push(s)
        }
      }
      return { found, status, invoiceRaw, carrier, itemStatuses }
    }, String(orderId))
  } finally {
    page.off('dialog', onDialog)
  }
  if (!r.found) return { found: false, status: null, cancelLike: false, carrier: null, invoiceRaw: null, itemStatuses: [] }
  const status = r.status || r.itemStatuses[0] || null
  return { found: true, status, cancelLike: !!(status && CANCEL_LIKE_RE.test(status)), carrier: r.carrier, invoiceRaw: r.invoiceRaw, itemStatuses: r.itemStatuses }
}
