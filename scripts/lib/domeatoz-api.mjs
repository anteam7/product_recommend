/**
 * 도매아토즈 판매사 OPEN API 클라이언트(https://domeatoz.com:5555) — 송장 싱크(local-cron-ggsan-sync.mjs TRACKERS)가 쓴다.
 * 가이드: domeatoz.com/pdf/atoz_api.pdf(Release 2025.08.20). 키 = /user-api 화면 발급분(.env.local DOMEATOZ_API_KEY/SECRET), 사용 승인 확인 2026-10-27.
 *  - 인증 헤더: X-Timestamp(ms) · X-API-KEY(Access Key) · X-Customer(판매사 ID = DOMEATOZ_ID) · X-Signature = base64(HMAC-SHA256(Secret Key, `${ts}.${METHOD}.${uri}`))
 *  - 응답: { code: 'SUCCESS'|'ERROR', message, data, … }
 *  ⚠ 실측 함정(2026-10-27):
 *    · 주문 조회 기간은 beginDay = **늦은** 날짜, endDay = **이른** 날짜(최대 30일). 반대로 넣으면 "beginDay는 endDay보다 이후 날짜여야 합니다."
 *    · /orderListSearch 의 searchType '외주주문코드'(가이드 표기)는 서버가 ERROR 로 거부, '주문관리메모' 는 연결이 끊김 → 외부주문코드 매칭은
 *      /orderList 전체를 받아 externalCode 를 직접 비교한다. '주문번호' 검색은 정상.
 *    · 연달아 부르면 가끔 ECONNRESET → 재시도.
 */
import { createHmac } from 'node:crypto'

export const DOMEATOZ_API_BASE = 'https://domeatoz.com:5555'
// 주문 상태(가이드 22번) — 4 이상은 취소·반품 계열
export const DOMEATOZ_ORDER_STATUS = { 0: '결제완료', 1: '배송준비', 2: '배송중', 3: '배송완료', 4: '취소요청', 5: '주문취소', 6: '반품요청중', 7: '반품완료', 8: '공급사취소', 9: '판매사반품진행', 10: '공급사반품진행' }
export const DOMEATOZ_CANCELLED = new Set([5, 8]) // 주문이 없어진 상태(주문 연결 대상에서 뺀다)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const kstDay = (offsetDays) => new Date(Date.now() + 9 * 3600e3 + offsetDays * 864e5).toISOString().slice(0, 10)

