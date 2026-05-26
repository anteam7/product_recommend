-- ────────────────────────────────────────────────────────────
-- PB 침투율 게이트 (Private Brand penetration gate)
-- ────────────────────────────────────────────────────────────
-- 플랫폼 PB (쿠팡 곰곰/탐사/Coupang Only, 네이버 브랜드스토어 PB,
-- 이마트/홈플러스 PB 등)의 SERP 점유율을 (키워드·카테고리·가격대)별로
-- 누적 적재한다. trend-radar opportunity 보드에서 PB≥임계치 핀은
-- 자동 reject 사유 'PB 잠식'을 받는다.
--
-- 별도 게이트 이유: HHI 브랜드집중도는 외부 브랜드 분포만 본다.
-- PB 는 '플랫폼이 직접 경쟁자' 라는 질적으로 다른 위험.
-- ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS jimscanner_pb_penetration (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  keyword text NOT NULL,                       -- 검색 키워드 (정규화)
  category text,                               -- 상위 카테고리 ('health', 'living', 'digital', ...)
  price_bucket text,                           -- 'low' (<1만) | 'mid' (1-5만) | 'high' (5만+) | 'all'
  platform text NOT NULL DEFAULT 'coupang',    -- 'coupang' | 'naver' | 'emart' | 'homeplus' | ...

  serp_total integer NOT NULL DEFAULT 0,       -- 측정한 SERP 슬롯 총 개수
  pb_slot_count integer NOT NULL DEFAULT 0,    -- 그 중 PB 식별된 슬롯 수
  pb_share numeric(5,4) NOT NULL DEFAULT 0,    -- pb_slot_count / serp_total (0.0000~1.0000)
  pb_top_brand text,                           -- 가장 점유율 높은 PB 브랜드명 (예: '곰곰')
  pb_brands jsonb,                             -- {"곰곰": 7, "탐사": 3, ...}
  notes text,
  captured_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS jimscanner_pb_penetration_kw
  ON jimscanner_pb_penetration(keyword, captured_at DESC);
CREATE INDEX IF NOT EXISTS jimscanner_pb_penetration_cat
  ON jimscanner_pb_penetration(category, captured_at DESC);
CREATE INDEX IF NOT EXISTS jimscanner_pb_penetration_share
  ON jimscanner_pb_penetration(pb_share DESC, captured_at DESC);

ALTER TABLE jimscanner_pb_penetration ENABLE ROW LEVEL SECURITY;
-- service-role 만 접근 (어드민 페이지에서 createAdminClient 로 조회).


-- ────────────────────────────────────────────────────────────
-- 최신 (keyword × platform) 1행만 추리는 view — opportunity 보드용
-- ────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW jimscanner_pb_penetration_latest AS
SELECT DISTINCT ON (keyword, platform)
  keyword, platform, category, price_bucket,
  serp_total, pb_slot_count, pb_share, pb_top_brand, pb_brands,
  captured_at
FROM jimscanner_pb_penetration
ORDER BY keyword, platform, captured_at DESC;


-- ────────────────────────────────────────────────────────────
-- 6주 1차미분 (growth) — '신규 PB 진입 감지' 알림용
-- ────────────────────────────────────────────────────────────
-- 가장 최근값 − 6주 전 가장 가까운 값. 0.05 (5%p) 이상 상승 시
-- pins 보드에서 '신규 PB 진입' 배지.
CREATE OR REPLACE VIEW jimscanner_pb_penetration_growth AS
WITH recent AS (
  SELECT DISTINCT ON (keyword, platform)
    keyword, platform, pb_share AS share_now, captured_at AS captured_now
  FROM jimscanner_pb_penetration
  ORDER BY keyword, platform, captured_at DESC
),
old AS (
  SELECT DISTINCT ON (keyword, platform)
    keyword, platform, pb_share AS share_old, captured_at AS captured_old
  FROM jimscanner_pb_penetration
  WHERE captured_at < now() - interval '6 weeks'
  ORDER BY keyword, platform, captured_at DESC
)
SELECT
  r.keyword,
  r.platform,
  r.share_now,
  o.share_old,
  (r.share_now - COALESCE(o.share_old, 0))::numeric(5,4) AS share_growth,
  r.captured_now,
  o.captured_old
FROM recent r
LEFT JOIN old o USING (keyword, platform);
