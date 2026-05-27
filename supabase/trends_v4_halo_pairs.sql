-- ────────────────────────────────────────────────────────────
-- 히어로 SKU 후광수요(Halo) — 보완재·액세서리 선점 보드 (2026-05-27)
-- ────────────────────────────────────────────────────────────
-- 급상승 hero 키워드/SKU 검출 후 그것의 보완재(액세서리·소모품·호환부품)를
-- 사전 매핑해 후행 수요 surge를 포착한다.
--
-- (1) jimscanner_trends_products + jimscanner_trends_keywords(naver_search_trend)
--     에서 최근 score 급상승 hero 후보 추출 → halo_hero_candidates 뷰
-- (2) jimscanner_halo_pairs: hero ↔ 보완재 매핑 테이블 (LLM/룰 채움)
-- (3) lag/lead 패턴은 naver_shopping_insight 시계열로 측정 → halo_lag_signal 뷰
-- (4) ggsan recommend 와 매칭은 RPC + 페이지에서 LIKE join
-- ────────────────────────────────────────────────────────────

-- ─────────────────────────────────────────
-- 1) halo pair 테이블 (hero ↔ 보완재 그래프)
CREATE TABLE IF NOT EXISTS jimscanner_halo_pairs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hero_keyword text NOT NULL,                    -- 본체 (예: '아이폰15')
  complement_keyword text NOT NULL,              -- 보완재 (예: '아이폰15 케이스')
  relation_type text NOT NULL,                   -- 'case' | 'film' | 'mount' | 'refill' | 'filter' | 'battery' | 'strap' | 'cable' | 'consumable' | 'other'
  confidence numeric NOT NULL DEFAULT 0.5,       -- 0~1 매핑 신뢰도
  source text NOT NULL DEFAULT 'heuristic',      -- 'heuristic' | 'llm' | 'manual'
  notes text,                                    -- 근거/메모
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (hero_keyword, complement_keyword, relation_type)
);

CREATE INDEX IF NOT EXISTS jimscanner_halo_pairs_hero
  ON jimscanner_halo_pairs(hero_keyword)
  WHERE is_active;
CREATE INDEX IF NOT EXISTS jimscanner_halo_pairs_complement
  ON jimscanner_halo_pairs(complement_keyword)
  WHERE is_active;

ALTER TABLE jimscanner_halo_pairs ENABLE ROW LEVEL SECURITY;

-- updated_at 트리거
CREATE OR REPLACE FUNCTION jimscanner_halo_pairs_set_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS jimscanner_halo_pairs_updated_at ON jimscanner_halo_pairs;
CREATE TRIGGER jimscanner_halo_pairs_updated_at
  BEFORE UPDATE ON jimscanner_halo_pairs
  FOR EACH ROW EXECUTE FUNCTION jimscanner_halo_pairs_set_updated_at();

-- ─────────────────────────────────────────
-- 2) hero 후보 뷰: 최근 14일 score 급상승 키워드
-- jimscanner_trends_keywords 에서 동일 키워드의 최근 7일 vs 이전 7일 비교
CREATE OR REPLACE VIEW jimscanner_halo_hero_candidates AS
WITH recent AS (
  SELECT
    keyword,
    COUNT(*) FILTER (WHERE collected_at >= now() - interval '7 days') AS recent_hits,
    COUNT(*) FILTER (WHERE collected_at >= now() - interval '14 days'
                       AND collected_at < now() - interval '7 days') AS prev_hits,
    AVG(volume_relative) FILTER (WHERE collected_at >= now() - interval '7 days') AS recent_volume,
    AVG(volume_relative) FILTER (WHERE collected_at >= now() - interval '14 days'
                                   AND collected_at < now() - interval '7 days') AS prev_volume,
    MAX(category_top) AS category_top,
    MAX(collected_at) AS last_seen_at,
    array_agg(DISTINCT source) AS sources
  FROM jimscanner_trends_keywords
  WHERE collected_at >= now() - interval '21 days'
    AND source IN ('naver_search_trend', 'naver_shopping_hot', 'naver_shopping_insight', 'naver_tvtime')
    AND keyword IS NOT NULL
    AND char_length(keyword) >= 2
  GROUP BY keyword
)
SELECT
  keyword AS hero_keyword,
  recent_hits,
  prev_hits,
  COALESCE(recent_volume, 0)::numeric AS recent_volume,
  COALESCE(prev_volume, 0)::numeric AS prev_volume,
  CASE
    WHEN COALESCE(prev_hits, 0) = 0 AND recent_hits > 0 THEN recent_hits::numeric  -- 신규
    WHEN COALESCE(prev_hits, 0) = 0 THEN 0
    ELSE (recent_hits::numeric / NULLIF(prev_hits, 0))
  END AS surge_ratio,
  category_top,
  last_seen_at,
  sources
FROM recent
WHERE recent_hits >= 2
  AND (
    COALESCE(prev_hits, 0) = 0
    OR recent_hits::numeric / NULLIF(prev_hits, 0) >= 1.3
  );

-- ─────────────────────────────────────────
-- 3) 보완재 lag/lead 시그널 뷰
-- 같은 hero ↔ complement 쌍에 대해 hero 가 먼저 떴는지 complement 가 먼저 떴는지
-- (시계열은 jimscanner_trends_keywords 의 collected_at 분포로 근사)
CREATE OR REPLACE VIEW jimscanner_halo_lag_signal AS
WITH hero_first AS (
  SELECT keyword, MIN(collected_at) AS first_seen_at,
                  MAX(collected_at) AS last_seen_at,
                  COUNT(*) AS hits
  FROM jimscanner_trends_keywords
  WHERE collected_at >= now() - interval '60 days'
  GROUP BY keyword
)
SELECT
  p.id AS pair_id,
  p.hero_keyword,
  p.complement_keyword,
  p.relation_type,
  h.first_seen_at AS hero_first_seen,
  c.first_seen_at AS complement_first_seen,
  CASE
    WHEN h.first_seen_at IS NULL OR c.first_seen_at IS NULL THEN NULL
    ELSE EXTRACT(EPOCH FROM (c.first_seen_at - h.first_seen_at)) / 86400.0
  END AS lag_days,  -- 양수 = 보완재가 hero 보다 늦게 떴음 (후행), 음수 = 선행
  h.hits AS hero_hits,
  c.hits AS complement_hits
FROM jimscanner_halo_pairs p
LEFT JOIN hero_first h ON h.keyword = p.hero_keyword
LEFT JOIN hero_first c ON c.keyword = p.complement_keyword
WHERE p.is_active;

-- ─────────────────────────────────────────
-- 4) origin 메타 — 핀 발행 시 hero_keyword 기록 (jimscanner_trends_keywords.notes 활용)
-- 별도 컬럼 추가는 hop 줄이려고 생략. notes 에 'halo_origin:<hero>' prefix 로 기록.

COMMENT ON TABLE jimscanner_halo_pairs IS
  '히어로 SKU ↔ 보완재(액세서리·소모품) 매핑. trend-radar/halo-demand 보드용.';
