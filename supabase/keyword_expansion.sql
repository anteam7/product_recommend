-- 자동완성 BFS long-tail 키워드 확장 트리 — 2026-05-18
-- jimscanner_trends_products 의 상위 N개 키워드를 시드로 삼아,
-- Naver / Google 자동완성을 depth=2~3 BFS 로 펼친 후
-- 기존 trends_products 와 매칭되지 않는 노드를 '공백 후보' 로 표시.

CREATE TABLE IF NOT EXISTS jimscanner_keyword_expansion (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seed_keyword text NOT NULL,                      -- BFS 의 루트 키워드 (trends_products.canonical_name)
  expanded_keyword text NOT NULL,                  -- 자동완성으로 펼친 키워드
  depth int NOT NULL,                              -- 0=seed, 1=seed의 자동완성, 2=…
  parent_keyword text,                             -- 같은 트리 내 부모. depth=0 이면 NULL.
  source text NOT NULL,                            -- 'google_suggest' / 'naver_suggest'
  est_volume numeric,                              -- 추정 볼륨 (자동완성 순위 역수 등 — 옵션)
  mapped_product_id uuid REFERENCES jimscanner_trends_products(id) ON DELETE SET NULL,
  mapped_at timestamptz,                           -- 매칭 시도가 끝난 시점 (성공/실패 무관)
  is_gap boolean GENERATED ALWAYS AS (mapped_product_id IS NULL AND mapped_at IS NOT NULL) STORED,
  collected_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (seed_keyword, expanded_keyword, source)
);

CREATE INDEX IF NOT EXISTS jimscanner_keyword_expansion_seed_depth
  ON jimscanner_keyword_expansion(seed_keyword, depth);
CREATE INDEX IF NOT EXISTS jimscanner_keyword_expansion_gap
  ON jimscanner_keyword_expansion(collected_at DESC)
  WHERE mapped_product_id IS NULL AND mapped_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS jimscanner_keyword_expansion_parent
  ON jimscanner_keyword_expansion(parent_keyword);

ALTER TABLE jimscanner_keyword_expansion ENABLE ROW LEVEL SECURITY;
-- service_role 만 접근.
