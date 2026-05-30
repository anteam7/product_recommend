-- ─────────────────────────────────────────────────────────────
-- 주간 등록 캐파 플래너 — 선정 배치 영속화 (2026-05-30)
-- ─────────────────────────────────────────────────────────────
-- 사용처: /admin/trend-radar/weekly-plan
-- 목적: recommend RPC(final_score 랭킹) 위에 1인 셀러의 핵심 제약인
--   '한 주에 N건만 등록 가능'을 얹어, 캐파·카테고리 상한 하 greedy 선택 결과를
--   주차 단위로 저장 → 다음 주 이월·실행률 추적.
-- 노출 정책: RLS enable + 정책 정의 X = service-role 만 접근 (기존 패턴 동일).
-- ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS jimscanner_trends_weekly_plan (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  week_start date NOT NULL,                 -- 해당 주 월요일 (KST 기준 계산해 저장)
  goods_no text NOT NULL,                   -- ggsan 상품 식별자

  -- 선정 당시 스냅샷 (다음 주 비교·이월 판단용)
  title text,
  cate_cd text,
  cate_label text,
  price_krw int,
  is_imminent boolean NOT NULL DEFAULT false,
  final_score real NOT NULL DEFAULT 0,
  expected_margin int NOT NULL DEFAULT 0,   -- FEE/SHIP 공식 기대마진(원)
  plan_value real NOT NULL DEFAULT 0,       -- greedy 가치 = final_score × 마진가중

  group_type text NOT NULL DEFAULT 'week',  -- 'now'(시한성) | 'week'(이번 주)
  seq int NOT NULL DEFAULT 0,               -- 그룹 내 등록 순서
  reasons text[] NOT NULL DEFAULT '{}',     -- 선정 사유 칩 ('임박특가','TV편성' 등)

  status text NOT NULL DEFAULT 'planned',   -- 'planned' | 'done' | 'carried'
  done_at timestamptz,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (week_start, goods_no)
);

CREATE INDEX IF NOT EXISTS jimscanner_trends_weekly_plan_week
  ON jimscanner_trends_weekly_plan(week_start, group_type, seq);

CREATE INDEX IF NOT EXISTS jimscanner_trends_weekly_plan_status
  ON jimscanner_trends_weekly_plan(week_start, status);

ALTER TABLE jimscanner_trends_weekly_plan ENABLE ROW LEVEL SECURITY;
-- 어드민(service-role)만.

-- updated_at 자동 갱신 (기존 trends_* 트리거 패턴 재사용)
CREATE OR REPLACE FUNCTION jimscanner_trends_weekly_plan_set_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS jimscanner_trends_weekly_plan_updated_at ON jimscanner_trends_weekly_plan;
CREATE TRIGGER jimscanner_trends_weekly_plan_updated_at
  BEFORE UPDATE ON jimscanner_trends_weekly_plan
  FOR EACH ROW EXECUTE FUNCTION jimscanner_trends_weekly_plan_set_updated_at();
