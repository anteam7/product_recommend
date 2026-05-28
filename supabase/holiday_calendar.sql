-- 기념일 캘린더 × 선물의도 D-day 윈도우 — 2026-05-28
-- 한국 주요 명절·기념일 D-day 좌표계에서 검색 트렌드를 재정렬해 진입 윈도우/매입 데드라인을 산출.

-- ─────────────────────────────────────────
-- 1) 기념일 캘린더 — 양력 고정 (윤년 보정은 view 에서 처리).
-- 음력 명절(설/추석)은 별도 lunar_date 컬럼으로 매년 양력 매핑을 함께 적재.
CREATE TABLE IF NOT EXISTS jimscanner_holiday_calendar (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE,            -- 'parents_day' / 'teachers_day' / 'chuseok' ...
  name_ko text NOT NULL,                -- '어버이날' / '추석' ...
  -- 양력 고정 기념일 (월·일). 음력 명절은 null 로 두고 occurrence 테이블로.
  solar_month int CHECK (solar_month BETWEEN 1 AND 12),
  solar_day int CHECK (solar_day BETWEEN 1 AND 31),
  category text NOT NULL,               -- 'family' / 'romance' / 'season' / 'commerce'
  gift_intent_tokens text[] NOT NULL DEFAULT '{}',  -- 이 기념일에 매칭되는 선물의도 토큰
  lead_time_days int NOT NULL DEFAULT 10,           -- 도매 매입 리드타임 (피크일 - 리드타임 = 매입 데드라인)
  notes text,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE jimscanner_holiday_calendar ENABLE ROW LEVEL SECURITY;

-- ─────────────────────────────────────────
-- 2) 음력/이동 기념일 occurrence — 양력으로 변환된 실제 일자.
-- 설/추석 등 음력 기준 명절은 매년 양력 일자가 다르므로 별도 테이블로 적재.
CREATE TABLE IF NOT EXISTS jimscanner_holiday_occurrences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  holiday_slug text NOT NULL REFERENCES jimscanner_holiday_calendar(slug) ON DELETE CASCADE,
  occur_date date NOT NULL,
  UNIQUE (holiday_slug, occur_date)
);
CREATE INDEX IF NOT EXISTS jimscanner_holiday_occurrences_date
  ON jimscanner_holiday_occurrences(occur_date);

ALTER TABLE jimscanner_holiday_occurrences ENABLE ROW LEVEL SECURITY;

-- ─────────────────────────────────────────
-- 3) 시드 — 한국 주요 기념일.
INSERT INTO jimscanner_holiday_calendar (slug, name_ko, solar_month, solar_day, category, gift_intent_tokens, lead_time_days, notes) VALUES
  ('valentines',     '발렌타인데이',  2, 14,  'romance',  ARRAY['선물','연인','초콜릿','발렌타인','커플'], 10, '2월 14일'),
  ('white_day',      '화이트데이',    3, 14,  'romance',  ARRAY['선물','연인','사탕','화이트데이','커플'], 10, '3월 14일'),
  ('childrens_day',  '어린이날',      5,  5,  'family',   ARRAY['선물','어린이','아이','자녀','조카'], 10, '5월 5일'),
  ('parents_day',    '어버이날',      5,  8,  'family',   ARRAY['선물','어머니','아버지','부모님','효도','카네이션'], 10, '5월 8일'),
  ('teachers_day',   '스승의날',      5, 15,  'family',   ARRAY['선물','스승','선생님','감사','카네이션'], 10, '5월 15일'),
  ('pepero_day',     '빼빼로데이',   11, 11,  'commerce', ARRAY['선물','빼빼로','과자','친구'], 7,  '11월 11일'),
  ('christmas',      '크리스마스',   12, 25,  'season',   ARRAY['선물','크리스마스','커플','연인','파티','트리'], 14, '12월 25일'),
  ('year_end',       '연말',         12, 31,  'season',   ARRAY['선물','연말','송년','새해','파티'], 14, '12월 31일'),
  -- 음력 기념일은 solar 가 null — occurrences 로 적재.
  ('lunar_new_year', '설',           NULL, NULL, 'season', ARRAY['선물','설','명절','부모님','세배','한복'], 14, '음력 1월 1일'),
  ('chuseok',        '추석',         NULL, NULL, 'season', ARRAY['선물','추석','명절','한가위','부모님'], 14, '음력 8월 15일')
