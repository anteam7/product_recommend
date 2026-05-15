-- ────────────────────────────────────────────────────────────
-- PR-5: Unmet Demand 보드 — 페인포인트 → 상품 갭 매핑 (2026-05-16)
-- ────────────────────────────────────────────────────────────
-- market_raw (naver_blog/news/clien_park/quasarzone_sale 본문) 에서
-- LLM 으로 사용자 'pain point statement' 를 추출 → 클러스터링 →
-- jimscanner_trends_products 와 fuzzy 매칭.
-- 매칭이 있으면 mapped_product_id 로 link, 없으면 Unmet Demand.
--
-- 기존 jimscanner_market_signals 와의 차이:
-- - signals 는 keyword/topic/season 등 일반 시그널.
-- - pain_points 는 사용자 발화체 그대로 보존 → 광고 카피로 재사용.
--
-- 호출: scripts/extract-pain-points.mjs (로컬 cron, run-crons.mjs 추가)
-- ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.jimscanner_market_pain_points (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- 클러스터 키 (같은 페인 의도끼리 묶음) — 단순 slug 또는 LLM 부여 id
  cluster_id text NOT NULL,

  -- 사용자 발화체 그대로 (광고 카피로 재사용)
  statement text NOT NULL,

  -- 0~10 (LLM 평가) — '심각도' (사용자가 얼마나 불편해하는가)
  severity int NOT NULL DEFAULT 5,

  -- 같은 cluster_id 내 누적 등장 횟수 — UPSERT 시 +1
  frequency int NOT NULL DEFAULT 1,

  -- 짧은 한국어 라벨 (대시보드 매트릭스 X 축에 표시)
  cluster_label text,

  -- 매칭된 canonical product (없으면 NULL → Unmet Demand)
  mapped_product_id uuid REFERENCES public.jimscanner_trends_products(id) ON DELETE SET NULL,

  -- 매칭 신뢰도 (0~100). NULL = 매칭 실패 (Unmet Demand)
  mapped_score int,

  -- LLM 자동 생성 광고 카피 (statement 인용 형식, 1줄)
  ad_copy text,

  -- 핀 (수동 검토 진행 표시)
  is_pinned boolean NOT NULL DEFAULT false,

  -- 출처 추적 (jimscanner_market_raw.id 들)
  raw_ids uuid[] NOT NULL DEFAULT '{}',

  first_seen timestamptz NOT NULL DEFAULT now(),
  last_seen timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pain_points_cluster
  ON public.jimscanner_market_pain_points (cluster_id, last_seen DESC);

CREATE INDEX IF NOT EXISTS idx_pain_points_unmet
  ON public.jimscanner_market_pain_points (severity DESC, frequency DESC)
  WHERE mapped_product_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_pain_points_mapped
  ON public.jimscanner_market_pain_points (mapped_product_id)
  WHERE mapped_product_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_pain_points_pinned
  ON public.jimscanner_market_pain_points (last_seen DESC)
  WHERE is_pinned = true;

-- updated_at 자동 갱신
CREATE OR REPLACE FUNCTION public.tg_pain_points_touch()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_pain_points_touch ON public.jimscanner_market_pain_points;
CREATE TRIGGER trg_pain_points_touch
  BEFORE UPDATE ON public.jimscanner_market_pain_points
  FOR EACH ROW EXECUTE FUNCTION public.tg_pain_points_touch();

-- RLS: admin 전용 (service_role 만 접근). 공개 SELECT 정책 없음.
ALTER TABLE public.jimscanner_market_pain_points ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.jimscanner_market_pain_points IS
  'Unmet Demand 보드: market_raw 본문에서 추출한 사용자 페인포인트 클러스터. '
  'mapped_product_id IS NULL = SKU 없는 신규 진입 후보.';
