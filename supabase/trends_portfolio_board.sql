-- ─────────────────────────────────────────────────────────────
-- 주간 출시 슬롯 포트폴리오 보드 (베팅 사이징) — 2026-06-05
-- ─────────────────────────────────────────────────────────────
-- 개별 후보 게이트(BEP·마진·경쟁)를 통과한 상품 위에 "이번 주 실제 착수할 묶음"을
-- 추천하는 포트폴리오 레이어. 주당 신규 등록 슬롯 N + 광고예산 한도를 제약으로
-- 그리디 베팅 사이징(상관 페널티 + 노력비용 반영)을 적용한 결과를 저장.
--
-- 노출 정책: 기존 jimscanner_trends_* 패턴과 동일 — RLS enable + 정책 X = service-role 전용.
-- 관련 UI: src/app/admin/(dashboard)/trend-radar/portfolio/page.tsx
-- ─────────────────────────────────────────────────────────────

-- 1) 저장된 주간 포트폴리오 (한 번의 추천 실행 = 한 묶음)
CREATE TABLE IF NOT EXISTS jimscanner_portfolio_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  slots int NOT NULL,                 -- 주당 처리 가능 신규 등록 슬롯 (N)
  ad_budget_krw numeric NOT NULL,     -- 광고예산 한도 (won)
  corr_penalty numeric NOT NULL DEFAULT 0.6,  -- 동조 클러스터/도매처 상관 페널티 계수 (0~1)

  picked_count int NOT NULL DEFAULT 0,
  total_value numeric NOT NULL DEFAULT 0,      -- 선택된 후보 한계기여 합
  est_ad_spend_krw numeric NOT NULL DEFAULT 0, -- 선택 후보 추정 광고비 합

  -- 선택된 후보 스냅샷 (product_id, name, marginal_value, est_ad_spend, effort, cluster, supplier 등)
  picks jsonb NOT NULL DEFAULT '[]'::jsonb,

  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS jimscanner_portfolio_runs_created
  ON jimscanner_portfolio_runs(created_at DESC);

ALTER TABLE jimscanner_portfolio_runs ENABLE ROW LEVEL SECURITY;
-- service-role 만 접근 (정책 미정의).

-- 2) 추천 결과 저장 RPC — UI(server action)에서 호출.
--    클라이언트 그리디 결과를 그대로 적재 (재계산은 UI 책임, DB 는 기록만).
CREATE OR REPLACE FUNCTION jimscanner_save_portfolio(
  p_slots int,
  p_ad_budget numeric,
  p_corr_penalty numeric,
  p_picks jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_id uuid;
  v_value numeric;
  v_spend numeric;
  v_count int;
BEGIN
  v_count := COALESCE(jsonb_array_length(p_picks), 0);
  SELECT
    COALESCE(SUM((e->>'marginalValue')::numeric), 0),
    COALESCE(SUM((e->>'estAdSpend')::numeric), 0)
  INTO v_value, v_spend
  FROM jsonb_array_elements(p_picks) AS e;

  INSERT INTO jimscanner_portfolio_runs
    (slots, ad_budget_krw, corr_penalty, picked_count, total_value, est_ad_spend_krw, picks)
  VALUES
    (p_slots, p_ad_budget, p_corr_penalty, v_count, v_value, v_spend, p_picks)
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

-- 3) 최근 저장 묶음 조회 뷰 (운영자가 지난 주 베팅 복기용)
CREATE OR REPLACE VIEW jimscanner_portfolio_latest AS
SELECT
  id,
  slots,
  ad_budget_krw,
  corr_penalty,
  picked_count,
  total_value,
  est_ad_spend_krw,
  picks,
  created_at
FROM jimscanner_portfolio_runs
ORDER BY created_at DESC
LIMIT 50;
