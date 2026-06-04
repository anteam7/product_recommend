-- ─────────────────────────────────────────────────────────────
-- 발굴 기각사유 학습 루프 — 운영자 판단을 재랭킹 신호로 (2026-06-04)
-- ─────────────────────────────────────────────────────────────
-- 운영자의 '기각/스누즈/소싱' 판단을 라벨 데이터로 포착해
-- 유사 후보(같은 cate_cd / 동일 reason_code)를 자동 하향한다.
-- 기존 jimscanner_trends_pins(키워드 핀)와 별개 — ggsan goods_no 단위 의사결정.
-- 노출 정책: RLS enable + 정책 X = service-role 만 접근 (기존 패턴 동일).
-- 관련: src/app/api/admin/trends/decision/route.ts,
--       src/app/admin/(dashboard)/trend-radar/recommend
-- ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS jimscanner_trends_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- 후보 식별 — 추천 RPC가 ggsan goods_no 단위이므로 goods_no 를 키로 사용.
  goods_no text NOT NULL,
  cate_cd  text,                       -- 재랭킹 시 같은 카테고리 후보 패널티 가산용 (denormalized)
  title    text,                        -- 사후 분석 가독성용 스냅샷

  -- 운영자 판단
  decision text NOT NULL CHECK (decision IN ('sourced', 'pinned', 'rejected', 'snoozed')),
  reason_code text CHECK (reason_code IN (
    'margin',       -- 마진부족
    'red_ocean',    -- 레드오션
    'cert_burden',  -- 인증부담
    'season_end',   -- 계절끝물
    'brand_lock',   -- 브랜드종속
    'no_supplier',  -- 도매없음
    'other'         -- 기타
  )),
  reason_text text,                     -- 자유 메모

  decided_by text,                      -- 운영자 이메일
  decided_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,               -- snoozed 의 경우 이 시각까지 숨김 (rejected 는 NULL=영구)

  created_at timestamptz NOT NULL DEFAULT now(),

  -- 한 goods_no 당 하나의 활성 결정 (재결정 시 upsert)
  UNIQUE (goods_no)
);

CREATE INDEX IF NOT EXISTS jimscanner_trends_decisions_decision
  ON jimscanner_trends_decisions(decision, decided_at DESC);

CREATE INDEX IF NOT EXISTS jimscanner_trends_decisions_cate
  ON jimscanner_trends_decisions(cate_cd, decision);

CREATE INDEX IF NOT EXISTS jimscanner_trends_decisions_reason
  ON jimscanner_trends_decisions(reason_code, decided_at DESC);

ALTER TABLE jimscanner_trends_decisions ENABLE ROW LEVEL SECURITY;
-- 어드민(service-role)만.
