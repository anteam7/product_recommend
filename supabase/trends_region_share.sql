-- 트렌드 레이더 — 지역별 디맨드 편중도 (2026-05-19)
-- naver_shopping_region 소스: 핀/키워드 × 17개 시도 검색 비중.
-- 균등분포(1/17) 대비 KL-divergence 로 '지역 편중도 점수' 산출.

-- ─────────────────────────────────────────
-- 1) 시도 단위 검색 비중
CREATE TABLE IF NOT EXISTS jimscanner_trends_region_share (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source text NOT NULL DEFAULT 'naver_shopping_region', -- 'naver_shopping_region'
  keyword text NOT NULL,
  region_code text NOT NULL,            -- 'KR-11' ~ 'KR-50' (ISO 3166-2 KR)
  region_name text NOT NULL,            -- '서울', '경기', '강원', ...
  share_ratio numeric NOT NULL,         -- 0~1 (정규화된 비중. 합=1)
  raw_ratio numeric,                    -- Naver 원본 ratio (0~100, 정규화 전)
  collected_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS jimscanner_trends_region_share_keyword_at
  ON jimscanner_trends_region_share(keyword, collected_at DESC);
CREATE INDEX IF NOT EXISTS jimscanner_trends_region_share_source_at
  ON jimscanner_trends_region_share(source, collected_at DESC);
CREATE INDEX IF NOT EXISTS jimscanner_trends_region_share_region
  ON jimscanner_trends_region_share(region_code, collected_at DESC);

ALTER TABLE jimscanner_trends_region_share ENABLE ROW LEVEL SECURITY;
-- service-role 만 접근.

COMMENT ON TABLE jimscanner_trends_region_share IS
  '핀/키워드 × 17개 시도 검색 비중. KL-divergence(균등=1/17)로 지역 편중도 점수 산출.';

-- ─────────────────────────────────────────
-- 2) 시도별 편중도 요약 뷰 — 가장 최근 collected_at 기준
CREATE OR REPLACE VIEW jimscanner_trends_region_skew AS
WITH latest AS (
  SELECT keyword, MAX(collected_at) AS last_at
  FROM jimscanner_trends_region_share
  GROUP BY keyword
),
shares AS (
  SELECT r.keyword, r.region_code, r.region_name, r.share_ratio, r.collected_at
  FROM jimscanner_trends_region_share r
  JOIN latest l ON l.keyword = r.keyword AND l.last_at = r.collected_at
),
kl AS (
  SELECT
    keyword,
    -- KL-divergence vs uniform(1/17).
    -- D_KL(P||U) = sum( p * log(p / (1/17)) ) = sum( p * (log(p) + log(17)) )
    SUM(
      CASE WHEN share_ratio > 0
        THEN share_ratio * (ln(share_ratio) + ln(17.0))
        ELSE 0
      END
    ) AS kl_divergence,
    MAX(collected_at) AS collected_at
  FROM shares
  GROUP BY keyword
)
SELECT
  k.keyword,
  k.kl_divergence,
  k.collected_at,
  -- Top3 지역을 JSONB 배열로
  (
    SELECT jsonb_agg(jsonb_build_object(
      'region_code', s.region_code,
      'region_name', s.region_name,
      'share_ratio', s.share_ratio
    ) ORDER BY s.share_ratio DESC)
    FROM (
      SELECT region_code, region_name, share_ratio
      FROM shares s2
      WHERE s2.keyword = k.keyword
      ORDER BY s2.share_ratio DESC
      LIMIT 3
    ) s
  ) AS top3_regions
FROM kl k;

COMMENT ON VIEW jimscanner_trends_region_skew IS
  '핀별 지역 편중 요약: KL-divergence(균등 1/17 대비) + Top3 시도 share.';

-- ─────────────────────────────────────────
-- 3) seed: naver_shopping_region 수집 대상 (운영자가 pinned 키워드 자동 + 수동 추가)
-- collect 함수는 seed 가 없으면 jimscanner_trends_keywords.pinned=true 자동 사용.
INSERT INTO jimscanner_trends_seeds (source, kind, label, config, display_order) VALUES
  ('naver_shopping_region', 'category', '식품',         '{"cid":"50000006","name":"식품"}'::jsonb,         0),
  ('naver_shopping_region', 'category', '생활/건강',    '{"cid":"50000008","name":"생활/건강"}'::jsonb,    1),
  ('naver_shopping_region', 'category', '디지털/가전',  '{"cid":"50000003","name":"디지털/가전"}'::jsonb,  2)
ON CONFLICT DO NOTHING;
