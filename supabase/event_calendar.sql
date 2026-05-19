-- ─────────────────────────────────────────────────────────────
-- 이벤트·시즌 캘린더 오버레이 — 명절/광군제 D-day 선입고 보드
-- 2026-05-19
-- ─────────────────────────────────────────────────────────────
-- 목적:
--   한국 리테일 단발성 retail event 30+종을 시드하고,
--   카테고리×이벤트 lift / lead-time 을 계산해 트렌드 레이더에 노출.
--   이벤트는 일정이 100% 결정적이므로, lift 만 학습되면 가장 신뢰도
--   높은 진입 윈도우 (D-21 발주 / D-7 노출시작) 가 된다.
--
-- 관련 문서: docs/trend-radar-v4-execution-plan.md
-- D5: 운영자 전용. D7: 수집·계산은 cron, UI 는 어드민 read-only.
-- 모든 테이블 RLS enable + 정책 정의 X = service-role 전용.
-- ─────────────────────────────────────────────────────────────

-- 1) 캘린더 (정적 시드 + 매년 반복 정책)
CREATE TABLE IF NOT EXISTS jimscanner_retail_calendar (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  event_key   text NOT NULL,             -- 'lunar_new_year' | 'chuseok' | 'singles_day' | 'black_friday' ...
  name        text NOT NULL,             -- '설날 / 구정' · '광군제 11.11' 처럼 사람-읽기 라벨
  event_type  text NOT NULL,             -- 'national_holiday' | 'memorial_day' | 'shopping_event' | 'foreign_event' | 'school_event'
  date        date NOT NULL,             -- 해당 회차 정확한 양력 날짜 (음력은 컨버팅 후 저장)
  recurrence  text NOT NULL DEFAULT 'annual',  -- 'annual' (양력 고정) | 'lunar' (양력으로 매년 변동) | 'once'
  origin      text,                      -- 'KR' | 'CN' | 'US' | 'JP' (이벤트 발원국)

  -- 선험적 카테고리 affinity (시드에서 직접 입력, lift 계산 시 prior 로 사용)
  primary_categories text[] NOT NULL DEFAULT '{}',  -- ['health', 'living', 'food'] 등

  -- 권장 액션 윈도우 (D-day 기준 음수 = D-N)
  lead_order_days   int NOT NULL DEFAULT 21,   -- '오늘 발주' 권장일 (D-21 ↔ 운송 14d + 통관 5d + 노출 2d)
  lead_publish_days int NOT NULL DEFAULT 7,    -- '오늘 노출' 권장일 (D-7)

  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (event_key, date)
);

CREATE INDEX IF NOT EXISTS jimscanner_retail_calendar_date
  ON jimscanner_retail_calendar(date);

ALTER TABLE jimscanner_retail_calendar ENABLE ROW LEVEL SECURITY;


-- 2) 이벤트 × 카테고리 lift / lead-time (cron 이 채움)
CREATE TABLE IF NOT EXISTS jimscanner_event_lifts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  event_key   text NOT NULL,
  category_top text NOT NULL,             -- 'health' | 'living' | 'digital' | 'all'

  -- 과거 N 회 평균 lift (peak 평균 / baseline 평균) — 1.0 = 평년 수준
  lift_ratio   numeric,                    -- e.g. 2.35 = 평년 대비 2.35배
  peak_lag_days int,                       -- 이벤트일 기준 peak 발생 평균 lag (음수 = D-N, 양수 = D+N)
  sample_count int NOT NULL DEFAULT 0,     -- 백테스트에 쓰인 과거 회차 수
  confidence   numeric,                    -- 0~1 (sample_count + 분산 기반)

  computed_at  timestamptz NOT NULL DEFAULT now(),

  UNIQUE (event_key, category_top)
);

CREATE INDEX IF NOT EXISTS jimscanner_event_lifts_event
  ON jimscanner_event_lifts(event_key);

ALTER TABLE jimscanner_event_lifts ENABLE ROW LEVEL SECURITY;


-- ─────────────────────────────────────────────────────────────
-- 3) 시드 — 2026 / 2027 한국 리테일 이벤트 (양력 환산)
--    음력 이벤트는 한국천문연구원 공시 양력 사용.
--    이미 있는 (event_key, date) 는 무시.
-- ─────────────────────────────────────────────────────────────
INSERT INTO jimscanner_retail_calendar
  (event_key, name, event_type, date, recurrence, origin, primary_categories, lead_order_days, lead_publish_days, notes)
