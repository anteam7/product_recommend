-- ─────────────────────────────────────────────────────────────
-- 채널 할당 옵티마이저 — 채널×카테고리 net-margin 모델
-- (2026-05-25, PR: feat/channel-assignment-optimizer)
-- ─────────────────────────────────────────────────────────────
-- 목적: 발굴·핀 처리된 SKU 에 대해 쿠팡/네이버 스마트스토어/11번가/지마켓 등
--       한국 주요 채널별 net margin 을 계산해 '어디에 올릴까' 자동 추천.
-- 사용처: /admin/trend-radar/recommend (Top1/Top2 채널 + 마진델타 컬럼)
--         /admin/trend-radar/pins (채널 필터 드롭다운)
-- 갱신 cron: scripts/refresh-channel-metrics.mjs (주1회)
-- RLS: service-role 만. (기존 jimscanner_* 패턴과 동일)
-- ─────────────────────────────────────────────────────────────

-- 1) 채널 × 카테고리 단위 수수료·CPC·리뷰장벽·정산리드타임
CREATE TABLE IF NOT EXISTS public.jimscanner_channel_metrics (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  channel text NOT NULL,           -- 'coupang' | 'naver_smartstore' | '11st' | 'gmarket' | 'auction'
  category text NOT NULL,          -- ggsan cate_cd ('001'..) 또는 'default'

  fee_pct numeric NOT NULL,                       -- 판매수수료 (%) — 쿠팡 10.8, 네이버 2.0+payCC, 11번가 13
  payment_fee_pct numeric NOT NULL DEFAULT 0,     -- 결제수수료 (%) — 네이버 페이 등 추가 부담분
  avg_cpc_krw int NOT NULL DEFAULT 0,             -- 평균 CPC (광고비) — 카테고리 평균
  review_entry_threshold int NOT NULL DEFAULT 0,  -- 노출 진입 최소 리뷰 수
  payout_lag_days int NOT NULL DEFAULT 14,        -- 정산 리드타임 (현금흐름 패널티)
  serp_share numeric NOT NULL DEFAULT 0,          -- 0~1, host 도메인 기반 SERP 점유율 (refresh cron 갱신)

  notes text,
  refreshed_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (channel, category)
);

CREATE INDEX IF NOT EXISTS idx_channel_metrics_channel
  ON public.jimscanner_channel_metrics (channel);
CREATE INDEX IF NOT EXISTS idx_channel_metrics_category
  ON public.jimscanner_channel_metrics (category);

ALTER TABLE public.jimscanner_channel_metrics ENABLE ROW LEVEL SECURITY;
-- 정책 정의 X = service-role 전용 (기존 패턴).


-- 2) 시드 데이터 — 2026-05 시점 한국 주요 채널 표준 수수료
--    출처: 각 채널 공식 입점 가이드 (2026 기준). category='default' = 카테고리 미지정 fallback.
INSERT INTO public.jimscanner_channel_metrics
  (channel, category, fee_pct, payment_fee_pct, avg_cpc_krw, review_entry_threshold, payout_lag_days, serp_share, notes)
