/**
 * ggsan 택배사명 → 쿠팡 deliveryCompanyCode 매핑.
 *
 * 설계 캐논: docs/plan-ggsan-coupang-invoice-sync.md ④/⑤/⑨ (택배사 hard gate).
 * 승인 결정상 ggsan 실관측 단일값인 CJ대한통운=CJGLS 만 확정한다.
 * 추측 등록은 절대 금지 — 매핑 없으면 null 을 반환하고, 호출측이
 * needs_attention='택배사 미매핑' 으로 올려 자동등록을 abort 한다(검토 C-6).
 *
 * 그 외 택배사(롯데/로젠/GS/우체국 등)는 쿠팡 deliveries 코드 확정 후 추가.
 * (쿠팡 deliveryCompanyCode 코드표/조회 API로 1회 검증 후 CARRIER_MAP에 등록할 것)
 */

// 확정 매핑 — 쿠팡 공식 택배사 코드표(developers.coupang.com/ko/api/logistics/courier-code, 2026-08-20 확인).
// 키는 정규화(공백제거) 후 비교한다. register-invoice/route.ts · order-server.mjs 의 CARRIER_MAP 과 동일하게 유지할 것.
export const CARRIER_MAP = {
  CJ대한통운: 'CJGLS',
  CJGLS: 'CJGLS',
  CJ택배: 'CJGLS',
  한진택배: 'HANJIN',
  한진: 'HANJIN',
  롯데택배: 'HYUNDAI', // 쿠팡 코드표: HYUNDAI=롯데택배(구 현대택배)
  우체국택배: 'EPOST',
  우체국: 'EPOST',
  로젠택배: 'KGB', // 쿠팡 코드표: KGB=로젠택배
  로젠: 'KGB',
  경동택배: 'KDEXP',
  대신택배: 'DAESIN',
};

/**
 * ggsan 택배사명을 쿠팡 deliveryCompanyCode로 변환.
 * @param {string|null|undefined} name ggsan 노출 택배사명(예 'CJ대한통운')
 * @returns {string|null} 쿠팡 deliveryCompanyCode. 매핑 없으면 null
 *   (호출측이 needs_attention='택배사 미매핑' 처리)
 */
export function carrierToCode(name) {
  if (!name) return null;
  // 공백/탭/괄호류 제거 후 정규화 ('CJ 대한통운', 'CJ대한통운(택배)' 등 흡수)
  const norm = String(name).replace(/\s+/g, '').replace(/[()（）\[\]]/g, '');
  if (!norm) return null;
  return CARRIER_MAP[norm] ?? null;
}