ON CONFLICT (slug) DO NOTHING;

-- ─────────────────────────────────────────
-- 4) 음력 명절 양력 매핑 시드 — 2025~2027.
INSERT INTO jimscanner_holiday_occurrences (holiday_slug, occur_date) VALUES
  ('lunar_new_year', DATE '2025-01-29'),
  ('lunar_new_year', DATE '2026-02-17'),
  ('lunar_new_year', DATE '2027-02-06'),
  ('chuseok',        DATE '2025-10-06'),
  ('chuseok',        DATE '2026-09-25'),
  ('chuseok',        DATE '2027-09-15')
ON CONFLICT DO NOTHING;

-- ─────────────────────────────────────────
-- 5) 함수: 다음 기념일 일자 계산.
-- 양력 고정 (solar_month, solar_day) — 올해 이미 지난 경우 내년 일자. 윤년 보정(2/29) 포함.
-- 음력 (solar_month NULL) — occurrences 에서 ref_date 이후 가장 가까운 일자.
CREATE OR REPLACE FUNCTION jimscanner_next_holiday_date(
  p_slug text,
  p_ref_date date
) RETURNS date AS $$
DECLARE
  v_row jimscanner_holiday_calendar%ROWTYPE;
  v_year int;
  v_candidate date;
  v_next_occ date;
BEGIN
  SELECT * INTO v_row FROM jimscanner_holiday_calendar WHERE slug = p_slug;
  IF NOT FOUND THEN RETURN NULL; END IF;

  IF v_row.solar_month IS NOT NULL AND v_row.solar_day IS NOT NULL THEN
    v_year := EXTRACT(YEAR FROM p_ref_date)::int;
    -- 윤년 보정: 2/29 가 평년이면 2/28 로.
    IF v_row.solar_month = 2 AND v_row.solar_day = 29
       AND NOT ((v_year % 4 = 0 AND v_year % 100 <> 0) OR v_year % 400 = 0) THEN
      v_candidate := make_date(v_year, 2, 28);
    ELSE
      v_candidate := make_date(v_year, v_row.solar_month, v_row.solar_day);
    END IF;
    IF v_candidate < p_ref_date THEN
      v_year := v_year + 1;
      IF v_row.solar_month = 2 AND v_row.solar_day = 29
         AND NOT ((v_year % 4 = 0 AND v_year % 100 <> 0) OR v_year % 400 = 0) THEN
        v_candidate := make_date(v_year, 2, 28);
      ELSE
        v_candidate := make_date(v_year, v_row.solar_month, v_row.solar_day);
      END IF;
    END IF;
    RETURN v_candidate;
  ELSE
    SELECT MIN(occur_date) INTO v_next_occ
      FROM jimscanner_holiday_occurrences
      WHERE holiday_slug = p_slug AND occur_date >= p_ref_date;
    RETURN v_next_occ;
  END IF;
END;
$$ LANGUAGE plpgsql STABLE;

-- ─────────────────────────────────────────
-- 6) View: 다가오는 기념일 + D-day.
-- 오늘 기준 다음 발생일을 계산하고, D-N 을 함께 노출.
CREATE OR REPLACE VIEW jimscanner_upcoming_holidays AS
SELECT
  h.slug,
  h.name_ko,
  h.category,
  h.gift_intent_tokens,
  h.lead_time_days,
  h.notes,
  jimscanner_next_holiday_date(h.slug, CURRENT_DATE) AS next_date,
  (jimscanner_next_holiday_date(h.slug, CURRENT_DATE) - CURRENT_DATE)::int AS d_minus,
  (jimscanner_next_holiday_date(h.slug, CURRENT_DATE) - h.lead_time_days)::date AS purchase_deadline
FROM jimscanner_holiday_calendar h
WHERE jimscanner_next_holiday_date(h.slug, CURRENT_DATE) IS NOT NULL
ORDER BY next_date ASC;

