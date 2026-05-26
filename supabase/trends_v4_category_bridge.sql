-- ────────────────────────────────────────────────────────────
-- 카테고리 미스매치 히트맵 — trend × ggsan 브릿지
-- 2026-05-27
-- ────────────────────────────────────────────────────────────
-- 행: ggsan cate_cd (22종) · 열: trend category_top / classified_category
-- 셀: weight 가중치 (운영자/LLM 이 수정 가능)
-- ────────────────────────────────────────────────────────────

-- 1) 매핑 테이블
CREATE TABLE IF NOT EXISTS jimscanner_trends_category_bridge (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trend_category text NOT NULL,            -- jimscanner_trends_keywords.category_top 또는 classified_category 값
  trend_category_kind text NOT NULL        -- 어느 컬럼 매칭인지
    CHECK (trend_category_kind IN ('category_top', 'classified_category')),
  ggsan_cate_cd text NOT NULL,             -- '001' ~ '022'
  weight numeric NOT NULL DEFAULT 1.0      -- 0.0 ~ 1.0 가중치 (부분 매칭)
    CHECK (weight >= 0 AND weight <= 1),
  note text,                               -- 사람이 보는 메모
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (trend_category, trend_category_kind, ggsan_cate_cd)
);

CREATE INDEX IF NOT EXISTS jimscanner_trends_category_bridge_trend
  ON jimscanner_trends_category_bridge(trend_category, trend_category_kind);
CREATE INDEX IF NOT EXISTS jimscanner_trends_category_bridge_ggsan
  ON jimscanner_trends_category_bridge(ggsan_cate_cd);

ALTER TABLE jimscanner_trends_category_bridge ENABLE ROW LEVEL SECURITY;
-- 어드민(service-role) 만.

-- updated_at 트리거
CREATE OR REPLACE FUNCTION jimscanner_trends_category_bridge_set_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS jimscanner_trends_category_bridge_updated_at
  ON jimscanner_trends_category_bridge;
CREATE TRIGGER jimscanner_trends_category_bridge_updated_at
  BEFORE UPDATE ON jimscanner_trends_category_bridge
  FOR EACH ROW EXECUTE FUNCTION jimscanner_trends_category_bridge_set_updated_at();

-- ────────────────────────────────────────────────────────────
-- 2) 초기 시드 — 건강기능식품 / 식품 / 생활 관련 트렌드 카테고리 → ggsan 22종
-- 운영자가 어드민에서 추가/수정 가능 (현재는 SQL 으로 시드).
-- ────────────────────────────────────────────────────────────
INSERT INTO jimscanner_trends_category_bridge
  (trend_category, trend_category_kind, ggsan_cate_cd, weight, note)
VALUES
  -- naver_shopping_insight category_top
  ('식품', 'category_top', '012', 0.6, '식품 → 식품분말'),
  ('식품', 'category_top', '013', 0.6, '식품 → 가공식품기타'),
  ('식품', 'category_top', '014', 0.7, '식품 → 신선식품'),
  ('식품', 'category_top', '010', 0.5, '식품 → 전통건강식품'),
  ('생활/건강', 'category_top', '001', 0.7, '생활/건강 → 장건강'),
  ('생활/건강', 'category_top', '002', 0.7, '생활/건강 → 눈건강'),
  ('생활/건강', 'category_top', '003', 0.7, '생활/건강 → 간건강'),
  ('생활/건강', 'category_top', '005', 0.7, '생활/건강 → 혈행건강'),
  ('생활/건강', 'category_top', '006', 0.7, '생활/건강 → 관절건강'),
  ('생활/건강', 'category_top', '007', 0.8, '생활/건강 → 면역건강'),
  ('생활/건강', 'category_top', '008', 0.7, '생활/건강 → 체지방'),
  ('생활/건강', 'category_top', '009', 0.6, '생활/건강 → 건강기능식품기타'),
  ('생활/건강', 'category_top', '011', 0.6, '생활/건강 → 전립선건강'),
  ('출산/육아', 'category_top', '018', 0.4, '출산/육아 → 반려동물용품(약매칭)'),
  -- LLM classified_category
  ('푸드', 'classified_category', '012', 0.6, 'LLM 푸드 → 식품분말'),
  ('푸드', 'classified_category', '013', 0.6, 'LLM 푸드 → 가공식품기타'),
  ('푸드', 'classified_category', '014', 0.7, 'LLM 푸드 → 신선식품'),
  ('푸드', 'classified_category', '010', 0.6, 'LLM 푸드 → 전통건강식품'),
  ('헬스', 'classified_category', '001', 0.7, 'LLM 헬스 → 장건강'),
  ('헬스', 'classified_category', '002', 0.7, 'LLM 헬스 → 눈건강'),
  ('헬스', 'classified_category', '003', 0.7, 'LLM 헬스 → 간건강'),
  ('헬스', 'classified_category', '005', 0.7, 'LLM 헬스 → 혈행건강'),
  ('헬스', 'classified_category', '006', 0.7, 'LLM 헬스 → 관절건강'),
  ('헬스', 'classified_category', '007', 0.8, 'LLM 헬스 → 면역건강'),
  ('헬스', 'classified_category', '008', 0.7, 'LLM 헬스 → 체지방'),
  ('헬스', 'classified_category', '009', 0.6, 'LLM 헬스 → 건강기능식품기타'),
  ('헬스', 'classified_category', '011', 0.6, 'LLM 헬스 → 전립선건강'),
  ('라이프', 'classified_category', '015', 0.4, 'LLM 라이프 → 오프라인전용(약)'),
  ('라이프', 'classified_category', '018', 0.5, 'LLM 라이프 → 반려동물용품'),
  ('쇼핑', 'classified_category', '020', 0.4, 'LLM 쇼핑 → 임박특가(딜)')
ON CONFLICT (trend_category, trend_category_kind, ggsan_cate_cd) DO NOTHING;