VALUES
  ('coupang',          'default', 10.8, 0.0,  600,  20, 1,  0.42, '로켓그로스 기준 빠른정산(+1일). 광고경쟁 高.'),
  ('naver_smartstore', 'default',  2.0, 3.74, 350,  10, 7,  0.31, '판매수수료 낮음 + 네이버페이 결제수수료. 리뷰가중 強.'),
  ('11st',             'default', 13.0, 0.0,  450,  15, 10, 0.12, '광고경쟁 보통, 수수료 高.'),
  ('gmarket',          'default', 12.0, 0.0,  500,  15, 14, 0.10, '정산 리드타임 길음.'),
  ('auction',          'default', 12.0, 0.0,  400,  15, 14, 0.05, '구매층 노령화 추세, 일부 카테고리 강점.'),
  -- 건기식 (cate_cd 001~009, 011 ~ 020) — 광고경쟁 더 높음, 리뷰장벽 더 높음
  ('coupang',          '001',     10.8, 0.0,  900,  50, 1,  0.45, '장건강 카테고리. 광고경쟁 매우 高.'),
  ('coupang',          '002',     10.8, 0.0,  850,  50, 1,  0.43, '눈건강. 루테인 등 광고경쟁 高.'),
  ('coupang',          '007',     10.8, 0.0,  950,  60, 1,  0.46, '면역 — 비타민C·아연 격전지.'),
  ('naver_smartstore', '001',      2.0, 3.74, 600,  30, 7,  0.34, '장건강 — 리뷰가중 + 정기구독 강함.'),
  ('naver_smartstore', '007',      2.0, 3.74, 650,  30, 7,  0.33, '면역 — 정기구독·구독료 할인 강함.'),
  ('11st',             '001',     13.0, 0.0,  600,  30, 10, 0.10, '건기식 11번가 점유 낮음.'),
  -- 임박특가 (020) — 회전율 최우선
  ('coupang',          '020',     10.8, 0.0,  300,  10, 1,  0.55, '임박특가 — 회전율 高, 광고비 낮음.'),
  ('naver_smartstore', '020',      2.0, 3.74, 200,   5, 7,  0.28, '임박특가 — 라이브커머스 효과 큼.'),
  ('11st',             '020',     13.0, 0.0,  250,   5, 10, 0.10, '임박특가 — 쇼킹딜과 시너지.')
ON CONFLICT (channel, category) DO UPDATE
  SET fee_pct = EXCLUDED.fee_pct,
      payment_fee_pct = EXCLUDED.payment_fee_pct,
      avg_cpc_krw = EXCLUDED.avg_cpc_krw,
      review_entry_threshold = EXCLUDED.review_entry_threshold,
      payout_lag_days = EXCLUDED.payout_lag_days,
      serp_share = EXCLUDED.serp_share,
      notes = EXCLUDED.notes,
      refreshed_at = now();


