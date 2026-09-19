/**
 * 매입처 재고 판정 공용 모듈 — 쿠팡 재고 동기화(local-cron-stock-sync.mjs)가 쓴다.
 *
 * 공급처별로 사이트 엔진이 달라 판정 방식이 둘로 갈린다.
 *   · 상용몰(ggsan · 77bio): goods_view.php 라이브 조회 — set_goods_price 양수면 재고 있음
 *   · Cafe24(upickb2b · wellroot): 카테고리 리스트의 품절 아이콘 — 상세페이지는 품절 마커가 상존해 판별 불가
 *
 * ⚠ Cafe24 는 2026-08 경 AuthSSL(비밀번호 암호화)이 적용돼 평문 POST 로그인이 403 이다.
 *   그 여파로 유픽 재고추적이 2026-09-02 부터 조용히 멈춰 있었다(전부 unknown → 품절 미감지).
 *   → 헤드리스 크롬으로 로그인해 쿠키만 fetch 로 이식한다(wellroot-collect.mjs 에서 검증된 패턴).
 */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
const sleep = ms => new Promise(s => setTimeout(s, ms))

/** 쿠키 저장소 + fetch 래퍼를 한 세트로 만든다(공급처마다 독립 세션). */
export function makeSession() {
  const cookies = new Map()
  const setCookies = h => { if (!h) return; for (const part of h.split(/,(?=[^;]+=)/)) { const kv = part.split(';')[0]; const i = kv.indexOf('='); if (i > 0) cookies.set(kv.slice(0, i).trim(), kv.slice(i + 1).trim()) } }
  const header = () => [...cookies].map(([k, v]) => `${k}=${v}`).join('; ')
  const fx = async (url, init = {}) => {
    const r = await fetch(url, { redirect: 'manual', ...init, headers: { 'User-Agent': UA, 'Accept-Language': 'ko-KR,ko;q=0.9', Cookie: header(), ...(init.headers || {}) } })
    setCookies(r.headers.get('set-cookie'))
    return r
  }
  return { cookies, fx, header }
}

/**
 * Cafe24 로그인 — 헤드리스 크롬으로 로그인한 뒤 쿠키를 세션에 이식한다.
 * AuthSSL 때문에 평문 POST(/exec/front/Member/login/)는 403 이므로 이 경로만 유효하다.
 */
export async function cafe24Login(session, { base, user, pass, label }) {
  if (!user || !pass) throw new Error(`${label} 자격증명 없음(.env.local)`)
  let chromium
  try { ({ chromium } = await import('playwright')) } catch { ({ chromium } = await import('playwright-core')) }
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  try {
    const ctx = await browser.newContext({ userAgent: UA, locale: 'ko-KR' })
    const page = await ctx.newPage()
    let dialogMsg = null
    page.on('dialog', d => { dialogMsg = d.message(); d.dismiss().catch(() => {}) })
    await page.goto(`${base}/member/login.html`, { waitUntil: 'load', timeout: 45000 })
    // 스킨 스크립트가 로드 직후 입력값을 지우는 경우가 있어 값이 남을 때까지 재입력
    for (let i = 0; i < 4; i++) {
      await page.waitForTimeout(600)
      await page.locator('#member_id').fill(user)
      await page.locator('#member_passwd').fill(pass)
      if ((await page.locator('#member_id').inputValue()) === user && (await page.locator('#member_passwd').inputValue()) === pass) break
    }
    await Promise.all([
      page.waitForURL(u => !/\/member\/login\.html/.test(u.toString()), { timeout: 30000 })
        .catch(() => { throw new Error(`${label} 로그인 실패${dialogMsg ? ': ' + dialogMsg : ' (로그인 페이지에서 이동 없음)'}`) }),
      page.press('#member_passwd', 'Enter'),
    ])
    for (const c of await ctx.cookies(base)) session.cookies.set(c.name, c.value)
  } finally {
    await browser.close().catch(() => {})
  }
  if (!session.cookies.has('ECSESSID')) throw new Error(`${label} 로그인 실패 — ECSESSID 미발급`)
}

/**
 * Cafe24 카테고리 리스트 스캔 → { product_no: 'in_stock'|'sold_out' }.
 * 상세페이지는 품절 마커가 템플릿에 상존해 쓸 수 없고, 리스트의 ico_product_soldout 만 신뢰할 수 있다.
 */
export async function cafe24BuildStockMap(session, base, cates, { maxPages = 30 } = {}) {
  const map = new Map()
  for (const cate of cates) {
    const seen = new Set()
    for (let page = 1; page <= maxPages; page++) {
      const r = await session.fx(`${base}/category/x/${cate}/?page=${page}`)
      if (!r.ok) break
      let html = await r.text()
      const cut = html.search(/class="[^"]*ec-base-paginate/); if (cut > 0) html = html.slice(0, cut)
      let fresh = 0
      for (const b of html.matchAll(/id=["']anchorBoxId_(\d+)["']([\s\S]*?)(?=id=["']anchorBoxId_|$)/g)) {
        if (seen.has(b[1])) continue
        seen.add(b[1]); fresh++
        map.set(b[1], /ico_product_soldout|alt=["']품절["']/i.test(b[2]) ? 'sold_out' : 'in_stock')
      }
      if (!fresh) break
      await sleep(250)
    }
  }
  return map
}

/**
 * 상용몰(ggsan · 77bio) 로그인 — 평문 POST 가 아직 유효하다(Cafe24 와 달리 AuthSSL 아님).
 * ggsan 은 login_ps.php 가 parent.location.href 스크립트를 돌려주고, 77bio 는 로그인 후 본문에 '로그아웃'이 뜬다.
 */
export async function mallLogin(session, { base, user, pass, label }) {
  if (!user || !pass) throw new Error(`${label} 자격증명 없음(.env.local)`)
  session.cookies.clear()
  await session.fx(`${base}/member/login.php`)
  const r = await session.fx(`${base}/member/login_ps.php`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Referer: `${base}/member/login.php` },
    body: new URLSearchParams({ loginId: user, loginPwd: pass, saveId: 'y', returnUrl: `${base}/main/index.php` }).toString(),
  })
  const t = await r.text()
  if (/location\.href/.test(t) || /로그아웃/.test(t)) return
  // 리다이렉트만 주는 스킨 대비 — 회원 전용 페이지로 재검증
  const v = await session.fx(`${base}/mypage/index.php`)
  const vt = await v.text().catch(() => '')
  if (!/로그아웃|마이페이지/.test(vt)) throw new Error(`${label} 로그인 실패`)
}

/**
 * 상용몰 상품 재고 — goods_view.php 라이브 조회.
 *   1) set_goods_price 가 양수면 구매 가능(품절이면 가격영역이 사라진다) — 가장 신뢰도 높은 신호
 *   2) 가격이 없을 때만 품절 문구로 판정. ggsan 네비의 "입고&품절제품" 메뉴 오탐은 제거한다.
 */
export async function mallCheckStock(session, base, goodsNo) {
  const r = await session.fx(`${base}/goods/goods_view.php?goodsNo=${goodsNo}`)
  if (!r.ok) return 'unknown'
  const html = await r.text()
  const pm = /name=["']set_goods_price["'][^>]*value=["'](\d+)/.exec(html)
  if (pm && parseInt(pm[1], 10) > 0) return 'in_stock'
  const body = html.replace(/입고\s*&[^<]{0,12}품절[^<]{0,8}/g, ' ')
  if (/재입고\s*알림|품절|매진|일시품절|판매\s*중지/.test(body.slice(0, 40000))) return 'sold_out'
  return 'unknown'
}
