-- ─────────────────────────────────────────────────────────────
-- 위너 지문 닮은꼴(Lookalike) 발굴 보드 — winner 태깅 컬럼
-- (product_discovery, 2026-06-05)
-- ─────────────────────────────────────────────────────────────
-- 목적: 실제로 팔린 상품('위너')의 시그널 지문을 학습해 닮은 신규
--       후보를 자동 랭킹하기 위한 양성(positive) 라벨을 보관한다.
--
-- 닮은꼴 점수 계산 자체는 RPC 가 아니라 서버 컴포넌트
--   src/app/admin/(dashboard)/trend-radar/lookalike/page.tsx 에서
--   최신 jimscanner_trends_scores + score_components 를 피처화해 코사인
--   유사도로 수행한다(opportunity 패턴과 동일하게 read-only).
--
-- 노출 정책: 기존 jimscanner_trends_* 와 동일하게 RLS enable + 정책 X
--   = service-role(어드민) 만 접근.
-- ─────────────────────────────────────────────────────────────

-- jimscanner_trends_products 에 위너 라벨 컬럼 추가.
ALTER TABLE jimscanner_trends_products
  ADD COLUMN IF NOT EXISTS is_winner       boolean     NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS units_sold      int         NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS winner_source   text,        -- 'orders_auto' | 'manual'
  ADD COLUMN IF NOT EXISTS winner_note     text,
  ADD COLUMN IF NOT EXISTS winner_tagged_at timestamptz;

-- 위너 후보 빠른 조회 (보드에서 centroid 계산 시 사용)
CREATE INDEX IF NOT EXISTS jimscanner_trends_products_is_winner
  ON jimscanner_trends_products(is_winner) WHERE is_winner = true;

-- ─────────────────────────────────────────────────────────────
-- 자동 태깅 헬퍼: 실판매가 발생한 상품을 product 이름으로 매칭해 위너로 승격.
--   coupang-orders 동기화로 쌓인 jimscanner_coupang_orders.product_name 을
--   canonical_name 과 ilike 매칭(취소 제외, 1건 이상 주문).
--   매칭이 fuzzy 하므로 운영자가 결과를 검토 후 수동 보정한다.
--
--   필요 시 recompute-scores cron 뒤 또는 수동으로 1회 실행:
-- ─────────────────────────────────────────────────────────────
-- WITH sold AS (
--   SELECT product_name, count(*)::int AS units
--     FROM jimscanner_coupang_orders
--    WHERE purchase_status NOT IN ('CANCEL', 'CANCELLED', 'RETURNED')
--    GROUP BY product_name
-- )
-- UPDATE jimscanner_trends_products p
--    SET is_winner = true,
--        units_sold = GREATEST(p.units_sold, s.units),
--        winner_source = COALESCE(p.winner_source, 'orders_auto'),
--        winner_tagged_at = now()
--   FROM sold s
--  WHERE s.product_name ILIKE '%' || p.canonical_name || '%'
--    AND p.is_winner = false;

-- 운영자 수동 플래그 예시:
-- UPDATE jimscanner_trends_products
--    SET is_winner = true, winner_source = 'manual', winner_note = '직접 검증', winner_tagged_at = now()
--  WHERE canonical_name = '식물성 멜라토닌';
