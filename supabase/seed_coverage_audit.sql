-- 시드 커버리지 갭 감사 — 스냅샷 저장 + draft 시드 관례
-- 2026-05-29
--
-- 분석 본체는 src/lib/trends/seed-coverage.ts (페이지·cron 공유, 읽기 전용 계산).
-- 이 테이블은 cron(/api/cron/seed-coverage-audit)이 주기적으로 커버리지 추이를 남겨
-- '시드 입력단 자가교정'의 시계열을 보존하기 위한 것.
--
-- ── draft 시드 관례 ──
-- 신규 시드 제안은 기존 jimscanner_trends_seeds 에 is_active=false 로 insert.
-- config.proposed_from = 'seed-coverage-audit' 로 출처 표기. 운영자가 is_active=true 로
-- 승인하면 다음 trends cron(collect-naver-search-trends)부터 수집 대상에 포함.

CREATE TABLE IF NOT EXISTS jimscanner_trends_seed_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  window_days int NOT NULL DEFAULT 30,
  active_seed_count int NOT NULL DEFAULT 0,
  total_products int NOT NULL DEFAULT 0,
  total_signals int NOT NULL DEFAULT 0,
  product_coverage_rate numeric NOT NULL DEFAULT 0,   -- 0~1
  signal_coverage_rate numeric NOT NULL DEFAULT 0,    -- 0~1
  blindspot_count int NOT NULL DEFAULT 0,
  dead_seed_count int NOT NULL DEFAULT 0,
  -- 상세 페이로드 (블라인드스팟 클러스터 + dead seed 목록 스냅샷)
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS jimscanner_trends_seed_audit_created
  ON jimscanner_trends_seed_audit(created_at DESC);

ALTER TABLE jimscanner_trends_seed_audit ENABLE ROW LEVEL SECURITY;
-- 어드민(service-role)만 접근. 공개 SELECT 정책 없음.
