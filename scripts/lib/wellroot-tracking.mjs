/**
 * 웰루트B2B(Cafe24) 주문 추적 — 구현은 scripts/lib/cafe24-tracking.mjs(AuthSSL Cafe24 공통)로 이관(2026-09-27).
 * 기존 호출부 호환용 얇은 래퍼. 실측·함정 메모는 cafe24-tracking.mjs 머리말 참고.
 */
import { withCafe24Session, fetchCafe24Order } from './cafe24-tracking.mjs'

export const WELLROOT_TRACKING_CONF = (env) => ({ base: env.WELLROOT_BASE_URL || 'https://wellrootb2b.com', user: env.WELLROOT_USER, pass: env.WELLROOT_PASS, label: 'wellroot' })

/** 세션 열고 fn(page, base) 실행 후 닫는다. 로그인 실패 시 throw('wellroot login failed'). */
export function withWellrootSession(env, fn) {
  return withCafe24Session(WELLROOT_TRACKING_CONF(env), fn)
}

/** 주문 1건 상세 파싱 — 반환 형식은 fetchCafe24Order 와 동일 */
export function fetchWellrootOrder(page, base, orderId) {
  return fetchCafe24Order(page, base, orderId, 'wellroot')
}
