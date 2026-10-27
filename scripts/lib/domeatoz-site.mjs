/**
 * 도매아토즈(domeatoz.com) 사이트 어댑터 — 수집기(domeatoz-collect.mjs)·쿠팡 재고 동기화(local-cron-stock-sync.mjs)·결제진행(order-server.mjs)이 같이 쓴다.
 *  - 로그인: POST /login form(UserId/UserPass) → sid 쿠키. 브라우저 불필요. sid 는 롤링이라 응답마다 Set-Cookie 를 흡수한다.
 *  - 판매 상태: POST /search (searchType=5 공급사코드) 30건/쪽 JSON — ProductState 1 판매중 · 2 품절 · 3 판매중단. 목록에 없으면 gone.
 *    한 건만 볼 땐 searchType=3(상품코드 AZ+IDX 8자리) — 결제진행 직전 확인.
 *  - 주문: 주문배송조회 POST /request-orderList(외부주문코드 검색) · 적립금 POST /request-CashRefresh — 주문서 자동 작성은 order-server.mjs runFlowDomeatoz.
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

/** 상품 한 건의 목록 행(ProductState·WholesalePrice·DeliveryPrice) — 상품코드(AZ+IDX 8자리) 검색. 상세 페이지 조회 제한에 안 걸린다.
 *  검색 결과에 없으면 null(단종 등), 조회 자체가 실패하면 throw — 둘을 섞으면 실패가 '없음'으로 보인다. */
export async function domeatozProductRow(s, idx) {
  if (!/^\d+$/.test(String(idx))) throw new Error(`상품 IDX 형식 오류: ${String(idx).slice(0, 20)}`)
  const code = `AZ${String(idx).padStart(8, '0')}`
  const res = await s.fx('/search', { method: 'POST', headers: DOMEATOZ_XHR, body: `page=1&searchType=3&search=${code}&group_1=&group_2=&group_3=&group_4=&research=` })
  if (res.status !== 200) throw new Error(`상품 ${code} 검색 HTTP ${res.status}`)
  const j = await res.json().catch(() => null)
  if (!Array.isArray(j?.list)) throw new Error(`상품 ${code} 검색 응답 형식 이상 — 세션 만료 가능`)
  return j.list.find((x) => String(x.IDX) === String(idx)) ?? null
}

/** 보유 적립금(원) — 주문서·헤더가 쓰는 POST /request-CashRefresh */
export async function domeatozCash(s) {
  const res = await s.fx('/request-CashRefresh', { method: 'POST', headers: DOMEATOZ_XHR, body: '' })
  if (res.status !== 200) throw new Error(`적립금 조회 HTTP ${res.status}`)
  const j = await res.json().catch(() => null)
  const cash = j?.Re?.Cash
  if (typeof cash !== 'number' || !Number.isFinite(cash)) throw new Error('적립금 조회 실패 — 세션 만료 가능') // Number(null)=0 이 '잔액 0원'으로 보이지 않게
  return cash
}

/**
 * 외부주문코드(주문서에 넣은 마켓 주문번호)로 최근 주문 찾기 — POST /request-orderList(주문배송조회 화면과 같은 호출), 20건/쪽.
 * 행: IO_OrderNumber(주문코드)·IO_OutCode·IO_State(0 결제완료·1 배송준비·2 배송중·3 배송완료·4 취소요청·5 취소완료·8 공급사취소 …)·IO_DeliveryName·IO_DeliveryNumber·IO_TotalPrice·IO_DeliveryPrice
 * 결제진행의 중복 결제 방지에 쓰므로 조회 실패는 빈 배열이 아니라 throw. 서버 검색(SearchType=10 외부주문코드)은 쓰지 않고
 * 기간 내 전체를 읽어 IO_OutCode 를 직접 비교한다 — OPEN API 의 같은 검색이 고장(2026-10-27)이라 "검색 결과 없음"을 믿을 수 없다.
 */
export async function domeatozFindOrders(s, outCode, { days = 30, maxPages = 50 } = {}) {
  const kst = (d) => new Date(Date.now() + 9 * 3600e3 + d * 864e5).toISOString().slice(0, 10)
  const out = []
  for (let page = 1; page <= maxPages; page++) {
    const p = new URLSearchParams({ ListDateType: '0', page: String(page), getdate1: kst(-days), getdate2: kst(0) })
    for (let k = 1; k <= 12; k++) p.set(`orderIngType${k}`, 'true')
    p.set('SearchType', '0'); p.set('search', '')
    const res = await s.fx('/request-orderList', { method: 'POST', headers: DOMEATOZ_XHR, body: p.toString() })
    if (res.status !== 200) throw new Error(`주문 목록 조회 HTTP ${res.status}`)
    const j = await res.json().catch(() => null)
    if (j?.Re !== 1 || !Array.isArray(j.list)) throw new Error('주문 목록 조회 실패 — 세션 만료 가능')
    out.push(...j.list.filter((x) => String(x.IO_OutCode ?? '').trim() === String(outCode)))
    if (!j.list.length || page * (Number(j.pagecount) || 20) >= (Number(j.tn) || 0)) return out
  }
  throw new Error(`주문 목록 ${maxPages}쪽 초과(최근 ${days}일 주문 ${maxPages * 20}건 이상) — 중복 확인 불가`)
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
