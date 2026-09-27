/**
 * 건강산(ggsan, GodoMall) 주문 추적 — 마이페이지 주문상세(order_view)에서 주문상태 + 택배사/송장 수집.
 *
 * 로그인·파서는 scripts/local-cron-ggsan-sync.mjs(쿠팡 송장 동기화)의 확정 셀렉터를 이식한 것이다.
 * (그 크론은 인라인 구현 — 파서를 바꾸면 양쪽을 같이 고칠 것. 토스 크론도 같은 파서의 사본을 쓴다.)
 *   송장   = .js_btn_delivery_trace 의 data-invoice-no
 *   택배사 = data-invoice-company-sno ('8'=CJ대한통운, '5'=한진택배 실측 — 그 외는 null → 호출측 needs_attention)
 *   상태   = order-name td 뒤 첫 <em> (알려진 상태어만 채택, 액션버튼 오인 방지)
 *
 * 사용: const gg = createGgsanSession(env); await gg.login(); const o = await gg.fetchOrder('2609261234567890')
 */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

export const GGSAN_CARRIER_SNO_TO_NAME = { '8': 'CJ대한통운', '5': '한진택배' }
const ORDER_STATUS_KEYWORDS = ['입금대기', '결제완료', '상품준비중', '배송준비중', '배송지시', '배송중', '배송완료', '구매확정', '취소', '반품', '교환']
// em 부재 시 폴백 — 버튼으로 항상 존재하는 구매확정/취소/반품/교환은 제외(오인 차단)
const FALLBACK_SAFE_STATUSES = ['입금대기', '결제완료', '상품준비중', '배송준비중', '배송지시', '배송중', '배송완료']
const CANCEL_LIKE_RE = /취소|반품|교환|환불/

export function parseGgsanOrderView(html) {
  const invoiceNo = /data-invoice-no=["']([^"']+)/.exec(html)?.[1]?.trim() || null
  const carrierSno = /data-invoice-company-sno=["']([^"']+)/.exec(html)?.[1]?.trim() || null
  let status = null
  const afterName = html.includes('order-name') ? html.slice(html.indexOf('order-name')) : html
  const em = afterName.match(/<em>\s*([^<]+?)\s*<\/em>/)
  if (em) { const t = em[1].replace(/\s+/g, ''); if (ORDER_STATUS_KEYWORDS.includes(t)) status = t }
  if (!status) for (const kw of FALLBACK_SAFE_STATUSES) { if (afterName.includes(kw)) { status = kw; break } }
  const receiverName = /class=["']order-name["']\s*>\s*([^<]+?)\s*<\/td>/.exec(html)?.[1]?.trim() ?? null
  const paid = /class=["']total_pay_money["']\s*>\s*([\d,]+)\s*원/.exec(html)
  return {
    found: html.includes('order-name') || !!invoiceNo,
    status,
    cancelLike: !!(status && CANCEL_LIKE_RE.test(status)),
    invoiceRaw: invoiceNo,
    carrierSno,
    carrier: carrierSno != null ? (GGSAN_CARRIER_SNO_TO_NAME[carrierSno] ?? null) : null,
    receiverName,
    actualPaid: paid ? parseInt(paid[1].replace(/,/g, ''), 10) : null,
  }
}

export function createGgsanSession(env) {
  const base = (env.GGSAN_BASE_URL || 'https://www.ggsan.com').replace(/\/+$/, '')
  const cookies = new Map()
  const setCookies = (h) => {
    if (!h) return
    for (const part of h.split(/,(?=[^;]+=)/)) {
      const [kv] = part.split(';')
      const eq = kv.indexOf('=')
      if (eq > 0) cookies.set(kv.slice(0, eq).trim(), kv.slice(eq + 1).trim())
    }
  }
  async function gfetch(url, init = {}) {
    const res = await fetch(url, {
      redirect: 'manual', ...init,
      headers: { 'User-Agent': UA, 'Accept-Language': 'ko-KR,ko;q=0.9', Cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join('; '), ...(init.headers || {}) },
    })
    setCookies(res.headers.get('set-cookie'))
    return res
  }
  return {
    async login() {
      if (!env.GGSAN_USER || !env.GGSAN_PASS) throw new Error('GGSAN_USER/PASS 미설정(.env.local)')
      cookies.clear()
      await gfetch(`${base}/member/login.php`)
      const r = await gfetch(`${base}/member/login_ps.php`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Referer: `${base}/member/login.php` },
        body: new URLSearchParams({ loginId: env.GGSAN_USER, loginPwd: env.GGSAN_PASS, saveId: 'y', returnUrl: `${base}/main/index.php` }).toString(),
      })
      // 성공 시 parent.location 리다이렉트 스크립트가 main/index.php 로 보낸다
      if (!/main\/index\.php/.test(await r.text())) throw new Error('ggsan login failed')
    },
    async fetchOrder(orderNo) {
      const r = await gfetch(`${base}/mypage/order_view.php?orderNo=${encodeURIComponent(orderNo)}`)
      if (r.status >= 300 && r.status < 400 && /login/.test(r.headers.get('location') || '')) throw new Error('ggsan session expired')
      return parseGgsanOrderView(await r.text())
    },
  }
}
