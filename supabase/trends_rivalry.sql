-- ─────────────────────────────────────────────────────────────
-- 트렌드 레이더 — 비교/대체 경쟁구도 마이닝 (rivalry, 2026-06-05)
-- ─────────────────────────────────────────────────────────────
-- 커뮤니티·검색 raw 텍스트(jimscanner_market_raw)에서 '비교·대체 발화'를
-- LLM 으로 추출해 방향성 그래프(challenger → incumbent)를 적재한다.
--   · 'A vs B'           → relation='vs'      (저울질, 무방향에 가깝지만 발화 주체 기준 from=관심상품)
--   · 'A 말고/대신 B'     → relation='replace' (from=incumbent 이탈, to=challenger 갈아타기 대상)
-- 동반언급(보완재)과 반대로 '대체재 경쟁'을 다룬다.
--
-- 노출 정책: 기존 jimscanner_trends_* 와 동일하게 RLS enable + 정책 정의 X
--   = service-role(어드민)만 접근.
-- 관련: scripts/mine-trends-rivalry.mjs, src/app/admin/(dashboard)/trend-radar/rivalry
-- ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS jimscanner_trends_rivalry (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- canonical 매핑 (있으면). 매핑 전이면 NULL, *_name 으로만 식별.
  from_product_id uuid REFERENCES jimscanner_trends_products(id) ON DELETE SET NULL,
  to_product_id   uuid REFERENCES jimscanner_trends_products(id) ON DELETE SET NULL,

  -- 방향성: from = 챌린저(갈아타려는 쪽) / to = 인커번트(현재 쓰던/이겨야 할 쪽)
  from_name text NOT NULL,       -- 챌린저 canonical 또는 raw 추출 명
  to_name   text NOT NULL,       -- 인커번트 canonical 또는 raw 추출 명

  relation text NOT NULL CHECK (relation IN ('vs', 'replace')),

  window text NOT NULL,          -- 시간 버킷 (ISO week, 예 '2026-W23') — 모멘텀 시계열용
  mention_count int NOT NULL DEFAULT 1,

  source text,                   -- 'clien_park' | '82cook' | 'natepan' | 'ppomppu' | 'dcinside' | 'naver' 등
  sample_quote text,             -- 대표 발화 한 줄 (디버깅·UI 근거)

  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  -- 같은 쌍·관계·버킷은 한 row 로 누적(mention_count 증가).
  UNIQUE (from_name, to_name, relation, window)
);

CREATE INDEX IF NOT EXISTS jimscanner_trends_rivalry_from
  ON jimscanner_trends_rivalry(from_product_id, window DESC);
CREATE INDEX IF NOT EXISTS jimscanner_trends_rivalry_to
  ON jimscanner_trends_rivalry(to_product_id, window DESC);
CREATE INDEX IF NOT EXISTS jimscanner_trends_rivalry_window
  ON jimscanner_trends_rivalry(window DESC, mention_count DESC);
CREATE INDEX IF NOT EXISTS jimscanner_trends_rivalry_names
  ON jimscanner_trends_rivalry(from_name, to_name);

ALTER TABLE jimscanner_trends_rivalry ENABLE ROW LEVEL SECURITY;
-- 어드민(service-role)만.

CREATE OR REPLACE FUNCTION jimscanner_trends_rivalry_set_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS jimscanner_trends_rivalry_updated_at ON jimscanner_trends_rivalry;
CREATE TRIGGER jimscanner_trends_rivalry_updated_at
  BEFORE UPDATE ON jimscanner_trends_rivalry
  FOR EACH ROW EXECUTE FUNCTION jimscanner_trends_rivalry_set_updated_at();
