-- ────────────────────────────────────────────────────────────
-- PR-IP: 가품·상표권 침해 리스크 게이트 (2026-06-01)
-- ────────────────────────────────────────────────────────────
-- 쿠팡 위탁 셀러 계정 정지 1순위 = 가품·상표권 침해.
-- 기존 4점수(trend/commerce/supplier/competition)에 빠진 '법적 리스크' 축을
-- 별도 컬럼으로 산출한다. 인증·규제(#1)/리콜(#24)의 '판매 적격/안전'과는 별개 축.
--
-- 입력: jimscanner_trends_aliases(alias/source) + jimscanner_trends_supplier(title/supplier_source)
-- 라벨: classify-trends-llm 확장 프롬프트가 부여 ('generic' | 'brand_mention' | 'likely_counterfeit')
-- 고위험 규칙: 해외 도매(1688/aliexpress/taobao) 소싱 + 브랜드 토큰 동시 충족
--
-- 패턴 재사용: trends_v4_llm_classification.sql (컬럼 ALTER + 부분 인덱스)
-- 노출 정책: products 는 이미 RLS enable (service-role 만). 뷰도 동일 계정으로만 접근.
-- ────────────────────────────────────────────────────────────

-- 1) jimscanner_trends_products 에 IP 리스크 컬럼 추가
ALTER TABLE jimscanner_trends_products
  ADD COLUMN IF NOT EXISTS ip_risk_label text,        -- 'generic' | 'brand_mention' | 'likely_counterfeit'
  ADD COLUMN IF NOT EXISTS ip_risk_score numeric,     -- 0~100 (높을수록 위험)
  ADD COLUMN IF NOT EXISTS ip_risk_tokens jsonb,       -- 탐지된 브랜드/상표 토큰 배열 [{token, kind, source}]
  ADD COLUMN IF NOT EXISTS ip_risk_reasons text,       -- 사람이 읽을 사유
  ADD COLUMN IF NOT EXISTS ip_classified_at timestamptz,
  ADD COLUMN IF NOT EXISTS ip_classified_model text;

-- 아직 IP 분류 안 된 product 빠르게 집기 (cron 백필용)
CREATE INDEX IF NOT EXISTS jimscanner_trends_products_ip_unclassified
  ON jimscanner_trends_products(updated_at DESC)
  WHERE ip_classified_at IS NULL;

-- 라벨별 필터 (보드 3-band)
CREATE INDEX IF NOT EXISTS jimscanner_trends_products_ip_label
  ON jimscanner_trends_products(ip_risk_label, ip_risk_score DESC);

-- 2) IP 리스크 게이트 뷰
--    products 의 LLM 라벨 + supplier 의 해외 소싱 여부를 합쳐 최종 band 를 산출.
--    band: 'stop_risk'(정지위험) | 'caution'(주의) | 'safe_generic'(안전 제네릭) | 'unrated'
--    규칙:
--      - likely_counterfeit                              → stop_risk
--      - brand_mention  + 해외 도매(1688/ali/taobao) 보유 → stop_risk  (가품 합성 위험 최고)
--      - brand_mention  (해외 소싱 없음)                  → caution
--      - generic                                         → safe_generic
--      - 라벨 없음                                        → unrated
CREATE OR REPLACE VIEW jimscanner_trends_ip_risk_board AS
WITH overseas AS (
  SELECT
    s.product_id,
    bool_or(s.supplier_source IN ('1688', 'aliexpress', 'taobao', 'temu')) AS has_overseas,
    array_agg(DISTINCT s.supplier_source) AS supplier_sources
  FROM jimscanner_trends_supplier s
  GROUP BY s.product_id
)
SELECT
  p.id,
  p.canonical_name,
  p.category_top,
  p.category_mid,
  p.brand,
  p.ip_risk_label,
  p.ip_risk_score,
  p.ip_risk_tokens,
  p.ip_risk_reasons,
  p.ip_classified_at,
  p.alias_count,
  COALESCE(o.has_overseas, false) AS has_overseas_supplier,
  o.supplier_sources,
  CASE
    WHEN p.ip_risk_label IS NULL THEN 'unrated'
    WHEN p.ip_risk_label = 'likely_counterfeit' THEN 'stop_risk'
    WHEN p.ip_risk_label = 'brand_mention' AND COALESCE(o.has_overseas, false) THEN 'stop_risk'
    WHEN p.ip_risk_label = 'brand_mention' THEN 'caution'
    WHEN p.ip_risk_label = 'generic' THEN 'safe_generic'
    ELSE 'unrated'
  END AS risk_band
FROM jimscanner_trends_products p
LEFT JOIN overseas o ON o.product_id = p.id;

-- 뷰는 정의자(소유자) 권한 + 기반 테이블 RLS 를 따른다. 어드민(service-role) 만 조회.
