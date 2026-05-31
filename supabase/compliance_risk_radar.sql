-- ─────────────────────────────────────────────────────────────
-- 규제·리콜 리스크 레이더 (compliance / recall intelligence)
-- ─────────────────────────────────────────────────────────────
-- 이미 수집 중이지만 발굴에 안 쓰이던 KCA 보도자료(market_raw.source='kca_press',
-- market_signals.signal_type='gov_notice')와 naver_news raw 를 발굴 상품에 매핑한다.
--
-- ① 방어: 리콜·과징금·인증의무·위해정보 키워드가 걸린 상품을 red 로 플래그 → 발굴 후보에서 격리.
-- ② 공격: 특정 브랜드가 리콜됐으나 카테고리 수요는 유지되는 '리콜 공백'을 선점 후보로 승격.
--
-- 노출 정책: 기존 jimscanner_* 패턴과 동일 — RLS enable + 정책 미정의 = service-role 만 접근.
-- 채움 주체: src/app/api/cron/extract-compliance-risk/route.ts (로컬 cron 러너 우회 호출)
-- ─────────────────────────────────────────────────────────────


-- 1) 규제·리콜 시그널 — raw/signals 에서 위해 키워드를 추출해 분류한 단위.
--    한 보도자료/뉴스가 여러 상품에 걸릴 수 있으므로 시그널과 매핑(아래 flags)을 분리.
CREATE TABLE IF NOT EXISTS jimscanner_compliance_signals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  origin_kind text NOT NULL,         -- 'market_raw' | 'market_signal'
  origin_id text NOT NULL,           -- raw.id::text 또는 signal.id::text
  source text NOT NULL,              -- 'kca_press' | 'naver_news' | 'gov_notice' | ...

  title text NOT NULL,
  source_url text,

  -- 위해 유형: 리콜/회수 · 과징금 · 인증의무(KC/식약처/전안법) · 위해정보 · 리콜공백(기회)
  risk_type text NOT NULL,           -- 'recall' | 'penalty' | 'cert_required' | 'hazard'
  risk_level text NOT NULL DEFAULT 'yellow',   -- 'red' | 'yellow'
  matched_keywords text[] NOT NULL DEFAULT '{}',

  brand text,                        -- 본문에서 추출한 브랜드 (있을 때)
  category text,                     -- 추정 카테고리 (있을 때)

  captured_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (origin_kind, origin_id)
);

CREATE INDEX IF NOT EXISTS jimscanner_compliance_signals_type
  ON jimscanner_compliance_signals(risk_type, captured_at DESC);
CREATE INDEX IF NOT EXISTS jimscanner_compliance_signals_captured
  ON jimscanner_compliance_signals(captured_at DESC);

ALTER TABLE jimscanner_compliance_signals ENABLE ROW LEVEL SECURITY;


-- 2) 상품별 리스크 플래그 — product_id 당 1행(최신 재계산 시 upsert).
--    evidence: 어느 보도/뉴스가 근거인지 [{signal_id,title,url,risk_type,matched_keywords}]
--    opportunity: 리콜됐지만 카테고리 수요 유지 → 선점 공백 후보
CREATE TABLE IF NOT EXISTS jimscanner_compliance_flags (
  product_id uuid PRIMARY KEY REFERENCES jimscanner_trends_products(id) ON DELETE CASCADE,

  risk_flag text NOT NULL DEFAULT 'green',   -- 'green' | 'yellow' | 'red'
  opportunity boolean NOT NULL DEFAULT false,
  signal_count int NOT NULL DEFAULT 0,
  top_risk_type text,                        -- 'recall' | 'penalty' | 'cert_required' | 'hazard'
  evidence jsonb NOT NULL DEFAULT '[]'::jsonb,

  computed_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS jimscanner_compliance_flags_flag
  ON jimscanner_compliance_flags(risk_flag, computed_at DESC);
CREATE INDEX IF NOT EXISTS jimscanner_compliance_flags_opportunity
  ON jimscanner_compliance_flags(opportunity) WHERE opportunity = true;

ALTER TABLE jimscanner_compliance_flags ENABLE ROW LEVEL SECURITY;