-- 3) RPC: 단일 핀(SKU) 에 대해 채널별 점수 계산
-- ─────────────────────────────────────────────────────────────
-- 입력: pin_id (text — jimscanner_trends_pins 의 keyword 또는 ggsan goods_no)
--       expected_sale_price_krw (예상 판매가, NULL 이면 ggsan price_krw * 1.6 자동 추정)
--       cogs_krw (매입원가, NULL 이면 ggsan price_krw)
-- 출력: 채널별 (예상마진×수요점유 - 진입비용) 랭크
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION jimscanner_channel_match_score(
  pin_id text,
  expected_sale_price_krw numeric DEFAULT NULL,
  cogs_krw numeric DEFAULT NULL
)
RETURNS TABLE (
  channel text,
  category_used text,
  fee_pct numeric,
  avg_cpc_krw int,
  review_entry_threshold int,
  payout_lag_days int,
  serp_share numeric,

  est_sale_price_krw numeric,
  est_cogs_krw numeric,
  est_net_margin_krw numeric,
  est_net_margin_pct numeric,

  -- 종합 점수
  match_score numeric,
  rank int
)
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  WITH
  -- 1) pin → ggsan product 매핑 (goods_no 직매칭 우선, 없으면 trigram 매칭)
  src AS (
    SELECT
      p.cate_cd,
      p.price_krw,
      p.title
    FROM jimscanner_ggsan_products p
    WHERE p.goods_no = pin_id
       OR p.title % pin_id
    ORDER BY (CASE WHEN p.goods_no = pin_id THEN 0 ELSE 1 END),
             similarity(p.title, pin_id) DESC NULLS LAST
    LIMIT 1
  ),
  inputs AS (
    SELECT
      COALESCE(s.cate_cd, 'default') AS cate_cd,
      COALESCE(cogs_krw, s.price_krw, 0)::numeric AS cogs,
      COALESCE(expected_sale_price_krw,
               s.price_krw * 1.6,
               0)::numeric AS sale_price
    FROM src s
    -- src 가 비어도 1 row 보장
    RIGHT JOIN (SELECT 1) one ON true
  ),
  -- 2) 채널 metric — 카테고리 우선, 없으면 'default' fallback
  picks AS (
    SELECT DISTINCT ON (cm.channel)
      cm.channel,
      cm.category AS category_used,
      cm.fee_pct,
      cm.payment_fee_pct,
      cm.avg_cpc_krw,
      cm.review_entry_threshold,
      cm.payout_lag_days,
      cm.serp_share
    FROM jimscanner_channel_metrics cm
    CROSS JOIN inputs i
    WHERE cm.category = i.cate_cd
       OR cm.category = 'default'
    ORDER BY cm.channel,
             (CASE WHEN cm.category = i.cate_cd THEN 0 ELSE 1 END)
  ),
  computed AS (
    SELECT
      p.channel,
      p.category_used,
      p.fee_pct,
      p.avg_cpc_krw,
      p.review_entry_threshold,
      p.payout_lag_days,
      p.serp_share,
      i.sale_price AS est_sale_price_krw,
      i.cogs AS est_cogs_krw,
      -- net_margin_krw = 판매가 - 원가 - 판매수수료 - 결제수수료 - 광고비
      (i.sale_price
        - i.cogs
        - i.sale_price * (p.fee_pct / 100.0)
        - i.sale_price * (p.payment_fee_pct / 100.0)
        - p.avg_cpc_krw
      ) AS est_net_margin_krw,
      -- 정산 지연 패널티: 일당 0.05% 자본비용 가정
      (p.payout_lag_days * 0.0005 * i.cogs) AS payout_penalty_krw,
      i.sale_price, i.cogs
    FROM picks p
    CROSS JOIN inputs i
  )
  SELECT
    c.channel,
    c.category_used,
    c.fee_pct,
    c.avg_cpc_krw,
    c.review_entry_threshold,
    c.payout_lag_days,
    c.serp_share,
    c.est_sale_price_krw,
    c.est_cogs_krw,
    (c.est_net_margin_krw - c.payout_penalty_krw)::numeric AS est_net_margin_krw,
    CASE WHEN c.est_sale_price_krw > 0
      THEN ((c.est_net_margin_krw - c.payout_penalty_krw) / c.est_sale_price_krw * 100)::numeric
      ELSE 0::numeric
    END AS est_net_margin_pct,
    -- match_score = net_margin × serp_share - (리뷰장벽 * 진입비용가중)
    ((c.est_net_margin_krw - c.payout_penalty_krw) * (0.5 + c.serp_share)
      - c.review_entry_threshold * 50
    )::numeric AS match_score,
    ROW_NUMBER() OVER (
      ORDER BY
        ((c.est_net_margin_krw - c.payout_penalty_krw) * (0.5 + c.serp_share)
          - c.review_entry_threshold * 50) DESC
    )::int AS rank
  FROM computed c
  ORDER BY match_score DESC;
$$;

REVOKE ALL ON FUNCTION jimscanner_channel_match_score(text, numeric, numeric) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jimscanner_channel_match_score(text, numeric, numeric) TO service_role;


-- 4) RPC: 여러 핀 일괄 처리 (Top1/Top2 채널만 반환) — recommend 페이지 컬럼용
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION jimscanner_channel_match_top(
  goods_nos text[]
)
RETURNS TABLE (
  goods_no text,
  top1_channel text,
  top1_margin_pct numeric,
  top2_channel text,
  top2_margin_pct numeric,
  margin_delta_pct numeric
)
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  WITH per_pin AS (
    SELECT
      g AS goods_no,
      m.channel,
      m.est_net_margin_pct,
      m.rank
    FROM unnest(goods_nos) AS g
    CROSS JOIN LATERAL jimscanner_channel_match_score(g, NULL, NULL) m
    WHERE m.rank <= 2
  )
  SELECT
    p1.goods_no,
    p1.channel AS top1_channel,
    p1.est_net_margin_pct AS top1_margin_pct,
    p2.channel AS top2_channel,
    p2.est_net_margin_pct AS top2_margin_pct,
    (p1.est_net_margin_pct - COALESCE(p2.est_net_margin_pct, 0))::numeric AS margin_delta_pct
  FROM per_pin p1
  LEFT JOIN per_pin p2
    ON p2.goods_no = p1.goods_no AND p2.rank = 2
  WHERE p1.rank = 1;
$$;

REVOKE ALL ON FUNCTION jimscanner_channel_match_top(text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jimscanner_channel_match_top(text[]) TO service_role;