VALUES
  -- 명절 (음력)
  ('lunar_new_year', '설날 / 구정',     'national_holiday', '2026-02-17', 'lunar', 'KR', ARRAY['food','health','living'], 28, 10, '선물세트 피크 D-7~D-3'),
  ('lunar_new_year', '설날 / 구정',     'national_holiday', '2027-02-06', 'lunar', 'KR', ARRAY['food','health','living'], 28, 10, NULL),
  ('chuseok',        '추석',           'national_holiday', '2026-09-25', 'lunar', 'KR', ARRAY['food','health','living'], 28, 10, '한우/홍삼/굴비 선물세트 피크'),
  ('chuseok',        '추석',           'national_holiday', '2027-09-14', 'lunar', 'KR', ARRAY['food','health','living'], 28, 10, NULL),

  -- 기념일 / 가족
  ('parents_day',    '어버이날',       'memorial_day',     '2026-05-08', 'annual', 'KR', ARRAY['health','living','flowers'], 21, 7,  '카네이션·홍삼·건강식품 피크'),
  ('parents_day',    '어버이날',       'memorial_day',     '2027-05-08', 'annual', 'KR', ARRAY['health','living','flowers'], 21, 7,  NULL),
  ('childrens_day',  '어린이날',       'memorial_day',     '2026-05-05', 'annual', 'KR', ARRAY['toys','digital','living'], 21, 7,  '장난감/게임기 피크'),
  ('childrens_day',  '어린이날',       'memorial_day',     '2027-05-05', 'annual', 'KR', ARRAY['toys','digital','living'], 21, 7,  NULL),
  ('teachers_day',   '스승의날',       'memorial_day',     '2026-05-15', 'annual', 'KR', ARRAY['living','flowers'], 14, 5, NULL),
  ('teachers_day',   '스승의날',       'memorial_day',     '2027-05-15', 'annual', 'KR', ARRAY['living','flowers'], 14, 5, NULL),
  ('valentines_day', '발렌타인데이',   'memorial_day',     '2026-02-14', 'annual', 'KR', ARRAY['food','living'], 21, 7, '초콜릿 피크'),
  ('valentines_day', '발렌타인데이',   'memorial_day',     '2027-02-14', 'annual', 'KR', ARRAY['food','living'], 21, 7, NULL),
  ('white_day',      '화이트데이',     'memorial_day',     '2026-03-14', 'annual', 'KR', ARRAY['food','living'], 21, 7, '사탕·캔디 피크'),
  ('white_day',      '화이트데이',     'memorial_day',     '2027-03-14', 'annual', 'KR', ARRAY['food','living'], 21, 7, NULL),
  ('pepero_day',     '빼빼로데이',     'shopping_event',   '2026-11-11', 'annual', 'KR', ARRAY['food','living'], 21, 7, '광군제와 동일 — 묶음 마케팅'),
  ('pepero_day',     '빼빼로데이',     'shopping_event',   '2027-11-11', 'annual', 'KR', ARRAY['food','living'], 21, 7, NULL),

  -- 글로벌 쇼핑 이벤트
  ('singles_day',    '광군제 11.11',   'foreign_event',    '2026-11-11', 'annual', 'CN', ARRAY['digital','living','beauty','fashion'], 35, 14, '타오바오/티몰 — 1688 도매가 차익'),
  ('singles_day',    '광군제 11.11',   'foreign_event',    '2027-11-11', 'annual', 'CN', ARRAY['digital','living','beauty','fashion'], 35, 14, NULL),
  ('double_twelve',  '쌍십이절 12.12', 'foreign_event',    '2026-12-12', 'annual', 'CN', ARRAY['digital','living'], 30, 14, NULL),
  ('double_twelve',  '쌍십이절 12.12', 'foreign_event',    '2027-12-12', 'annual', 'CN', ARRAY['digital','living'], 30, 14, NULL),
  ('black_friday',   '블랙프라이데이', 'foreign_event',    '2026-11-27', 'annual', 'US', ARRAY['digital','living','beauty','fashion'], 21, 7, '미국 추수감사절 다음 금요일'),
  ('black_friday',   '블랙프라이데이', 'foreign_event',    '2027-11-26', 'annual', 'US', ARRAY['digital','living','beauty','fashion'], 21, 7, NULL),
  ('cyber_monday',   '사이버먼데이',   'foreign_event',    '2026-11-30', 'annual', 'US', ARRAY['digital'], 21, 7, NULL),
  ('cyber_monday',   '사이버먼데이',   'foreign_event',    '2027-11-29', 'annual', 'US', ARRAY['digital'], 21, 7, NULL),
  ('amazon_prime',   '아마존 프라임데이', 'foreign_event', '2026-07-16', 'annual', 'US', ARRAY['digital','living'], 21, 7, '일정 변동 — 매년 공식 발표 후 갱신'),
  ('amazon_prime',   '아마존 프라임데이', 'foreign_event', '2027-07-15', 'annual', 'US', ARRAY['digital','living'], 21, 7, NULL),

  -- 연말 / 시즌
  ('christmas',      '크리스마스',     'shopping_event',   '2026-12-25', 'annual', 'KR', ARRAY['toys','digital','living','food','beauty'], 28, 10, NULL),
  ('christmas',      '크리스마스',     'shopping_event',   '2027-12-25', 'annual', 'KR', ARRAY['toys','digital','living','food','beauty'], 28, 10, NULL),
  ('new_year',       '신정',           'national_holiday', '2027-01-01', 'annual', 'KR', ARRAY['food','living','health'], 21, 7, NULL),
  ('new_year',       '신정',           'national_holiday', '2028-01-01', 'annual', 'KR', ARRAY['food','living','health'], 21, 7, NULL),

  -- 교육 / 학습
  ('suneung',        '수능',           'school_event',     '2026-11-19', 'annual', 'KR', ARRAY['health','food','study'], 30, 10, '수험생 보양식/엿/찹쌀떡 피크'),
  ('suneung',        '수능',           'school_event',     '2027-11-18', 'annual', 'KR', ARRAY['health','food','study'], 30, 10, NULL),
  ('back_to_school', '신학기',         'school_event',     '2026-03-02', 'annual', 'KR', ARRAY['study','digital','fashion'], 21, 7, '문구·노트북·교복 피크'),
  ('back_to_school', '신학기',         'school_event',     '2027-03-02', 'annual', 'KR', ARRAY['study','digital','fashion'], 21, 7, NULL),

  -- 시즌
  ('summer_vacation','여름 휴가철',    'shopping_event',   '2026-07-25', 'annual', 'KR', ARRAY['living','beauty','outdoor','digital'], 30, 10, '7월 말 ~ 8월 초'),
  ('summer_vacation','여름 휴가철',    'shopping_event',   '2027-07-24', 'annual', 'KR', ARRAY['living','beauty','outdoor','digital'], 30, 10, NULL),
  ('winter_sale',    '겨울 세일',      'shopping_event',   '2026-12-15', 'annual', 'KR', ARRAY['fashion','living','digital'], 21, 7, NULL),
  ('winter_sale',    '겨울 세일',      'shopping_event',   '2027-12-15', 'annual', 'KR', ARRAY['fashion','living','digital'], 21, 7, NULL)
