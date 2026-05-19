-- ─────────────────────────────────────────────────────────────
-- 트렌드 레이더 v4 — 모방 클리프 추적기 (Imitation Cliff Tracker)
-- ─────────────────────────────────────────────────────────────
-- pin/listed 상품의 SERP 카피캣 listing 수를 일별로 추적.
-- supply-side commoditization 속도(반감기) 측정 → 진입 윈도우 D-day.
--
-- RLS: enable + 정책 정의 X → service-role 만 접근. UI 는 admin-supabase 경유.
-- ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS jimscanner_trends_imitation_track (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES jimscanner_trends_products(id) ON DELETE CASCADE,

  observed_at timestamptz NOT NULL DEFAULT now(),
  observed_date date NOT NULL DEFAULT (now() AT TIME ZONE 'Asia/Seoul')::date,

  -- 검색 SERP 결과 수 (Naver Shopping / Coupang)
  serp_listing_count int NOT NULL DEFAULT 0,
  -- 직전 관측 대비 24h 신규 출현 listing 수
  new_listings_24h int NOT NULL DEFAULT 0,
  -- 상위 셀러 식별자(외부 mallName/productId) — JSON array of string
  top_seller_ids jsonb NOT NULL DEFAULT '[]'::jsonb,

  median_price_krw numeric,
  sample_titles jsonb NOT NULL DEFAULT '[]'::jsonb,   -- 상위 N 샘플 제목

  -- 어디서 관측했는지 (naver_shopping_search / coupang_serp / stub)
  serp_source text NOT NULL DEFAULT 'naver_shopping_search',
  -- 검색에 사용한 쿼리 (canonical_name 또는 alias)
  query text,

  raw_payload jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS jimscanner_trends_imitation_track_product_at
  ON jimscanner_trends_imitation_track(product_id, observed_at DESC);

CREATE INDEX IF NOT EXISTS jimscanner_trends_imitation_track_date
  ON jimscanner_trends_imitation_track(observed_date DESC);

CREATE UNIQUE INDEX IF NOT EXISTS jimscanner_trends_imitation_track_unique_day
  ON jimscanner_trends_imitation_track(product_id, observed_date, serp_source);

ALTER TABLE jimscanner_trends_imitation_track ENABLE ROW LEVEL SECURITY;
