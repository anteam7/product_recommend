-- ────────────────────────────────────────────────────────────
-- 연·반복 이벤트 캘린더 D-day 진입·철수 플래너 (2026-05-26)
-- ────────────────────────────────────────────────────────────
-- naver_search_trend 다년치 데이터로 키워드별 반복 피크 일자를 학습하고
-- 한국형 명명 이벤트(빼빼로, 발렌타인, 화이트데이, 어버이날, 졸업/입학,
-- 김장, 수능, 블랙프라이데이, 크리스마스, 환절기/장마/폭염/미세먼지/꽃가루 등)와
-- 자동 매핑한다. scripts/learn-event-anchors.mjs 가 주간 업데이트.
--
-- jimscanner_ggsan_recommend RPC 에 active_event_proximity 보너스 합산.
-- ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS jimscanner_event_calendar (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_key text NOT NULL UNIQUE,           -- 'pepero_day' / 'valentine' / 'kimjang' / ...
  event_name text NOT NULL,                 -- 사람이 읽는 이름
  category text,                            -- 'gift' / 'season' / 'health' / 'home'
  -- anchor: 고정 일자 또는 규칙 — 둘 중 하나만 채움
  anchor_month int CHECK (anchor_month BETWEEN 1 AND 12),
  anchor_day int CHECK (anchor_day BETWEEN 1 AND 31),
  anchor_rule text,                         -- 'nov_first_week' / 'spring_equinox' / 'lunar_xxx' 등 자유 형식
  -- 진입·철수 권장 윈도우 (D-anchor 기준)
  lead_days int NOT NULL DEFAULT 21,        -- 진입 권장 = anchor - lead_days
  tail_days int NOT NULL DEFAULT 3,         -- 철수 권장 = anchor + tail_days
  -- 학습된 시그널 — scripts/learn-event-anchors.mjs 가 갱신
  related_keywords text[] NOT NULL DEFAULT '{}',
  yoy_lift_median real,                     -- 피크/평균 lift 중앙값 (1.0 = no lift)
  yoy_lift_stddev real,
  learned_peak_doy int,                     -- 학습된 실측 피크 day-of-year (1~366)
  learned_peak_stddev real,                 -- 피크 day-of-year 편차
  sample_years int NOT NULL DEFAULT 0,
  last_learned_at timestamptz,
  -- 메타
  is_active boolean NOT NULL DEFAULT true,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS jimscanner_event_calendar_anchor
  ON jimscanner_event_calendar(anchor_month, anchor_day)
  WHERE is_active;

ALTER TABLE jimscanner_event_calendar ENABLE ROW LEVEL SECURITY;

-- updated_at trigger
CREATE OR REPLACE FUNCTION jimscanner_event_calendar_set_updated_at()
RETURNS trigger AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS jimscanner_event_calendar_updated_at ON jimscanner_event_calendar;
CREATE TRIGGER jimscanner_event_calendar_updated_at
  BEFORE UPDATE ON jimscanner_event_calendar
  FOR EACH ROW EXECUTE FUNCTION jimscanner_event_calendar_set_updated_at();

-- ────────────────────────────────────────────────────────────
-- 초기 시드: 한국형 명명 이벤트
-- related_keywords 는 learn-event-anchors.mjs 가 갱신할 기본값
-- ────────────────────────────────────────────────────────────
INSERT INTO jimscanner_event_calendar
  (event_key, event_name, category, anchor_month, anchor_day, lead_days, tail_days, related_keywords)
VALUES
  ('valentine',     '발렌타인데이',     'gift',   2, 14, 28, 3,
    ARRAY['발렌타인','발렌타인데이','초콜릿','수제초콜릿','발렌타인선물']),
  ('white_day',     '화이트데이',       'gift',   3, 14, 28, 3,
    ARRAY['화이트데이','사탕','화이트데이선물']),
  ('parents_day',   '어버이날',         'gift',   5,  8, 30, 3,
    ARRAY['어버이날','어버이날선물','카네이션','홍삼','효도선물']),
  ('teachers_day',  '스승의날',         'gift',   5, 15, 21, 2,
    ARRAY['스승의날','스승의날선물']),
  ('childrens_day', '어린이날',         'gift',   5,  5, 28, 3,
    ARRAY['어린이날','어린이날선물','장난감','레고']),
  ('pepero_day',    '빼빼로데이',       'gift',  11, 11, 21, 2,
    ARRAY['빼빼로','빼빼로데이','수제빼빼로']),
  ('christmas',     '크리스마스',       'gift',  12, 25, 35, 3,
    ARRAY['크리스마스','크리스마스선물','크리스마스트리','산타','어드벤트캘린더']),
  ('black_friday',  '블랙프라이데이',   'gift',  11, 28, 21, 5,
    ARRAY['블랙프라이데이','블프','직구','아마존블랙프라이데이']),
  ('chuseok',       '추석',             'season', 9, 17, 35, 5,
    ARRAY['추석','추석선물','추석선물세트','명절']),
  ('lunar_new_year','설날',             'season', 2, 10, 35, 5,
    ARRAY['설날','설선물','명절선물','한복']),
  ('kimjang',       '김장철',           'season',11,  7, 21, 7,
    ARRAY['김장','김치냉장고','절임배추','김장양념','고무장갑']),
  ('suneung',       '수능',             'season',11, 14, 28, 2,
    ARRAY['수능','수능선물','수능도시락','수능시계','수능응원']),
  ('graduation',    '졸업·입학',        'season', 2, 20, 35, 14,
    ARRAY['졸업','입학','입학선물','졸업선물','책가방','학용품']),
  ('summer_vacation','여름휴가',        'season', 7, 25, 30, 14,
    ARRAY['여름휴가','수영복','래시가드','선크림','래쉬가드','캠핑']),
  ('autumn_health', '환절기 건강',      'health',10,  1, 21, 14,
    ARRAY['환절기','감기','비타민','면역력','홍삼']),
  ('rainy_season',  '장마',             'season', 6, 25, 21, 10,
    ARRAY['장마','우산','제습기','우비','장화','곰팡이제거']),
  ('heatwave',      '폭염',             'season', 7, 25, 21,  7,
    ARRAY['폭염','선풍기','에어컨','쿨매트','휴대용선풍기','얼음']),
  ('yellow_dust',   '미세먼지·황사',    'health', 3, 15, 14, 21,
    ARRAY['미세먼지','황사','공기청정기','마스크','kf94']),
  ('pollen',        '꽃가루 알레르기',  'health', 4, 15, 14, 14,
    ARRAY['꽃가루','알레르기','비염','콧물','코세척']),
  ('mothers_holiday','가정의달',        'gift',   5,  1, 21, 30,
    ARRAY['가정의달','가정의달선물','5월선물'])
ON CONFLICT (event_key) DO NOTHING;

-- ────────────────────────────────────────────────────────────
-- RPC 재정의 — active_event_proximity 보너스 합산
-- ────────────────────────────────────────────────────────────
-- 보너스 규칙:
--   D-30 ~ D-7 진입창   : +0.30 가산 (강한 진입 추천)
--   D-7  ~ D-0  피크접근: +0.50 가산 (피크 임박)
--   D+0  ~ D+tail        : +0.10 (잔여 마지노)
--   D+tail+1 ~ D+7       : -0.30 (철수 권장 — 마진 보존)
--   그 외                : 0
-- 매칭은 ggsan title 과 event.related_keywords 의 trigram similarity 사용.
-- ────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION jimscanner_event_proximity_score(target_date date)
RETURNS TABLE (
  event_key text,
  event_name text,
  anchor_date date,
  days_to_anchor int,
  window_label text,        -- 'pre_window' / 'peak' / 'tail' / 'exit'
  bonus real,
  related_keywords text[]
)
LANGUAGE sql STABLE AS $$
  WITH ev AS (
    SELECT
      e.event_key,
      e.event_name,
      e.anchor_month,
      e.anchor_day,
      e.lead_days,
      e.tail_days,
      e.related_keywords,
      -- 올해 anchor 와 내년 anchor 두 후보 중 절대거리 작은 것 선택
      LEAST(
        ABS(target_date - make_date(EXTRACT(year FROM target_date)::int, e.anchor_month, e.anchor_day)),
        ABS(target_date - make_date(EXTRACT(year FROM target_date)::int + 1, e.anchor_month, e.anchor_day)),
        ABS(target_date - make_date(EXTRACT(year FROM target_date)::int - 1, e.anchor_month, e.anchor_day))
      ) AS abs_dist,
      CASE
        WHEN ABS(target_date - make_date(EXTRACT(year FROM target_date)::int, e.anchor_month, e.anchor_day))
           <= ABS(target_date - make_date(EXTRACT(year FROM target_date)::int + 1, e.anchor_month, e.anchor_day))
         AND ABS(target_date - make_date(EXTRACT(year FROM target_date)::int, e.anchor_month, e.anchor_day))
           <= ABS(target_date - make_date(EXTRACT(year FROM target_date)::int - 1, e.anchor_month, e.anchor_day))
        THEN make_date(EXTRACT(year FROM target_date)::int, e.anchor_month, e.anchor_day)
        WHEN ABS(target_date - make_date(EXTRACT(year FROM target_date)::int + 1, e.anchor_month, e.anchor_day))
           < ABS(target_date - make_date(EXTRACT(year FROM target_date)::int - 1, e.anchor_month, e.anchor_day))
        THEN make_date(EXTRACT(year FROM target_date)::int + 1, e.anchor_month, e.anchor_day)
        ELSE make_date(EXTRACT(year FROM target_date)::int - 1, e.anchor_month, e.anchor_day)
      END AS anchor_date_chosen
    FROM jimscanner_event_calendar e
    WHERE e.is_active
      AND e.anchor_month IS NOT NULL
      AND e.anchor_day IS NOT NULL
  )
  SELECT
    ev.event_key,
    ev.event_name,
    ev.anchor_date_chosen AS anchor_date,
    (ev.anchor_date_chosen - target_date)::int AS days_to_anchor,
    CASE
      WHEN target_date < ev.anchor_date_chosen - LEAST(ev.lead_days, 7)
       AND target_date >= ev.anchor_date_chosen - ev.lead_days THEN 'pre_window'
      WHEN target_date < ev.anchor_date_chosen
       AND target_date >= ev.anchor_date_chosen - LEAST(ev.lead_days, 7) THEN 'peak'
      WHEN target_date >= ev.anchor_date_chosen
       AND target_date <= ev.anchor_date_chosen + ev.tail_days THEN 'tail'
      WHEN target_date > ev.anchor_date_chosen + ev.tail_days
       AND target_date <= ev.anchor_date_chosen + ev.tail_days + 7 THEN 'exit'
      ELSE 'idle'
    END AS window_label,
    CASE
      WHEN target_date < ev.anchor_date_chosen - LEAST(ev.lead_days, 7)
       AND target_date >= ev.anchor_date_chosen - ev.lead_days THEN 0.30::real
      WHEN target_date < ev.anchor_date_chosen
       AND target_date >= ev.anchor_date_chosen - LEAST(ev.lead_days, 7) THEN 0.50::real
      WHEN target_date >= ev.anchor_date_chosen
       AND target_date <= ev.anchor_date_chosen + ev.tail_days THEN 0.10::real
      WHEN target_date > ev.anchor_date_chosen + ev.tail_days
       AND target_date <= ev.anchor_date_chosen + ev.tail_days + 7 THEN -0.30::real
      ELSE 0::real
    END AS bonus,
    ev.related_keywords
  FROM ev
  WHERE target_date BETWEEN ev.anchor_date_chosen - ev.lead_days
                       AND ev.anchor_date_chosen + ev.tail_days + 7;
$$;

REVOKE ALL ON FUNCTION jimscanner_event_proximity_score(date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jimscanner_event_proximity_score(date) TO service_role;

-- ────────────────────────────────────────────────────────────
-- 추천 RPC 를 V0.1 로 갱신: 활성 이벤트 진입창 보너스 합산
-- ────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION jimscanner_ggsan_recommend(
  days_window int DEFAULT 30,
  min_sim float DEFAULT 0.20,
  min_score float DEFAULT 0.5,
  result_limit int DEFAULT 100
)
RETURNS TABLE (
  goods_no text,
  title text,
  cate_cd text,
  cate_label text,
  price_krw int,
  is_imminent boolean,
  image_url text,
  detail_url text,
  ggsan_last_seen timestamptz,
  tv_score real,
  search_score real,
  raw_score real,
  imminent_bonus real,
  event_proximity_score real,
  event_top_key text,
  event_top_window text,
  event_top_days_to_anchor int,
  final_score real,
  tv_match_count int,
  tv_top_keyword text,
  tv_total_pushes int,
  search_match_count int,
  search_top_keyword text,
  search_sources text[]
)
LANGUAGE sql STABLE SECURITY DEFINER AS $$
  WITH
  tv_keywords AS (
    SELECT keyword, COUNT(*)::int AS tv_count
    FROM jimscanner_trends_keywords
    WHERE source = 'naver_tvtime'
      AND collected_at > now() - (days_window || ' days')::interval
    GROUP BY keyword
  ),
  tv_matches AS (
    SELECT
      gp.goods_no,
      tv.keyword AS tv_keyword,
      tv.tv_count,
      similarity(tv.keyword, gp.title) AS sim,
      tv.tv_count::real * similarity(tv.keyword, gp.title) AS strength
    FROM tv_keywords tv
    CROSS JOIN LATERAL (
      SELECT g.goods_no, g.title
      FROM jimscanner_ggsan_products g
      WHERE g.title % tv.keyword
      ORDER BY similarity(tv.keyword, g.title) DESC
      LIMIT 5
    ) gp
    WHERE similarity(tv.keyword, gp.title) >= min_sim
  ),
  tv_agg AS (
    SELECT
      goods_no,
      SUM(strength)::real AS tv_score,
      COUNT(DISTINCT tv_keyword)::int AS tv_match_count,
      SUM(tv_count)::int AS tv_total_pushes,
      (ARRAY_AGG(tv_keyword ORDER BY strength DESC))[1] AS tv_top_keyword
    FROM tv_matches
    GROUP BY goods_no
  ),
  search_keywords AS (
    SELECT keyword, source, COUNT(*)::int AS occurrences
    FROM jimscanner_trends_keywords
    WHERE source IN (
      'naver_shopping_hot','naver_search_trend','aliex_best','musinsa_best'
    )
      AND collected_at > now() - (days_window || ' days')::interval
    GROUP BY keyword, source
  ),
  search_matches AS (
    SELECT
      gp.goods_no,
      sk.keyword AS search_keyword,
      sk.source,
      sk.occurrences,
      similarity(sk.keyword, gp.title) AS sim,
      sk.occurrences::real * similarity(sk.keyword, gp.title) AS strength
    FROM search_keywords sk
    CROSS JOIN LATERAL (
      SELECT g.goods_no, g.title
      FROM jimscanner_ggsan_products g
      WHERE g.title % sk.keyword
      ORDER BY similarity(sk.keyword, g.title) DESC
      LIMIT 5
    ) gp
    WHERE similarity(sk.keyword, gp.title) >= min_sim
  ),
  search_agg AS (
    SELECT
      goods_no,
      SUM(strength)::real AS search_score,
      COUNT(DISTINCT search_keyword)::int AS search_match_count,
      (ARRAY_AGG(search_keyword ORDER BY strength DESC))[1] AS search_top_keyword,
      ARRAY_AGG(DISTINCT source) AS search_sources
    FROM search_matches
    GROUP BY goods_no
  ),
  -- 활성 이벤트 (오늘 기준 진입/피크/철수 윈도우 안)
  active_events AS (
    SELECT * FROM jimscanner_event_proximity_score(CURRENT_DATE)
    WHERE bonus <> 0
  ),
  -- 이벤트 ↔ ggsan 매칭 (related_keywords trigram)
  event_matches AS (
    SELECT
      gp.goods_no,
      ae.event_key,
      ae.window_label,
      ae.days_to_anchor,
      ae.bonus,
      MAX(similarity(kw, gp.title)) AS sim,
      ae.bonus * MAX(similarity(kw, gp.title)) AS contribution
    FROM active_events ae
    CROSS JOIN LATERAL unnest(ae.related_keywords) AS kw
    CROSS JOIN LATERAL (
      SELECT g.goods_no, g.title
      FROM jimscanner_ggsan_products g
      WHERE g.title % kw
        AND similarity(kw, g.title) >= min_sim
      ORDER BY similarity(kw, g.title) DESC
      LIMIT 3
    ) gp
    GROUP BY gp.goods_no, ae.event_key, ae.window_label, ae.days_to_anchor, ae.bonus
  ),
  event_agg AS (
    SELECT
      goods_no,
      SUM(contribution)::real AS event_proximity_score,
      (ARRAY_AGG(event_key ORDER BY ABS(contribution) DESC))[1] AS event_top_key,
      (ARRAY_AGG(window_label ORDER BY ABS(contribution) DESC))[1] AS event_top_window,
      (ARRAY_AGG(days_to_anchor ORDER BY ABS(contribution) DESC))[1] AS event_top_days_to_anchor
    FROM event_matches
    GROUP BY goods_no
  ),
  scored AS (
    SELECT
      gp.goods_no, gp.title, gp.cate_cd, gp.cate_label, gp.price_krw,
      gp.is_imminent, gp.image_url, gp.detail_url, gp.last_seen_at,
      COALESCE(tv.tv_score, 0)::real AS tv_score,
      COALESCE(s.search_score, 0)::real AS search_score,
      COALESCE(ev.event_proximity_score, 0)::real AS event_proximity_score,
      COALESCE(ev.event_top_key, '') AS event_top_key,
      COALESCE(ev.event_top_window, '') AS event_top_window,
      COALESCE(ev.event_top_days_to_anchor, 0) AS event_top_days_to_anchor,
      COALESCE(tv.tv_match_count, 0) AS tv_match_count,
      COALESCE(tv.tv_top_keyword, '') AS tv_top_keyword,
      COALESCE(tv.tv_total_pushes, 0) AS tv_total_pushes,
      COALESCE(s.search_match_count, 0) AS search_match_count,
      COALESCE(s.search_top_keyword, '') AS search_top_keyword,
      COALESCE(s.search_sources, ARRAY[]::text[]) AS search_sources
    FROM jimscanner_ggsan_products gp
    LEFT JOIN tv_agg tv ON tv.goods_no = gp.goods_no
    LEFT JOIN search_agg s ON s.goods_no = gp.goods_no
    LEFT JOIN event_agg ev ON ev.goods_no = gp.goods_no
    WHERE tv.tv_score IS NOT NULL OR s.search_score IS NOT NULL OR ev.event_proximity_score IS NOT NULL
  )
  SELECT
    s.goods_no, s.title, s.cate_cd, s.cate_label, s.price_krw,
    s.is_imminent, s.image_url, s.detail_url, s.last_seen_at AS ggsan_last_seen,
    s.tv_score, s.search_score,
    (s.tv_score * 1.5 + s.search_score * 1.0)::real AS raw_score,
    (CASE WHEN s.is_imminent THEN 1.3 ELSE 1.0 END)::real AS imminent_bonus,
    s.event_proximity_score,
    s.event_top_key,
    s.event_top_window,
    s.event_top_days_to_anchor,
    -- final = (raw + event_proximity) × imminent_bonus
    (((s.tv_score * 1.5 + s.search_score * 1.0) + s.event_proximity_score)
       * (CASE WHEN s.is_imminent THEN 1.3 ELSE 1.0 END))::real AS final_score,
    s.tv_match_count, s.tv_top_keyword, s.tv_total_pushes,
    s.search_match_count, s.search_top_keyword, s.search_sources
  FROM scored s
  WHERE (((s.tv_score * 1.5 + s.search_score * 1.0) + s.event_proximity_score)
           * (CASE WHEN s.is_imminent THEN 1.3 ELSE 1.0 END)) >= min_score
  ORDER BY
    (CASE WHEN s.is_imminent THEN 1 ELSE 0 END) DESC,
    (((s.tv_score * 1.5 + s.search_score * 1.0) + s.event_proximity_score)
       * (CASE WHEN s.is_imminent THEN 1.3 ELSE 1.0 END)) DESC
  LIMIT result_limit;
$$;

REVOKE ALL ON FUNCTION jimscanner_ggsan_recommend(int, float, float, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jimscanner_ggsan_recommend(int, float, float, int) TO service_role;