ON CONFLICT (event_key, date) DO NOTHING;


-- ─────────────────────────────────────────────────────────────
-- 4) recompute RPC — 이벤트별 카테고리 lift / lead-time 계산
--    과거 회차마다:
--      baseline = D-60 ~ D-30 평균 keywords 발생량
--      peak     = D-14 ~ D+7  max
--      lift     = peak / baseline
--      peak_lag = peak 날짜 - 이벤트 날짜
--    여러 회차 평균을 jimscanner_event_lifts 에 upsert.
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION jimscanner_event_calendar_recompute()
RETURNS TABLE(event_key text, category_top text, lift_ratio numeric, peak_lag_days int, sample_count int)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  WITH events AS (
    SELECT c.event_key, unnest(c.primary_categories) AS category_top, c.date AS event_date
    FROM jimscanner_retail_calendar c
    WHERE c.date < CURRENT_DATE
  ),
  per_event AS (
    SELECT
      e.event_key,
      e.category_top,
      e.event_date,
      (
        SELECT COALESCE(AVG(k.volume_relative), 0)
        FROM jimscanner_trends_keywords k
        WHERE k.classified_category = e.category_top
          AND k.collected_at::date BETWEEN e.event_date - INTERVAL '60 days'
                                       AND e.event_date - INTERVAL '30 days'
      ) AS baseline,
      (
        SELECT COALESCE(MAX(k.volume_relative), 0)
        FROM jimscanner_trends_keywords k
        WHERE k.classified_category = e.category_top
          AND k.collected_at::date BETWEEN e.event_date - INTERVAL '14 days'
                                       AND e.event_date + INTERVAL '7 days'
      ) AS peak,
      (
        SELECT (k.collected_at::date - e.event_date)
        FROM jimscanner_trends_keywords k
        WHERE k.classified_category = e.category_top
          AND k.collected_at::date BETWEEN e.event_date - INTERVAL '14 days'
                                       AND e.event_date + INTERVAL '7 days'
        ORDER BY k.volume_relative DESC NULLS LAST
        LIMIT 1
      ) AS peak_lag
    FROM events e
  ),
  agg AS (
    SELECT
      pe.event_key,
      pe.category_top,
      AVG(CASE WHEN pe.baseline > 0 THEN pe.peak / pe.baseline ELSE NULL END) AS lift_ratio,
      ROUND(AVG(pe.peak_lag))::int AS peak_lag_days,
      COUNT(*)::int AS sample_count
    FROM per_event pe
    WHERE pe.peak > 0
    GROUP BY pe.event_key, pe.category_top
  )
  INSERT INTO jimscanner_event_lifts AS l
    (event_key, category_top, lift_ratio, peak_lag_days, sample_count, confidence, computed_at)
  SELECT
    a.event_key,
    a.category_top,
    a.lift_ratio,
    a.peak_lag_days,
    a.sample_count,
    -- confidence = sample_count / (sample_count + 2). 2회 = 0.5, 5회 = 0.71.
    a.sample_count::numeric / (a.sample_count + 2),
    now()
  FROM agg a
  ON CONFLICT (event_key, category_top) DO UPDATE
    SET lift_ratio    = EXCLUDED.lift_ratio,
        peak_lag_days = EXCLUDED.peak_lag_days,
        sample_count  = EXCLUDED.sample_count,
        confidence    = EXCLUDED.confidence,
        computed_at   = now()
  RETURNING
    l.event_key,
    l.category_top,
    l.lift_ratio,
    l.peak_lag_days,
    l.sample_count;
END;
$$;

GRANT EXECUTE ON FUNCTION jimscanner_event_calendar_recompute() TO service_role;
