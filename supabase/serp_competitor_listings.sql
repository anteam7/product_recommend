-- ─────────────────────────────────────────────────────────────
-- SERP 경쟁자 리스팅 약점 보드 — Beat-Them-On-X (2026-05-21)
-- ─────────────────────────────────────────────────────────────
-- 트렌드 레이더 v4 의 jimscanner_trends_products 후보 핀 별로
-- 네이버쇼핑 / 쿠팡 등 상위 3~5위 판매자의 '실행 변수' (옵션 수,
-- 상세컷 수, 동영상 유무, 무배, 배송 SLA, 리뷰 수, 응답률, 저평점
-- 테마 jsonb) 를 수집·구조화한다.
--
-- 사용처:
--   - /admin/trend-radar/competitor-edge — 약점 보드 (Beat-Them-On-X)
--   - /admin/trend-radar/products/[id]   — 상품 상세 'Beat-Them-On-X' 카드
--   - jimscanner_trends_scores.score_components.competitor_edge_gap (0~100) 합산
--
-- 노출 정책: RLS enable + 정책 정의 X = service-role 만 접근.
-- ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS jimscanner_serp_competitor_listings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES jimscanner_trends_products(id) ON DELETE CASCADE,

  -- 채널 (네이버쇼핑 / 쿠팡 / 11번가 ...)
  channel text NOT NULL DEFAULT 'naver',     -- 'naver' | 'coupang' | '11st' ...
  rank int NOT NULL CHECK (rank >= 1 AND rank <= 20),

  seller text,                               -- 판매자명 (e.g. "샤오미공식")
  listing_url text,                          -- 원본 리스팅 URL
  title text,                                -- 리스팅 타이틀

  -- 실행 변수 (Beat-Them-On-X 레버)
  option_count int,                          -- 옵션 수 (색상/사이즈 합산)
  detail_image_count int,                    -- 상세 페이지 이미지 수
  has_video boolean,                         -- 상세에 동영상 포함 여부
  free_shipping boolean,                     -- 무료배송 여부
  ship_sla_hr int,                           -- 출고/도착 SLA (시간 단위, 24=익일)
  review_count int,                          -- 누적 리뷰 수
  response_rate numeric,                     -- 0~1 (판매자 응답률)

  -- 저평점 리뷰 테마 ('배송지연','내용물파손', ...) — LLM 추출
  -- 예: [{"theme":"배송지연","count":42,"sample":"2주 걸렸어요"}, ...]
  low_star_themes jsonb NOT NULL DEFAULT '[]'::jsonb,

  -- 가격 (참고용, 옵션이 여러 개면 대표가)
  price_krw numeric,

  scraped_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (product_id, channel, rank, scraped_at)
);

-- 가장 최신 스냅샷을 product_id 별로 빠르게 가져오기 위함.
CREATE INDEX IF NOT EXISTS jimscanner_serp_competitor_product_at
  ON jimscanner_serp_competitor_listings(product_id, scraped_at DESC);

CREATE INDEX IF NOT EXISTS jimscanner_serp_competitor_rank
  ON jimscanner_serp_competitor_listings(product_id, channel, rank, scraped_at DESC);

ALTER TABLE jimscanner_serp_competitor_listings ENABLE ROW LEVEL SECURITY;
-- 정책 정의 없음 = service-role 만.

-- ─────────────────────────────────────────────────────────────
-- 편의 뷰: product_id 별 가장 최근 스냅샷 (1~5위, channel='naver' 기본)
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW jimscanner_serp_competitor_latest AS
SELECT DISTINCT ON (l.product_id, l.channel, l.rank)
  l.product_id,
  l.channel,
  l.rank,
  l.seller,
  l.listing_url,
  l.title,
  l.option_count,
  l.detail_image_count,
  l.has_video,
  l.free_shipping,
  l.ship_sla_hr,
  l.review_count,
  l.response_rate,
  l.low_star_themes,
  l.price_krw,
  l.scraped_at
FROM jimscanner_serp_competitor_listings l
ORDER BY l.product_id, l.channel, l.rank, l.scraped_at DESC;
