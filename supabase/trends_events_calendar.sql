-- ─────────────────────────────────────────────────────────────
-- 트렌드 레이더 — 한국 이벤트 캘린더 (D-N 런웨이 선점 레이더)
-- ─────────────────────────────────────────────────────────────
-- 목적: 현 파이프라인은 전부 '이미 떠오른 시그널' 반응형이라 외생적 달력 축이 없음.
--   위탁 셀러는 리드타임(ggsan 입고 + 쿠팡 승인 ~7일) 때문에 이벤트 D-30 에
--   소싱을 착수해야 하는데, 시그널이 뜰 때(D-7)는 이미 늦음.
--   고정 이벤트는 매년 확정 수요라 선제 발굴 가치가 가장 확실.
--
-- 노출 정책: 기존 jimscanner_trends_* 패턴과 동일 — RLS enable + 정책 X = service-role 만.
-- UI: /admin/trend-radar/calendar (read-only)
-- 적용: psql + PGPASSWORD (docs/database.md), 시드 1회 + 매년 갱신.
-- ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS jimscanner_trends_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  name text NOT NULL,                  -- '설날', '추석', '빼빼로데이' 등
  slug text NOT NULL,                  -- 'seollal', 'chuseok' (안정 식별자, upsert 키)
  emoji text,                          -- 런웨이 표시용 (선택)

  -- 날짜: 고정일은 month/day, 움직이는 명절(음력)·특정일은 event_date 로 override.
  --   UI 는 event_date 가 있으면 우선, 없으면 month/day 로 '올해/내년 다음 발생일' 계산.
  month int CHECK (month BETWEEN 1 AND 12),
  day   int CHECK (day BETWEEN 1 AND 31),
  event_date date,                     -- 음력/가변일 (예: 설·추석)은 실제 날짜로 박아둠

  -- 매칭 태그: jimscanner_trends_products 와 교차.
  --   category_tags → products.category_top / category_mid 와 매칭
  --   keyword_tags  → products.canonical_name ILIKE 부분일치
  category_tags text[] NOT NULL DEFAULT '{}',
  keyword_tags  text[] NOT NULL DEFAULT '{}',

  -- 평균 수요 선행일: 이벤트 N일 전부터 검색·구매 수요가 붙기 시작.
  --   런웨이 게이트의 기준선 (소싱 리드타임과 비교).
  lead_days int NOT NULL DEFAULT 21,

  is_active boolean NOT NULL DEFAULT true,
  notes text,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (slug)
);

CREATE INDEX IF NOT EXISTS jimscanner_trends_events_active
  ON jimscanner_trends_events(is_active, month, day);

ALTER TABLE jimscanner_trends_events ENABLE ROW LEVEL SECURITY;
-- 어드민(service-role)만.

CREATE OR REPLACE FUNCTION jimscanner_trends_events_set_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS jimscanner_trends_events_updated_at ON jimscanner_trends_events;
CREATE TRIGGER jimscanner_trends_events_updated_at
  BEFORE UPDATE ON jimscanner_trends_events
  FOR EACH ROW EXECUTE FUNCTION jimscanner_trends_events_set_updated_at();


-- ─────────────────────────────────────────────────────────────
-- 시드: 한국 고정 이벤트 (1회 적재, 매년 음력 명절은 event_date 갱신)
--   lead_days 는 셀러 경험 기반 추정치 (수요 선행일). 데이터 쌓이면 작년 동(同)이벤트
--   ±2주 trends_scores 스파이크로 자기검증 후 보정.
-- ─────────────────────────────────────────────────────────────
INSERT INTO jimscanner_trends_events
  (name, slug, emoji, month, day, event_date, category_tags, keyword_tags, lead_days, notes)
VALUES
  ('설날 (음력)', 'seollal', '🎍', NULL, NULL, '2027-02-17',
   ARRAY['health','food'], ARRAY['홍삼','선물세트','영양제','견과','한과'], 35,
   '명절 선물세트 수요. 음력이라 매년 event_date 갱신 필요.'),
  ('추석 (음력)', 'chuseok', '🌕', NULL, NULL, '2026-09-25',
   ARRAY['health','food'], ARRAY['홍삼','선물세트','영양제','견과','한과'], 35,
   '명절 선물세트 최대 성수기. 음력 갱신 필요.'),
  ('신학기', 'new-semester', '🎒', 3, 2, NULL,
   ARRAY['health','living'], ARRAY['비타민','어린이','학생','면역','눈건강','루테인'], 28,
   '3월 초 개학. 어린이·학생 건강식품 수요.'),
  ('화이트데이', 'white-day', '🍬', 3, 14, NULL,
   ARRAY['food','living'], ARRAY['선물','캔디','초콜릿'], 21,
   '선물 수요. 건기식보다 가공식품 소구.'),
  ('어버이날', 'parents-day', '🌷', 5, 8, NULL,
   ARRAY['health'], ARRAY['홍삼','선물세트','영양제','관절','눈건강','혈행'], 28,
   '부모 선물 = 건강식품 최대 매칭 이벤트.'),
  ('여름 캠핑시즌', 'camping-season', '🏕', 6, 1, NULL,
   ARRAY['living','food'], ARRAY['캠핑','아웃도어','간편식','분말'], 30,
   '6~8월 성수기. 진입은 5월 초.'),
  ('빼빼로데이', 'pepero-day', '🍫', 11, 11, NULL,
   ARRAY['food','living'], ARRAY['선물','초콜릿','과자'], 21,
   '단발성 급등. 가공식품 한정.'),
  ('김장철', 'gimjang', '🥬', 11, 20, NULL,
   ARRAY['food','living'], ARRAY['김장','젓갈','고춧가루','절임','장갑'], 30,
   '11월 중하순. 식품 부자재 수요.'),
  ('블랙프라이데이', 'black-friday', '🛒', 11, 28, NULL,
   ARRAY['health','living','digital','food'], ARRAY['특가','대용량','세트'], 21,
   '연중 최대 할인 트래픽. 카테고리 무관 대용량·세트 소구.'),
  ('연말정산 시즌', 'year-end-tax', '🧾', 1, 15, NULL,
   ARRAY['health','living'], ARRAY['영양제','홍삼','대용량','구독'], 21,
   '1월 자기보상·건강 다짐 수요. 새해 결심과 겹침.'),
  ('새해 건강결심', 'new-year-resolution', '💪', 1, 1, NULL,
   ARRAY['health'], ARRAY['다이어트','체지방','단백질','비타민','유산균','면역'], 28,
   '1월 초 다이어트·건강 다짐 폭증. 건기식 최대 진입 타이밍.')
ON CONFLICT (slug) DO UPDATE SET
  name          = EXCLUDED.name,
  emoji         = EXCLUDED.emoji,
  month         = EXCLUDED.month,
  day           = EXCLUDED.day,
  event_date    = EXCLUDED.event_date,
  category_tags = EXCLUDED.category_tags,
  keyword_tags  = EXCLUDED.keyword_tags,
  lead_days     = EXCLUDED.lead_days,
  notes         = EXCLUDED.notes,
  updated_at    = now();
