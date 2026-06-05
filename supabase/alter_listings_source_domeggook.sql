-- jimscanner_coupang_listings.source 에 'domeggook'(도매꾹) 허용 추가 (2026-06-06)
-- 기존: (ggsan AND source_goods_no NOT NULL) OR manual
-- 도매꾹 멀티 도매처 소싱 등록(domeggook-register-one.mjs)을 위해 domeggook 추가.
ALTER TABLE jimscanner_coupang_listings DROP CONSTRAINT IF EXISTS jimscanner_coupang_listings_source_check;
ALTER TABLE jimscanner_coupang_listings ADD CONSTRAINT jimscanner_coupang_listings_source_check
  CHECK (
    (source = 'ggsan' AND source_goods_no IS NOT NULL)
    OR source = 'manual'
    OR (source = 'domeggook' AND source_goods_no IS NOT NULL)
  );
