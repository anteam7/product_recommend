-- ────────────────────────────────────────────────────────────
-- ggsan 메타데이터 드리프트 시계열 (2026-05-27)
-- ────────────────────────────────────────────────────────────
-- 목적: 도매몰이 운영자 통보 없이 title / image_url / cate_cd / brand /
--       옵션·raw_payload 을 바꾸면 쿠팡에 이미 등록된 위탁 리스팅과
--       정합성이 깨진다. 변경 발생 시점을 attr 단위로 보존한다.
--
-- 1행 = (goods_no, attr, changed_at) 의 1개 속성 변경 이벤트
-- ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS jimscanner_ggsan_meta_drift (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  goods_no text NOT NULL REFERENCES jimscanner_ggsan_products(goods_no) ON DELETE CASCADE,
  attr text NOT NULL,                       -- 'title' | 'image_url' | 'cate_cd' | 'brand' | 'options' | 'price_text' | ...
  old_value text,                            -- 직전 스냅샷 값 (긴 raw_payload 는 hash/요약)
  new_value text,                            -- 현재 값
  similarity double precision,               -- title 의 경우 jaccard 또는 임베딩 cos. NULL 이면 미적용
  severity text NOT NULL DEFAULT 'LOW',      -- 'HIGH' | 'MID' | 'LOW'
  reason text,                               -- 룰 + LLM 보조 판정 근거 ("image_url changed", "title jaccard=0.41")
  changed_at timestamptz NOT NULL DEFAULT now(),
  detected_by text NOT NULL DEFAULT 'ggsan-detail-dump', -- 어느 collector 가 감지했는지
  resolved boolean NOT NULL DEFAULT false,   -- 운영자가 '확인 완료' 토글
  resolved_at timestamptz,
  resolved_by text
);

CREATE INDEX IF NOT EXISTS jimscanner_ggsan_meta_drift_goods_at
  ON jimscanner_ggsan_meta_drift(goods_no, changed_at DESC);
CREATE INDEX IF NOT EXISTS jimscanner_ggsan_meta_drift_severity_at
  ON jimscanner_ggsan_meta_drift(severity, changed_at DESC);
CREATE INDEX IF NOT EXISTS jimscanner_ggsan_meta_drift_unresolved
  ON jimscanner_ggsan_meta_drift(changed_at DESC) WHERE NOT resolved;

ALTER TABLE jimscanner_ggsan_meta_drift ENABLE ROW LEVEL SECURITY;
-- 서비스 롤(admin) 만. 익명 정책 없음.

-- ────────────────────────────────────────────────────────────
-- 최근 N일 인터셉트 뷰: 쿠팡 등록 SKU 와 drift 를 조인
-- ────────────────────────────────────────────────────────────
-- 어드민 페이지에서 '빨간 인터셉트 카드' 의 데이터 소스.
-- DROP VIEW IF EXISTS 후 CREATE 로 idempotent 갱신.
DROP VIEW IF EXISTS jimscanner_ggsan_meta_drift_intercepts;
CREATE VIEW jimscanner_ggsan_meta_drift_intercepts AS
SELECT
  d.id              AS drift_id,
  d.goods_no,
  d.attr,
  d.old_value,
  d.new_value,
  d.severity,
  d.reason,
  d.similarity,
  d.changed_at,
  d.resolved,
  p.title           AS current_title,
  p.image_url       AS current_image_url,
  p.cate_label      AS current_cate_label,
  p.brand           AS current_brand,
  p.detail_url,
  l.id              AS listing_id,
  l.seller_product_id,
  l.product_id,
  l.registered_title,
  l.status          AS listing_status,
  l.displayable     AS listing_displayable
FROM jimscanner_ggsan_meta_drift d
JOIN jimscanner_ggsan_products p
  ON p.goods_no = d.goods_no
LEFT JOIN jimscanner_coupang_listings l
  ON l.source = 'ggsan' AND l.source_goods_no = d.goods_no
WHERE d.changed_at > now() - interval '14 days';
