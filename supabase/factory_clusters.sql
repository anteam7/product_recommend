-- ────────────────────────────────────────────────────────────
-- OEM 공유공장 클러스터 (Shared-Factory Discovery)
-- ────────────────────────────────────────────────────────────
-- 목적: ggsan / 다나와·SERP 등에서 '같은 공장(OEM/ODM)에서
--       다른 브랜드로 출고되는 동형 제품'을 묶어 마진 헤드룸을
--       산출하기 위한 베이스 스토리지.
--
-- 클러스터링 신호 (signal_features JSONB 안에 저장):
--   - image_cosine_band: e.g. 0.82~0.95  (#28 dedup 임베딩 재사용)
--   - spec_match: 용량/정수/치수 normalized
--   - cert_no: 건강기능식품 인증번호 / 식약처 품목번호
--   - manufacturer: 제조원·판매원 표기 (text)
--   - origin: 원산지
--   - box_dimensions: WxHxD mm
--   - barcode_prefix: GS1 prefix (제조사 식별)
--
-- 구현 노트:
--   - 실제 클러스터링 잡은 scripts/cluster-factory.mjs (batch).
--   - 본 SQL 은 스키마 + 조회용 view 만 정의한다.
-- ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS jimscanner_factory_clusters (
  cluster_id        text PRIMARY KEY,
  label             text,                 -- 사람이 붙인 라벨 (옵션)
  signal_features   jsonb NOT NULL DEFAULT '{}'::jsonb,
  member_skus       text[] NOT NULL DEFAULT '{}'::text[],
  member_brands     text[] NOT NULL DEFAULT '{}'::text[],
  confidence        real NOT NULL DEFAULT 0.0,   -- 0~1
  -- 가격 분포 (캐시; 클러스터 잡이 갱신)
  min_wholesale_krw int,
  max_retail_krw    int,
  margin_headroom   int,                  -- max_retail - min_wholesale
  channel_mix       jsonb DEFAULT '{}'::jsonb,   -- {ggsan:n, danawa:n, smartstore:n,...}
  first_seen_at     timestamptz NOT NULL DEFAULT now(),
  last_seen_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_factory_clusters_confidence
  ON jimscanner_factory_clusters (confidence DESC, last_seen_at DESC);

CREATE INDEX IF NOT EXISTS idx_factory_clusters_margin
  ON jimscanner_factory_clusters (margin_headroom DESC NULLS LAST);

-- 클러스터 ↔ SKU 매핑 (정규화 테이블; member_skus 캐시와 병존)
CREATE TABLE IF NOT EXISTS jimscanner_factory_cluster_members (
  cluster_id      text NOT NULL REFERENCES jimscanner_factory_clusters(cluster_id) ON DELETE CASCADE,
  sku_source      text NOT NULL,         -- 'ggsan' | 'danawa' | 'serp' | 'smartstore' | ...
  sku_id          text NOT NULL,         -- source 내부 식별자 (ggsan: goods_no)
  brand           text,
  channel         text,                  -- 'wholesale' | 'retail' | 'mixed'
  price_krw       int,
  url             text,
  image_url       text,
  match_signals   jsonb DEFAULT '{}'::jsonb,  -- 어떤 신호로 매칭됐는지
  added_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (cluster_id, sku_source, sku_id)
);

CREATE INDEX IF NOT EXISTS idx_factory_cluster_members_sku
  ON jimscanner_factory_cluster_members (sku_source, sku_id);

CREATE INDEX IF NOT EXISTS idx_factory_cluster_members_brand
  ON jimscanner_factory_cluster_members (brand);

-- ────────────────────────────────────────────────────────────
-- View: 클러스터 lineup 요약 (admin 페이지가 빠르게 읽도록)
-- ────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW jimscanner_factory_clusters_summary AS
SELECT
  c.cluster_id,
  c.label,
  c.confidence,
  c.member_brands,
  cardinality(c.member_skus)              AS sku_count,
  cardinality(c.member_brands)            AS brand_count,
  c.min_wholesale_krw,
  c.max_retail_krw,
  c.margin_headroom,
  c.channel_mix,
  c.signal_features,
  c.first_seen_at,
  c.last_seen_at,
  -- 채널 다양성 (분포 엔트로피 근사) — 협상 카드 우선순위
  (SELECT count(DISTINCT m.sku_source)
     FROM jimscanner_factory_cluster_members m
     WHERE m.cluster_id = c.cluster_id)    AS source_diversity
FROM jimscanner_factory_clusters c;

-- ────────────────────────────────────────────────────────────
-- RPC: 핀(또는 임의) goods_no 의 'OEM 형제' 후보 조회
-- 사용처: /admin/trend-radar/products/[id] 'OEM 형제' 패널
-- ────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION jimscanner_factory_siblings_by_sku(
  p_sku_source text,
  p_sku_id     text,
  result_limit int DEFAULT 20
)
RETURNS TABLE (
  cluster_id   text,
  confidence   real,
  sku_source   text,
  sku_id       text,
  brand        text,
  channel      text,
  price_krw    int,
  url          text,
  image_url    text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  WITH my AS (
    SELECT cluster_id
    FROM jimscanner_factory_cluster_members
    WHERE sku_source = p_sku_source AND sku_id = p_sku_id
  )
  SELECT
    c.cluster_id,
    c.confidence,
    m.sku_source,
    m.sku_id,
    m.brand,
    m.channel,
    m.price_krw,
    m.url,
    m.image_url
  FROM jimscanner_factory_cluster_members m
  JOIN jimscanner_factory_clusters c USING (cluster_id)
  WHERE m.cluster_id IN (SELECT cluster_id FROM my)
    AND NOT (m.sku_source = p_sku_source AND m.sku_id = p_sku_id)
  ORDER BY
    -- 도매가 낮은순 / 리테일가 높은순을 마진 매칭에 쓸 수 있게
    CASE WHEN m.channel = 'wholesale' THEN m.price_krw END ASC NULLS LAST,
    CASE WHEN m.channel = 'retail'    THEN m.price_krw END DESC NULLS LAST
  LIMIT result_limit;
$$;

-- RLS: admin 전용 (service_role 만 직접 접근). 일반 anon 접근 차단.
ALTER TABLE jimscanner_factory_clusters         ENABLE ROW LEVEL SECURITY;
ALTER TABLE jimscanner_factory_cluster_members  ENABLE ROW LEVEL SECURITY;
-- 정책을 만들지 않으면 anon/auth role 모두 차단되며 service_role 만 통과.

COMMENT ON TABLE jimscanner_factory_clusters IS
  'OEM/ODM 공유공장 클러스터. cosine 0.82~0.95 이미지 유사도 + 사양/인증/제조원/원산지 매칭으로 묶인 동형 제품 그룹.';
COMMENT ON TABLE jimscanner_factory_cluster_members IS
  '클러스터에 속한 SKU 매핑. wholesale vs retail 채널 라벨로 마진 헤드룸 산출에 사용.';
