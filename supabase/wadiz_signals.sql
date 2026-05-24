-- 와디즈/텀블벅 졸업 트래커 — 2026-05-25
-- 펀딩 성공 종료 프로젝트를 일별 스크랩해 적재.
-- D+60 양산 / D+90 첫 일반유통 / D+180 도매시장 / D+270 위탁 골든존 자동 계산.
-- 트렌드 시그널보다 60-180일 선행하는 외생 채널.

-- ─────────────────────────────────────────
-- 1) wadiz_signals — 펀딩 성공 프로젝트 원장
CREATE TABLE IF NOT EXISTS jimscanner_wadiz_signals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source text NOT NULL DEFAULT 'wadiz',          -- 'wadiz' / 'tumblbug'
  project_id text NOT NULL,                      -- 외부 프로젝트 식별자
  title text NOT NULL,
  url text,
  funded_krw bigint,                             -- 펀딩 누적금액
  supporters int,                                -- 서포터 수
  end_date date NOT NULL,                        -- 펀딩 종료일 (라이프사이클 기준점)
  category text,
  maker text,
  status text NOT NULL DEFAULT 'graduated',      -- 'graduated' / 'cancelled' / 'live'
  -- 매핑 (fuzzy match 결과)
  matched_keyword text,                          -- jimscanner_trends_keywords.keyword
  matched_product_id uuid,                       -- jimscanner_trends_products.id
  match_score numeric,                           -- 0~1 fuzzy similarity
  -- 워크플로
  pinned boolean NOT NULL DEFAULT false,
  notes text,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source, project_id)
);

CREATE INDEX IF NOT EXISTS jimscanner_wadiz_signals_end_date
  ON jimscanner_wadiz_signals(end_date DESC);
CREATE INDEX IF NOT EXISTS jimscanner_wadiz_signals_status
  ON jimscanner_wadiz_signals(status, end_date DESC);
CREATE INDEX IF NOT EXISTS jimscanner_wadiz_signals_funded
  ON jimscanner_wadiz_signals(funded_krw DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS jimscanner_wadiz_signals_matched_keyword
  ON jimscanner_wadiz_signals(matched_keyword)
  WHERE matched_keyword IS NOT NULL;

ALTER TABLE jimscanner_wadiz_signals ENABLE ROW LEVEL SECURITY;

-- ─────────────────────────────────────────
-- 2) supply_onset 이벤트 로그 — 매핑된 키워드가 ggsan 도매에 처음 검출된 순간 발사
CREATE TABLE IF NOT EXISTS jimscanner_wadiz_supply_onset (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  signal_id uuid NOT NULL REFERENCES jimscanner_wadiz_signals(id) ON DELETE CASCADE,
  matched_keyword text NOT NULL,
  ggsan_goods_no text,                           -- jimscanner_ggsan_products.goods_no
  ggsan_title text,
  days_since_end int,                            -- end_date 로부터 며칠 만에 ggsan 등장
  detected_at timestamptz NOT NULL DEFAULT now(),
  acknowledged boolean NOT NULL DEFAULT false,   -- 운영자가 확인 클릭하면 true
  UNIQUE (signal_id, ggsan_goods_no)
);

CREATE INDEX IF NOT EXISTS jimscanner_wadiz_supply_onset_unack
  ON jimscanner_wadiz_supply_onset(detected_at DESC)
  WHERE NOT acknowledged;

ALTER TABLE jimscanner_wadiz_supply_onset ENABLE ROW LEVEL SECURITY;

-- ─────────────────────────────────────────
-- 3) 라이프사이클 단계 계산 view
-- end_date 기준 D+60 / D+90 / D+180 / D+270 자동 분류.
CREATE OR REPLACE VIEW jimscanner_wadiz_lifecycle AS
SELECT
  s.*,
  (CURRENT_DATE - s.end_date)::int AS days_since_end,
  CASE
    WHEN CURRENT_DATE - s.end_date < 60   THEN 'incubating'   -- 펀딩 직후 ~ 양산 전
    WHEN CURRENT_DATE - s.end_date < 90   THEN 'mass_prod'    -- D+60 양산 개시
    WHEN CURRENT_DATE - s.end_date < 180  THEN 'retail_entry' -- D+90 첫 일반유통
    WHEN CURRENT_DATE - s.end_date < 270  THEN 'wholesale'    -- D+180 도매시장 진입
    ELSE 'consign_golden'                                     -- D+270 위탁 골든존
  END AS lifecycle_stage
FROM jimscanner_wadiz_signals s
WHERE s.status = 'graduated';
