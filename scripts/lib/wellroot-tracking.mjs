/**
 * 웰루트B2B(Cafe24) 주문 추적 — 마이쇼핑 주문상세에서 주문처리상태 + 택배사/송장 수집.
 *
 * 실측(2026-09-27, 예치금 충전 주문 20260923-0000026 — 발송된 상품 주문은 아직 없음):
 *   상단 표  th '주문번호' → td 주문번호 / th '주문처리상태' → td '예치금 충전' + [주문취소] 버튼
 *   상품 영역 .xans-myshop-orderhistorydetailindividual = 표(table) 구조
 *     → 유픽 스킨(.prdBox ul.info)과 달라 scripts/lib/upick-tracking.mjs 파서를 그대로 쓸 수 없다.
 * 송장: Cafe24 플랫폼 공통 배송조회 링크(href/onclick 의 invoice_no=…)를 스킨과 무관하게 찾는다.
 *   유픽 실측 기준 링크 텍스트 = 택배사명 / [송장번호]. ⚠ 웰루트 실발송 건으로는 미검증 — 첫 발송 건이 첫 검증.
 * 주의: 사이트 하단 푸터에 'CJ대한통운(1588-1225)' 안내문이 상존 → 택배사명은 상품 영역 안에서만 찾는다.
 * 주의: 주문처리상태 칸에 [주문취소] 등 버튼이 같이 있어 textContent 를 통째로 쓰면 '취소'로 오인 → 버튼 제거 후 읽는다.
 *
 * 세션: Playwright(설치된 Chrome, headless). 로그인 = Cafe24 AuthSSL — 스킨 스크립트가 로드 직후 입력값을 지우므로
 *   load 대기 + 값이 남을 때까지 재입력 + Enter (scripts/wellroot-collect.mjs · order-server runFlowWellroot 와 동일).
 */
import { chromium } from 'playwright'

const CANCEL_LIKE_RE = /취소|반품|교환|환불/

/** 세션 열고 fn(page, base) 실행 후 닫는다. 로그인 실패 시 throw. */
export async function withWellrootSession(env, fn) {
  const base = (env.WELLROOT_BASE_URL || 'https://wellrootb2b.com').replace(/\/+$/, '')
  if (!env.WELLROOT_USER || !env.WELLROOT_PASS) throw new Error('WELLROOT_USER/PASS 미설정(.env.local)')
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  try {
    const page = await (await browser.newContext({ locale: 'ko-KR' })).newPage()
    page.setDefaultTimeout(20000)
    await page.goto(`${base}/member/login.html`, { waitUntil: 'load', timeout: 45000 })
    for (let i = 0; i < 4; i++) {
      await page.waitForTimeout(600)
      await page.locator('#member_id').fill(env.WELLROOT_USER)
      await page.locator('#member_passwd').fill(env.WELLROOT_PASS)
      if ((await page.locator('#member_id').inputValue()) === env.WELLROOT_USER && (await page.locator('#member_passwd').inputValue()) === env.WELLROOT_PASS) break
    }
    await Promise.all([
      page.waitForURL((u) => !/\/member\/login\.html/.test(u.toString()), { timeout: 30000 }).catch(() => {}),
      page.press('#member_passwd', 'Enter'),
    ])
    if (/member\/login/.test(page.url())) throw new Error('wellroot login failed')
    return await fn(page, base)
  } finally {
    await browser.close().catch(() => {})
  }
}

/**
 * 주문 1건 상세 파싱.
 * @returns {{ found:boolean, status:string|null, cancelLike:boolean, carrier:string|null, invoiceRaw:string|null, itemStatuses:string[] }}
 *   invoiceRaw = 첫 번째 송장(원문, 하이픈 등 포함 가능 → 호출측 normalizeInvoiceNo)
 */
export async function fetchWellrootOrder(page, base, orderId) {
  // 잘못된 order_id 는 Cafe24 가 alert + 리다이렉트할 수 있어 dialog 는 자동 수락
  const onDialog = (d) => d.accept().catch(() => {})
  page.on('dialog', onDialog)
  let r
  try {
    await page.goto(`${base}/myshop/order/detail.html?order_id=${encodeURIComponent(orderId)}`, { waitUntil: 'domcontentloaded' })
    await page.waitForLoadState('load').catch(() => {})
    await page.waitForTimeout(500)
    // 세션 만료 → 로그인 페이지로 튕김: '주문 없음'과 구분해 상위에서 회차 중단
    if (/member\/login/.test(page.url())) throw new Error('wellroot session expired')
    r = await page.evaluate((expected) => {
      const norm = (s) => (s || '').replace(/\s+/g, ' ').trim()
      // 버튼·링크(주문취소/배송조회 등)를 뺀 칸 텍스트
      const cellText = (td) => { const c = td.cloneNode(true); c.querySelectorAll('a, button, input, select').forEach((e) => e.remove()); return norm(c.textContent) }
      let found = false, status = null
      for (const th of document.querySelectorAll('th')) {
        const k = norm(th.textContent)
        const td = th.nextElementSibling
        if (!td) continue
        if (/^주문번호/.test(k) && norm(td.textContent).includes(expected)) found = true
        if (/주문처리상태/.test(k) && status == null) status = cellText(td) || null
      }
      // 상품 영역(개별 주문상품) — 없으면 문서 전체에서 송장 링크만 찾는다(택배사명은 상품 영역에서만)
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
      // 상품별 주문처리상태(표 열) — 상단 상태가 비어 있는 스킨 대비 + 부분취소 감지용
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
  // 없는 주문번호면 Cafe24 가 alert 후 이전/목록 페이지로 돌려보내 다른 주문의 상태가 읽힐 수 있다(실측) → 전부 비운다
  if (!r.found) return { found: false, status: null, cancelLike: false, carrier: null, invoiceRaw: null, itemStatuses: [] }
  const status = r.status || r.itemStatuses[0] || null
  return {
    found: r.found,
    status,
    cancelLike: !!(status && CANCEL_LIKE_RE.test(status)),
    carrier: r.carrier,
    invoiceRaw: r.invoiceRaw,
    itemStatuses: r.itemStatuses,
  }
}
