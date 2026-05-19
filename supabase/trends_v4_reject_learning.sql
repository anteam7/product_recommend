-- ─────────────────────────────────────────────────────────────
-- 트렌드 레이더 v4 — 리젝 학습 필터 (2026-05-19)
-- ─────────────────────────────────────────────────────────────
-- 운영자가 trend-radar 에서 reject/hide 한 product 를 라벨로 사용해
-- 경량 분류기(로지스틱 회귀) 학습 → product_id 별 reject_probability 계산.
-- 후속 cron 사이클에서 동일 패턴이 다시 inbox 에 올라오는 낭비 방지.
--
-- 노출 정책: 모든 테이블 RLS enable + 정책 정의 X = service-role 만 접근.
-- ─────────────────────────────────────────────────────────────


-- 1) 운영자 reject/hide 결정 누적 (라벨)
CREATE TABLE IF NOT EXISTS jimscanner_trends_reject_labels (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES jimscanner_trends_products(id) ON DELETE CASCADE,

  decision text NOT NULL,            -- 'reject' | 'hide' | 'approve' (positive label)
  reason text,                       -- 자유 입력 ('saturation' | 'low_margin' | 'banned_category' | ...)
  decided_by text,                   -- admin email
  surface text,                      -- 'trend-radar' | 'opportunity' | 'recommend'

  created_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (product_id, decision)
);

CREATE INDEX IF NOT EXISTS jimscanner_trends_reject_labels_product
  ON jimscanner_trends_reject_labels(product_id);

CREATE INDEX IF NOT EXISTS jimscanner_trends_reject_labels_decision_at
  ON jimscanner_trends_reject_labels(decision, created_at DESC);

ALTER TABLE jimscanner_trends_reject_labels ENABLE ROW LEVEL SECURITY;


-- 2) 학습 실행 메타 + 계수 (재현 + 디버깅)
--    feature_names, coefficients 는 동일 길이 배열.
CREATE TABLE IF NOT EXISTS jimscanner_trends_reject_model_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  algorithm text NOT NULL,             -- 'logistic_regression' | 'lightgbm' (후속)
  trained_at timestamptz NOT NULL DEFAULT now(),

  n_samples int NOT NULL,
  n_positive int NOT NULL,             -- reject 라벨 개수
  n_negative int NOT NULL,             -- approve 라벨 개수

  -- 모델 파라미터 (logistic regression: intercept + coef[])
  intercept numeric NOT NULL DEFAULT 0,
  feature_names text[] NOT NULL DEFAULT '{}',
  coefficients numeric[] NOT NULL DEFAULT '{}',
  feature_means numeric[] NOT NULL DEFAULT '{}',    -- 표준화용
  feature_stds numeric[] NOT NULL DEFAULT '{}',

  -- 평가 지표
  train_loss numeric,
  val_auc numeric,                     -- 또는 holdout accuracy
  threshold numeric NOT NULL DEFAULT 0.6,  -- UI 디머 임계값
  is_shadow_mode boolean NOT NULL DEFAULT true, -- true 면 점수만 기록·UI 디스카운트 X

  notes text,

  -- 활성 모델 플래그 (1개만 active)
  is_active boolean NOT NULL DEFAULT false
);

CREATE INDEX IF NOT EXISTS jimscanner_trends_reject_model_runs_active
  ON jimscanner_trends_reject_model_runs(is_active, trained_at DESC)
  WHERE is_active = true;

CREATE INDEX IF NOT EXISTS jimscanner_trends_reject_model_runs_trained_at
  ON jimscanner_trends_reject_model_runs(trained_at DESC);

ALTER TABLE jimscanner_trends_reject_model_runs ENABLE ROW LEVEL SECURITY;


-- 3) scores 테이블에 reject_prob 컬럼 추가
--    score row 작성 시 동시에 채우거나, train-reject-model 스크립트가 별도로 update.
ALTER TABLE jimscanner_trends_scores
  ADD COLUMN IF NOT EXISTS reject_prob numeric
  CHECK (reject_prob IS NULL OR (reject_prob >= 0 AND reject_prob <= 1));

CREATE INDEX IF NOT EXISTS jimscanner_trends_scores_reject_prob
  ON jimscanner_trends_scores(reject_prob)
  WHERE reject_prob IS NOT NULL;
