-- ────────────────────────────────────────────────────────────
-- SKU 리스팅 적합도 게이트 (PR-LISTING-QUALITY-1, 2026-05-20)
-- ────────────────────────────────────────────────────────────
-- ggsan SKU 의 image_url 과 title 을 평가해 위탁 셀러가
-- 그대로 상위 채널(스마트스토어/쿠팡/네이버)에 업로드 가능한지
-- 3등급 게이트(go / fix / reshoot) 로 분류한다.
--
-- 점수 산출 주체: scripts/score-listing-quality.mjs (로컬 cron)
--   - image_score (0~10): 이미지 URL 존재·해상도 추정·확장자·CDN 신뢰도·
--                          워터마크/모델/배경 휴리스틱 (LLM 비전 보강은 향후)
--   - title_score (0~10): 한글 가독성·길이·금칙어·중복어·검색어 매칭
--   - issues jsonb: 점수 차감 사유 배열 (UI 토픽 차트용)
--
-- 점수는 recommend 보드에 quality_gate 컬럼으로 조인되어
-- 'reshoot' 등급 SKU 는 자동 보류 후보로 표시된다.
-- ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS jimscanner_ggsan_listing_quality (
  goods_no      text PRIMARY KEY REFERENCES jimscanner_ggsan_products(goods_no) ON DELETE CASCADE,
  image_score   numeric(4,2) NOT NULL DEFAULT 0,    -- 0.00 ~ 10.00
  title_score   numeric(4,2) NOT NULL DEFAULT 0,    -- 0.00 ~ 10.00
  overall_score numeric(4,2) GENERATED ALWAYS AS ((image_score + title_score) / 2) STORED,
  gate          text NOT NULL DEFAULT 'fix',        -- 'go' (≥7.5) | 'fix' (≥4.5) | 'reshoot' (<4.5)
  issues        jsonb NOT NULL DEFAULT '[]'::jsonb, -- 차감 사유: [{code, label, dim, weight}]
  computed_at   timestamptz NOT NULL DEFAULT now(),
  scorer_version text NOT NULL DEFAULT 'heuristic-v1'
);

CREATE INDEX IF NOT EXISTS jimscanner_ggsan_listing_quality_gate
  ON jimscanner_ggsan_listing_quality(gate, overall_score DESC);

CREATE INDEX IF NOT EXISTS jimscanner_ggsan_listing_quality_score
  ON jimscanner_ggsan_listing_quality(overall_score DESC);

CREATE INDEX IF NOT EXISTS jimscanner_ggsan_listing_quality_computed
  ON jimscanner_ggsan_listing_quality(computed_at DESC);

ALTER TABLE jimscanner_ggsan_listing_quality ENABLE ROW LEVEL SECURITY;
-- service_role 만.

-- 등급 자동 산출: 트리거로 gate 컬럼을 overall_score 에서 파생.
CREATE OR REPLACE FUNCTION jimscanner_ggsan_listing_quality_set_gate()
RETURNS trigger AS $$
BEGIN
  NEW.gate := CASE
    WHEN NEW.image_score < 3.0 OR NEW.title_score < 3.0 THEN 'reshoot'
    WHEN (NEW.image_score + NEW.title_score) / 2 >= 7.5 THEN 'go'
    WHEN (NEW.image_score + NEW.title_score) / 2 >= 4.5 THEN 'fix'
    ELSE 'reshoot'
  END;
  NEW.computed_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS jimscanner_ggsan_listing_quality_gate_trg
  ON jimscanner_ggsan_listing_quality;
CREATE TRIGGER jimscanner_ggsan_listing_quality_gate_trg
  BEFORE INSERT OR UPDATE ON jimscanner_ggsan_listing_quality
  FOR EACH ROW EXECUTE FUNCTION jimscanner_ggsan_listing_quality_set_gate();

-- 보드 뷰: recommend / ggsan 카탈로그와 즉시 조인 가능한 평탄화 뷰.
CREATE OR REPLACE VIEW jimscanner_ggsan_listing_quality_v AS
SELECT
  p.goods_no,
  p.title,
  p.cate_cd,
  p.cate_label,
  p.price_krw,
  p.image_url,
  p.detail_url,
  p.is_imminent,
  p.last_seen_at,
  COALESCE(q.image_score, 0)::numeric(4,2)   AS image_score,
  COALESCE(q.title_score, 0)::numeric(4,2)   AS title_score,
  COALESCE(q.overall_score, 0)::numeric(4,2) AS overall_score,
  COALESCE(q.gate, 'unscored')               AS gate,
  COALESCE(q.issues, '[]'::jsonb)            AS issues,
  q.computed_at,
  q.scorer_version
FROM jimscanner_ggsan_products p
LEFT JOIN jimscanner_ggsan_listing_quality q ON q.goods_no = p.goods_no;
