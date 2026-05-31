-- ────────────────────────────────────────────────────────────
-- 아침 발굴 브리핑 — 24h Δ 자동 감지·서술 다이제스트 (2026-05-31)
-- ────────────────────────────────────────────────────────────
-- 사용처: /admin/trend-radar (랜딩 '오늘의 브리핑' 카드)
-- 생산자: scripts/build-daily-briefing.mjs (run-crons 마지막 단계, 1일 1회)
-- 노출 정책: RLS enable + 정책 미정의 = service-role 만 접근 (기존 trends_* 패턴 동일)
--
-- payload(jsonb) 구조:
--   {
--     movers:   { up: [{product_id,name,prev,curr,delta}], down: [...] },
--     entries:  { entered: [{product_id,name,score}], exited: [...] },
--     ggsan:    [{goods_no,title,final_score,detail_url}],
--     alerts:   [{kind,severity,message}],
--     backlog:  { unclassified, delta }
--   }
-- narrative(text): Haiku/Claude CLI 가 위 델타만 보고 합성한 한국어 3~5줄
-- ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS jimscanner_trends_briefings (
  briefing_date date PRIMARY KEY,          -- KST 기준 1일 1행
  payload      jsonb NOT NULL DEFAULT '{}'::jsonb,
  narrative    text,
  computed_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS jimscanner_trends_briefings_computed_at
  ON jimscanner_trends_briefings(computed_at DESC);

ALTER TABLE jimscanner_trends_briefings ENABLE ROW LEVEL SECURITY;
-- 어드민(service-role)만. 정책 미정의 = service-role 외 접근 차단.
