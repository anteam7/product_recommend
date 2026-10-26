/**
 * 도매아토즈(domeatoz.com) 사이트 어댑터 — 수집기(domeatoz-collect.mjs)와 쿠팡 재고 동기화(local-cron-stock-sync.mjs)가 같이 쓴다.
 *  - 로그인: POST /login form(UserId/UserPass) → sid 쿠키. 브라우저 불필요. sid 는 롤링이라 응답마다 Set-Cookie 를 흡수한다.
 *  - 판매 상태: POST /search (searchType=5 공급사코드) 30건/쪽 JSON — ProductState 1 판매중 · 2 품절 · 3 판매중단. 목록에 없으면 gone.
 *  - 상세 페이지(/product/{IDX})는 약 50회 조회 후 차단되므로 판매 상태는 목록으로만 본다.
 */
export const DOMEATOZ_BASE = 'https://www.domeatoz.com'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
const sleep = (ms) => new Promise((s) => setTimeout(s, ms))
export const DOMEATOZ_XHR = { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'X-Requested-With': 'XMLHttpRequest' }

/** sid 쿠키를 들고 다니는 fetch — fx('/path', init). 세션마다 독립. */
export function makeDomeatozSession(base = DOMEATOZ_BASE) {
  let sid = ''
  async function fx(p, init = {}) {
    const res = await fetch(base + p, { redirect: 'manual', ...init, headers: { 'User-Agent': UA, 'Accept-Language': 'ko-KR,ko;q=0.9', ...(sid ? { Cookie: `sid=${sid}` } : {}), ...(init.headers || {}) } })
    for (const c of res.headers.getSetCookie?.() || []) { const m = c.match(/^sid=([^;]+)/); if (m) sid = m[1] }
    return res
  }
  return { fx }
}

export async function domeatozLogin(s, { user, pass }) {
  if (!user || !pass) throw new Error('.env.local DOMEATOZ_ID / DOMEATOZ_PW 필요')
  await s.fx('/login')
  const res = await s.fx('/login', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ ReUrl: '/', UserId: user, UserPass: pass }) })
  const body = await res.text()
  if (!/location\.href\s*=\s*'\/'/.test(body)) throw new Error(`로그인 실패: ${body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120)}`)
  const home = await (await s.fx('/')).text()
  if (!/로그아웃/.test(home)) throw new Error('로그인 후 세션 확인 실패(로그아웃 링크 없음)')
}

/** 공급사 전 상품 목록(판매중·품절·판매중단). 잘린 목록은 정상 상품을 gone/품절로 만들므로 끝을 못 찾으면 throw. */
export async function domeatozListSupplier(s, code, { maxPages = 500 } = {}) {
  const out = [], seen = new Set()
  for (let page = 1; ; page++) {
    if (page > maxPages) throw new Error(`목록 ${code} ${maxPages}쪽 초과 — 페이지 끝 감지 실패`)
    const res = await s.fx('/search', { method: 'POST', headers: DOMEATOZ_XHR, body: `page=${page}&searchType=5&search=${encodeURIComponent(code)}&group_1=&group_2=&group_3=&group_4=&research=` })
    if (res.status !== 200) throw new Error(`목록 ${code} p${page} HTTP ${res.status}`)
    const j = await res.json().catch(() => { throw new Error(`목록 ${code} p${page} JSON 아님 — 세션 만료 가능`) })
    let fresh = 0, bad = 0
    for (const x of j.list || []) {
      if (!/^\d+$/.test(String(x.IDX))) { bad++; console.log(`  ⚠ IDX 형식 이상 건너뜀: ${String(x.IDX).slice(0, 20)}`); continue } // gone 필터 문자열에 그대로 들어간다
      if (seen.has(x.IDX)) continue
      seen.add(x.IDX); fresh++; out.push(x)
    }
    // 형식 이상 행만 있는 쪽에서 끝내면 뒤쪽이 잘린 목록이 된다
    if (!fresh && bad) throw new Error(`목록 ${code} p${page} 전부 IDX 형식 이상(${bad}건) — 응답 형식 변경 의심`)
    if (!fresh) break
    await sleep(200)
  }
  return out
}
