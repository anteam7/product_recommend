-- ────────────────────────────────────────────────────────────
-- Spike Attribution Board — 'Why Now' 어트리뷰션
-- ────────────────────────────────────────────────────────────
-- jimscanner_trends_keywords 의 volume_relative 가 일/주 90 백분위
-- 이상으로 튄 (spike) 키워드를 후보로 뽑고, spike 시점 직전 24~72h
-- 윈도우에 발생한 외부 이벤트(naver_news / naver_tvtime / community)
-- 를 LLM 으로 매칭한 결과를 1:N 으로 저장한다.
--
-- 호출: node --env-file=.env.local scripts/spike-attribution.mjs
-- 어드민 UI: /admin/trend-radar/attribution
-- ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS jimscanner_trends_spike_attribution (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  keyword text NOT NULL,
  -- spike 가 관찰된 시점 (해당 keyword row 의 collected_at)
  spike_at timestamptz NOT NULL,
  -- spike 강도 (volume_relative 또는 z-score 비례). 카드 정렬용.
  spike_score numeric,
  -- baseline 대비 배수 (예: 3.2x). 표시용.
  spike_ratio numeric,

  -- 후보 외부 이벤트
  candidate_source text NOT NULL,    -- 'naver_news' | 'daum_news' | 'naver_tvtime' | '82cook' | 'natepan' | 'dcinside' | 'ppomppu'
  candidate_url text,
  candidate_title text NOT NULL,
  candidate_published_at timestamptz,

  -- LLM 매칭 결과
  score numeric NOT NULL,            -- 0~1 어트리뷰션 신뢰도
  reasoning text,                    -- "왜 이 이벤트가 이 키워드의 trigger 인지" 한 줄
  model text,
  matched_at timestamptz NOT NULL DEFAULT now(),

  -- 운영자 라벨링 (재현 가능 / 일회성 / 미분류)
  verdict text CHECK (verdict IN ('reproducible', 'one_off', 'noise')),
  verdict_by text,                   -- 어드민 user id / email
  verdict_at timestamptz,
  notes text,

  -- 같은 (keyword, spike_at, candidate_url) 는 한 번만
  CONSTRAINT uq_spike_attribution UNIQUE (keyword, spike_at, candidate_url)
);

CREATE INDEX IF NOT EXISTS jimscanner_spike_attr_keyword_spike
  ON jimscanner_trends_spike_attribution(keyword, spike_at DESC);

CREATE INDEX IF NOT EXISTS jimscanner_spike_attr_spike_at
  ON jimscanner_trends_spike_attribution(spike_at DESC);

CREATE INDEX IF NOT EXISTS jimscanner_spike_attr_score
  ON jimscanner_trends_spike_attribution(score DESC, spike_at DESC);

CREATE INDEX IF NOT EXISTS jimscanner_spike_attr_unverdicted
  ON jimscanner_trends_spike_attribution(spike_at DESC)
  WHERE verdict IS NULL;

ALTER TABLE jimscanner_trends_spike_attribution ENABLE ROW LEVEL SECURITY;
-- service_role 만. 공개 SELECT 정책 없음.
