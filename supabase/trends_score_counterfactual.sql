-- ─────────────────────────────────────────────────────────────
-- 트렌드 레이더 — Score Counterfactual Explainer
-- ─────────────────────────────────────────────────────────────
-- 목적: final_score 30~49 의 '경계권' 상품에 대해, 4점수 가중치 공식을
--       역산하여 '이 상품이 진입 임계(50)이 되려면 어떤 컴포넌트가 얼마나
--       더 필요한가'를 자동 산출 → 운영 액션 큐 생성.
--
-- 가정: final_score = 0.25 * (trend + commerce + supplier + competition)
--       (이 가정은 백테스트(#25) 가중치 튜닝 이전 기본 가중치와 동일)
--
-- 반환: 각 row 가 컴포넌트 1개에 대응. effort_score 가 낮을수록 '적은 변화'
--        로 게이트 통과 가능 → 운영 액션 우선순위.
-- ─────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION jimscanner_score_counterfactual(p_product_id uuid)
RETURNS TABLE (
  component       text,
  current_value   numeric,
  required_value  numeric,
  delta_needed    numeric,
  feasible        boolean,
  effort_rank     int,
  suggestion      text,
  sub_signals     jsonb
)
LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_score      record;
  v_target     numeric := 50;     -- 진입 게이트
  v_weight     numeric := 0.25;   -- 균등 가중치 (현재 운영 기준)
  v_gap        numeric;           -- 50 - final
BEGIN
  -- 최신 score row
  SELECT s.trend_score, s.commerce_score, s.supplier_score,
         s.competition_score, s.final_score, s.score_components
    INTO v_score
    FROM jimscanner_trends_scores s
   WHERE s.product_id = p_product_id
   ORDER BY s.computed_at DESC
   LIMIT 1;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  v_gap := v_target - v_score.final_score;

  -- 이미 게이트 통과 → 빈 결과
  IF v_gap <= 0 THEN
    RETURN;
  END IF;

  -- 컴포넌트별 단독 조정 시 필요 delta = gap / weight
  -- (다른 컴포넌트 고정 시 한 컴포넌트만 끌어올려 final=50 만들기)
  --
  -- effort_rank: delta 작은 순. delta 동일하면 현재값 큰 순 (남은 헤드룸 작음).

  RETURN QUERY
  WITH base AS (
    SELECT 'trend'::text AS component,
           v_score.trend_score AS current_value,
           LEAST(100, v_score.trend_score + v_gap / v_weight) AS required_value,
           v_gap / v_weight AS delta_needed,
           v_score.trend_score + v_gap / v_weight <= 100 AS feasible,
           'TV 편성 push +1 / 키워드 multi-source 추가 / news velocity 시그널 재수집' AS suggestion,
           COALESCE(v_score.score_components -> 'trend', '{}'::jsonb) AS sub_signals
    UNION ALL
    SELECT 'commerce',
           v_score.commerce_score,
           LEAST(100, v_score.commerce_score + v_gap / v_weight),
           v_gap / v_weight,
           v_score.commerce_score + v_gap / v_weight <= 100,
           'TV push 검출 재실행 / GMV proxy 보강 / 쿠팡 판매량 시그널 수집',
           COALESCE(v_score.score_components -> 'commerce', '{}'::jsonb)
    UNION ALL
    SELECT 'supplier',
           v_score.supplier_score,
           LEAST(100, v_score.supplier_score + v_gap / v_weight),
           v_gap / v_weight,
           v_score.supplier_score + v_gap / v_weight <= 100,
           'ggsan 도매 매칭 재시도 / 1688·도매꾹 후보 추가 수집 / supplier_sim 임계 재계산',
           COALESCE(v_score.score_components -> 'supplier', '{}'::jsonb)
    UNION ALL
    SELECT 'competition',
           v_score.competition_score,
           LEAST(100, v_score.competition_score + v_gap / v_weight),
           v_gap / v_weight,
           v_score.competition_score + v_gap / v_weight <= 100,
           '판매자 수 재집계 / 브랜드 집중도 재계산 / 후발 진입 가능성 시그널 보강',
           COALESCE(v_score.score_components -> 'competition', '{}'::jsonb)
  )
  SELECT
    base.component,
    base.current_value,
    base.required_value,
    base.delta_needed,
    base.feasible,
    (ROW_NUMBER() OVER (
        ORDER BY base.feasible DESC,
                 base.delta_needed ASC,
                 base.current_value DESC
    ))::int AS effort_rank,
    base.suggestion,
    base.sub_signals
  FROM base
  ORDER BY effort_rank ASC;
END;
$$;

COMMENT ON FUNCTION jimscanner_score_counterfactual(uuid) IS
'경계권(30~49) 상품에 대한 최소 변화 셋 산출. 4 컴포넌트별 단독 조정으로 final=50 도달 시 필요 delta 계산. effort_rank=1 이 가장 작은 변화로 게이트 통과 가능한 액션.';
