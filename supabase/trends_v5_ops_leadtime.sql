-- ─────────────────────────────────────────────────────────────
-- 트렌드 레이더 v5 — 운영 리드타임 설정 (기회 만료 카운트다운, 2026-06-01)
-- ─────────────────────────────────────────────────────────────
-- 목적: '내가 지금 착수해 등록 완료되는 시점에 트렌드가 아직 살아있는가'를
--       판정하기 위한 셀러 고유 운영 리드타임 상수.
--   잔여수명(반감기 추정) − 운영 리드타임(소싱+승인+발송) = 레이스 게이트.
-- 노출 정책: RLS enable + 정책 정의 X = service-role 만 접근 (기존 v4 패턴 동일).
-- 관련 페이지: src/app/admin/(dashboard)/trend-radar/window/page.tsx
-- ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS jimscanner_ops_leadtime (
  id text PRIMARY KEY DEFAULT 'main',        -- 단일 row (1인 셀러 가정)

  -- 착수 → 등록완료까지의 단계별 실측 리드타임 (일)
  sourcing_days  numeric NOT NULL DEFAULT 2,   -- ggsan 소싱 가용 확인 + 발주
  approval_days  numeric NOT NULL DEFAULT 4,   -- 쿠팡 DRAFT → APPROVED 실측
  shipping_days  numeric NOT NULL DEFAULT 2,   -- 첫 발송 준비 (재고 입고/검수)

  -- 게이트 임계치 (등록완료 시점 잔여수명 %)
  warn_pct   numeric NOT NULL DEFAULT 50,      -- 이 미만이면 '지금 착수 안하면 늦음'
  expire_pct numeric NOT NULL DEFAULT 10,      -- 이 미만이면 '이미 만료'

  notes text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE jimscanner_ops_leadtime ENABLE ROW LEVEL SECURITY;

-- updated_at 자동 갱신
CREATE OR REPLACE FUNCTION jimscanner_ops_leadtime_set_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS jimscanner_ops_leadtime_updated_at ON jimscanner_ops_leadtime;
CREATE TRIGGER jimscanner_ops_leadtime_updated_at
  BEFORE UPDATE ON jimscanner_ops_leadtime
  FOR EACH ROW EXECUTE FUNCTION jimscanner_ops_leadtime_set_updated_at();

-- 초기 row (기본 리드타임 8일: 소싱2 + 승인4 + 발송2)
INSERT INTO jimscanner_ops_leadtime (id, sourcing_days, approval_days, shipping_days, notes)
VALUES ('main', 2, 4, 2, 'v5 초기화 — 실측 후 어드민에서 보정')
ON CONFLICT (id) DO NOTHING;
