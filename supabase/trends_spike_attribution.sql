-- ─────────────────────────────────────────────────────────────
-- 수요 스파이크 원인 자동 귀인 (2026-05-31)
-- ─────────────────────────────────────────────────────────────
-- 각 상품의 점수 시계열(jimscanner_trends_scores.final_score / trend_score)에서
-- 급등(스파이크) 발생일을 탐지하고, 귀인 윈도우(±1~2일) 내 타 소스의 동시 이벤트를
-- 교차조회해 스파이크 원인을 자동 라벨링한다.
--
-- 라벨(trigger_type):
--   'tv'      — naver_tvtime 동시 편성 키워드 매칭
--   'hotdeal' — quasarzone_sale 동시 등장
--   'ad'      — naver_blog 협찬/광고 버스트
--   'organic' — 외부 트리거 없음 (자생적 급등 = 가장 내구성 높은 진짜 신규수요)
--
-- 계산: scripts/attribute-spikes.mjs (로컬 또는 cron 야간 후처리)
-- 노출 정책: RLS enable + 정책 정의 X = service-role 만 접근 (기존 패턴 동일)
-- 관련 어드민: /admin/trend-radar/spike-attribution
-- ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS jimscanner_trends_spike_attribution (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES jimscanner_trends_products(id) ON DELETE CASCADE,

  spike_at timestamptz NOT NULL,             -- 급등 탐지된 computed_at
  score_before numeric,                      -- 직전 final_score
  score_after numeric,                       -- 급등 시점 final_score
  delta numeric,                             -- score_after - score_before
  delta_pct numeric,                         -- 상대 증가율 (%)

  trigger_type text NOT NULL,                -- 'tv' | 'hotdeal' | 'ad' | 'organic'
  trigger_confidence numeric NOT NULL DEFAULT 0,  -- 0.0~1.0
  evidence_refs jsonb NOT NULL DEFAULT '{}'::jsonb,  -- {tv:[...], hotdeal:[...], ad:[...]} 매칭 근거

  computed_at timestamptz NOT NULL DEFAULT now(),

  -- 같은 상품의 같은 급등은 한 번만 (재계산 시 upsert)
  UNIQUE (product_id, spike_at)
);

CREATE INDEX IF NOT EXISTS jimscanner_trends_spike_attribution_trigger
  ON jimscanner_trends_spike_attribution(trigger_type, spike_at DESC);

CREATE INDEX IF NOT EXISTS jimscanner_trends_spike_attribution_product
  ON jimscanner_trends_spike_attribution(product_id, spike_at DESC);

CREATE INDEX IF NOT EXISTS jimscanner_trends_spike_attribution_recent
  ON jimscanner_trends_spike_attribution(spike_at DESC);

ALTER TABLE jimscanner_trends_spike_attribution ENABLE ROW LEVEL SECURITY;
-- 어드민(service-role)만.