export function createDomeatozApi(env) {
  const key = env.DOMEATOZ_API_KEY, secret = env.DOMEATOZ_API_SECRET, customer = env.DOMEATOZ_ID
  if (!key || !secret || !customer) throw new Error('.env.local DOMEATOZ_API_KEY / DOMEATOZ_API_SECRET / DOMEATOZ_ID 필요')

  async function call(method, uri, body, { retries = 3 } = {}) {
    for (let attempt = 1; ; attempt++) {
      const ts = Date.now().toString()
      const sig = createHmac('sha256', Buffer.from(secret, 'utf8')).update(`${ts}.${method}.${uri}`, 'utf8').digest('base64')
      try {
        const res = await fetch(DOMEATOZ_API_BASE + uri, {
          method,
          headers: { 'X-Timestamp': ts, 'X-API-KEY': key, 'X-Customer': customer, 'X-Signature': sig, 'Content-Type': 'application/json; charset=utf-8', Accept: 'application/json; charset=utf-8' },
          body: body ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(20000),
        })
        const text = await res.text()
        let j
        try { j = JSON.parse(text) } catch { throw new Error(`${uri} HTTP ${res.status} — JSON 아님: ${text.replace(/\s+/g, ' ').slice(0, 80)}`) }
        // 서버가 거절한 요청(서명·승인·파라미터)은 재시도해도 같다 → 바로 던진다
        if (j.code !== 'SUCCESS') throw Object.assign(new Error(`${uri} ${j.code ?? `HTTP ${res.status}`}: ${j.message ?? ''}`), { apiRejected: true })
        return j
      } catch (e) {
        if (e.apiRejected || attempt >= retries) throw e
        await sleep(2000 * attempt) // 연결 끊김(ECONNRESET)·타임아웃
      }
    }
  }

  /** 기간 [오늘−(days−1), 오늘]을 30일 창으로 나눠 [늦은 날, 이른 날] 쌍으로 */
  const windows = (days) => {
    const out = []
    for (let from = 0; from < days; from += 30) out.push([kstDay(-from), kstDay(-Math.min(from + 29, days - 1))])
    return out
  }

  return {
    call,
    /** 보유 적립금(원) */
    async cash() {
      const j = await call('GET', '/myCashSearch')
      if (typeof j.cash !== 'number') throw new Error('적립금 응답 형식 이상')
      return j.cash
    },
    /** 최근 days일 전체 상태 주문(가이드 22번 /orderList, 1,000건/쪽). 주문번호로 중복 제거 */
    async orders({ days = 30 } = {}) {
      const byNo = new Map()
      for (const [beginDay, endDay] of windows(days)) {
        for (let page = 1; ; page++) {
          if (page > 50) throw new Error(`/orderList ${beginDay}~${endDay} 50쪽 초과 — 페이지 끝 감지 실패`)
          const j = await call('POST', '/orderList', { pageCount: 1000, page, status: [], beginDay, endDay })
          if (!Array.isArray(j.data)) throw new Error('/orderList 응답 형식 이상(data 배열 아님)')
          for (const o of j.data) byNo.set(String(o.orderNumber), o)
          // totalPages 가 없으면 빈 쪽이 나올 때까지 읽는다(누락이 조용히 생기지 않게)
          const totalPages = Number.isFinite(Number(j.totalPages)) && j.totalPages !== null ? Number(j.totalPages) : Infinity
          if (!j.data.length || page >= totalPages) break
        }
      }
      return [...byNo.values()]
    },
    /** 주문번호 한 건(가이드 23번 /orderListSearch '주문번호' — 상품 줄 orderList 포함). 없으면 null */
    async orderByNo(orderNumber, { days = 60 } = {}) {
      for (const [beginDay, endDay] of windows(days)) {
        const j = await call('POST', '/orderListSearch', { pageCount: 100, page: 1, beginDay, endDay, searchType: '주문번호', searchString: String(orderNumber) })
        const hit = (Array.isArray(j.data) ? j.data : []).find((o) => String(o.orderNumber) === String(orderNumber))
        if (hit) return hit
      }
      return null
    },
  }
}

// 택배사명 → 쿠팡 코드표(lib/coupang-carrier-map.mjs)가 아는 이름. 모르는 이름은 원문 그대로(쿠팡 등록 단계에서 미매핑으로 사람 확인)
const CARRIER_CANON = [[/CJ|대한통운/, 'CJ대한통운'], [/한진/, '한진택배'], [/롯데|현대택배/, '롯데택배'], [/우체국/, '우체국택배'], [/로젠/, '로젠택배'], [/경동/, '경동택배'], [/대신/, '대신택배']]
export function canonCarrier(name) {
  const s = String(name ?? '').trim()
  if (!s) return null
  return CARRIER_CANON.find(([re]) => re.test(s))?.[1] ?? s
}

/** 주문 시각 "YYYY-MM-DD HH:MM:SS"(KST) → ISO */
export function domeatozDateIso(s) {
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)/.exec(String(s ?? ''))
  const d = m ? new Date(`${m[1]}T${m[2]}+09:00`) : null
  return d && !Number.isNaN(d.getTime()) ? d.toISOString() : null
}

/** API 주문 행 → 송장 싱크 공통 형식 {found, status, cancelLike, invoiceRaw, carrier, actualPaid} (local-cron-ggsan-sync.mjs trackRow) */
export function normalizeDomeatozOrder(o) {
  if (!o) return { found: false }
  const code = o.status == null || o.status === '' ? NaN : Number(o.status) // Number(null)=0 이 '결제완료'로 보이지 않게
  const total = Number(o.totalAmount)
  const sum = (Number(o.totalPrice) || 0) + (Number(o.deliveryPrice) || 0) + (Number(o.addDeliveryPrice) || 0)
  return {
    found: true,
    status: DOMEATOZ_ORDER_STATUS[code] ?? `상태 ${o.status ?? '없음'}`,
    cancelLike: Number.isFinite(code) && code >= 4,             // 취소·반품 계열은 사람 확인(자동취소 금지)
    invoiceRaw: o.deliveryNumber ? String(o.deliveryNumber) : null,
    carrier: o.deliveryNumber ? canonCarrier(o.deliveryName) : null,
    actualPaid: Number.isFinite(total) && total >= (Number(o.totalPrice) || 0) && total > 0 ? total : (sum || null),
  }
}
