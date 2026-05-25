-- ────────────────────────────────────────────────────────────
-- 한국 택배 무게 구간 요금표 + DIM 마진 산출 (2026-05-26)
-- ────────────────────────────────────────────────────────────
-- 위탁판매 '진짜 마진' 계산:
--   billable_weight = max(실측무게, 부피무게=W×L×H/6000)
--   landed_cost     = 도매가 + courier_fee(billable_weight) + 마켓수수료 + 결제수수료
--   margin_pct      = (serp_median - landed_cost) / serp_median
-- 게이트: billable_weight >= 3kg & margin_pct < 25% → 자동 '보류'
-- ────────────────────────────────────────────────────────────

-- 1) 한국 택배사 구간 요금표 ------------------------------------------
CREATE TABLE IF NOT EXISTS kr_courier_rate_tiers (
  id bigserial PRIMARY KEY,
  carrier text NOT NULL,                 -- 'cj' | 'hanjin' | 'epost' | 'lotte' | 'logen'
  min_g integer NOT NULL,                -- 구간 시작 (g, inclusive)
  max_g integer NOT NULL,                -- 구간 끝 (g, inclusive)
  fee_krw integer NOT NULL,              -- 단위당 요금 (원)
  notes text,
  effective_from date NOT NULL DEFAULT current_date,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS kr_courier_rate_tiers_lookup
  ON kr_courier_rate_tiers(carrier, min_g, max_g);

ALTER TABLE kr_courier_rate_tiers ENABLE ROW LEVEL SECURITY;

-- 2) 시드 — 2026년 일반 계약가 기준 (B2C 위탁 평균치, 사업자 단가 계약 시 조정)
-- 출처: 각사 공시 + 위탁판매자 인터뷰 (2026년 1Q)
INSERT INTO kr_courier_rate_tiers (carrier, min_g, max_g, fee_krw, notes) VALUES
  ('cj',     0,     2000,  3500, 'CJ 극소형 ~2kg'),
  ('cj',     2001,  5000,  4500, 'CJ 소형 ~5kg'),
  ('cj',     5001, 10000,  5500, 'CJ 중형 ~10kg'),
  ('cj',    10001, 20000,  7500, 'CJ 대형 ~20kg'),
  ('cj',    20001, 30000,  9500, 'CJ 특대 ~30kg'),
  ('hanjin', 0,     2000,  3300, '한진 극소형'),
  ('hanjin', 2001,  5000,  4300, '한진 소형'),
  ('hanjin', 5001, 10000,  5300, '한진 중형'),
  ('hanjin',10001, 20000,  7300, '한진 대형'),
  ('hanjin',20001, 30000,  9300, '한진 특대'),
  ('epost',  0,     2000,  3800, '우체국 ~2kg'),
  ('epost',  2001,  5000,  4800, '우체국 ~5kg'),
  ('epost',  5001, 10000,  5800, '우체국 ~10kg'),
  ('epost', 10001, 20000,  7800, '우체국 ~20kg'),
  ('epost', 20001, 30000,  9800, '우체국 ~30kg'),
  ('lotte',  0,     2000,  3400, '롯데 극소형'),
  ('lotte',  2001,  5000,  4400, '롯데 소형'),
  ('lotte',  5001, 10000,  5400, '롯데 중형'),
  ('lotte', 10001, 20000,  7400, '롯데 대형'),
  ('logen',  0,     2000,  3200, '로젠 극소형'),
  ('logen',  2001,  5000,  4200, '로젠 소형'),
  ('logen',  5001, 10000,  5200, '로젠 중형'),
  ('logen', 10001, 20000,  7200, '로젠 대형')
ON CONFLICT DO NOTHING;

-- 3) SKU별 DIM 마진 산출 결과 캐시 ---------------------------------
CREATE TABLE IF NOT EXISTS jimscanner_ggsan_dim_margin (
  goods_no text PRIMARY KEY REFERENCES jimscanner_ggsan_products(goods_no) ON DELETE CASCADE,

  -- 입력 (raw_payload 에서 추출)
  actual_weight_g integer,               -- 실측 무게 (raw_payload.weight_g)
  box_l_cm numeric(8,2),                 -- 박스 가로
  box_w_cm numeric(8,2),                 -- 박스 세로
  box_h_cm numeric(8,2),                 -- 박스 높이

  -- 산출
  dim_weight_g integer,                  -- 부피무게 = L×W×H/6000 × 1000 (g)
  billable_weight_g integer,             -- max(actual, dim)
  weight_bucket text,                    -- 'lt2' | '2_5' | '5_10' | '10_20' | 'gt20'

  -- 비용 (기준 carrier='cj' + 마켓 수수료 12% + 결제 수수료 3.3%)
  courier_fee_krw integer,
  market_fee_pct numeric(5,2) DEFAULT 12,
  payment_fee_pct numeric(5,2) DEFAULT 3.3,
  unit_landed_cost_krw integer,          -- 도매가 + 택배비 + (serp_median × 수수료율)

  -- 마진
  serp_median_krw integer,               -- 시장가 중위값 (현재는 ggsan 도매가 × 1.7 가정)
  margin_krw integer,                    -- serp_median - landed_cost
  margin_pct numeric(6,2),               -- (margin / serp_median) × 100

  -- 게이트
  gate_status text,                      -- 'pass' | 'hold' | 'no_data'
  gate_reason text,

  computed_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS jimscanner_ggsan_dim_margin_gate
  ON jimscanner_ggsan_dim_margin(gate_status, billable_weight_g DESC);
CREATE INDEX IF NOT EXISTS jimscanner_ggsan_dim_margin_bucket
  ON jimscanner_ggsan_dim_margin(weight_bucket, margin_pct);

ALTER TABLE jimscanner_ggsan_dim_margin ENABLE ROW LEVEL SECURITY;