-- ─────────────────────────────────────────
-- 7) View: 키워드별 선물의도 매칭.
-- jimscanner_trends_keywords 의 최근 60일 데이터를 keyword 별로 묶고,
-- 키워드 텍스트에 선물의도 토큰이 몇 % 매칭되는지(gift_intent_ratio) 산출.
-- (단순 LIKE 매칭 — DB 사이드에서 구현. 더 정교한 매칭은 클라이언트에서.)
CREATE OR REPLACE VIEW jimscanner_keyword_gift_intent AS
WITH recent AS (
  SELECT
    keyword,
    MAX(collected_at) AS last_seen_at,
    AVG(volume_relative) AS avg_volume,
    MAX(volume_relative) AS peak_volume,
    COUNT(*) AS sample_count
  FROM jimscanner_trends_keywords
  WHERE collected_at >= now() - INTERVAL '60 days'
  GROUP BY keyword
),
generic_tokens AS (
  SELECT unnest(ARRAY['선물','선물용','선물포장','기념일','생일']) AS token
)
SELECT
  r.keyword,
  r.last_seen_at,
  r.avg_volume,
  r.peak_volume,
  r.sample_count,
  -- 일반 선물의도 토큰 매칭률
  (
    SELECT COUNT(*)::numeric / NULLIF((SELECT COUNT(*) FROM generic_tokens), 0)
    FROM generic_tokens gt
    WHERE r.keyword ILIKE '%' || gt.token || '%'
  ) AS gift_intent_ratio
FROM recent r;

-- ─────────────────────────────────────────
-- 8) RPC: 특정 기념일에 매칭된 키워드 후보 (선물의도 토큰 ILIKE 매칭).
-- 입력: holiday slug — 출력: 키워드 + 매칭 토큰 + 작년 동일 D-N 검색량 lift.
CREATE OR REPLACE FUNCTION jimscanner_gift_window_candidates(
  p_holiday_slug text,
  p_limit int DEFAULT 30
) RETURNS TABLE (
  keyword text,
  matched_tokens text[],
  current_volume numeric,
  last_year_volume numeric,
  lift_ratio numeric,
  last_seen_at timestamptz
) AS $$
DECLARE
  v_tokens text[];
  v_next_date date;
  v_d_minus int;
BEGIN
  SELECT gift_intent_tokens INTO v_tokens
    FROM jimscanner_holiday_calendar WHERE slug = p_holiday_slug;
  IF v_tokens IS NULL OR array_length(v_tokens, 1) IS NULL THEN
    RETURN;
  END IF;

  v_next_date := jimscanner_next_holiday_date(p_holiday_slug, CURRENT_DATE);
  v_d_minus := (v_next_date - CURRENT_DATE)::int;

  RETURN QUERY
  WITH matched AS (
    SELECT k.keyword,
      ARRAY(
        SELECT t FROM unnest(v_tokens) t WHERE k.keyword ILIKE '%' || t || '%'
      ) AS matched_tokens,
      MAX(k.collected_at) AS last_seen_at,
      AVG(k.volume_relative) FILTER (
        WHERE k.collected_at >= now() - INTERVAL '14 days'
      ) AS current_volume,
      AVG(k.volume_relative) FILTER (
        WHERE k.collected_at >= now() - INTERVAL '1 year 14 days'
          AND k.collected_at <  now() - INTERVAL '1 year'
      ) AS last_year_volume
    FROM jimscanner_trends_keywords k
    WHERE k.collected_at >= now() - INTERVAL '400 days'
    GROUP BY k.keyword
  )
  SELECT
    m.keyword,
    m.matched_tokens,
    m.current_volume,
    m.last_year_volume,
    CASE
      WHEN COALESCE(m.last_year_volume, 0) = 0 THEN NULL
      ELSE (m.current_volume / m.last_year_volume)
    END AS lift_ratio,
    m.last_seen_at
  FROM matched m
  WHERE array_length(m.matched_tokens, 1) >= 1
  ORDER BY
    COALESCE(m.current_volume, 0) DESC,
    COALESCE(m.last_year_volume, 0) DESC
  LIMIT p_limit;
END;
$$ LANGUAGE plpgsql STABLE;
