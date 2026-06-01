-- ────────────────────────────────────────────────────────────
-- 트렌드 레이더 v5 — 수입 선점 갭 레이더 (Import Presence Gap, 2026-06-02)
-- ────────────────────────────────────────────────────────────
-- 가설: 한국 소비자는 떠드는데(수요 ON) 해외 공급은 존재하나(해외공급 ON)
--       국내 리테일러는 아직 안 붙은(국내리테일 OFF) 상품 = 위탁 1인 셀러의
--       가장 명확한 무경쟁 선점 진입점.
--
-- alias.source 를 3개 버킷으로 분류해 product_id 별 버킷 등장 여부를 집계:
--   ① 수요(demand)        : 커뮤니티·뉴스·검색 — 한국 소비자가 언급
--   ② 해외공급(foreign)   : 알리·무신사·1688 — 해외/직구 공급 존재
--   ③ 국내리테일(domestic): 네이버쇼핑·도매꾹·쿠팡 — 국내 판매자 이미 붙음
--
-- '수요 ON ∧ 해외공급 ON ∧ 국내리테일 OFF' = presence_gap (선점 후보)
--
-- 직구덤핑 리스크: 알리(aliex)가 KR 직배 저가로 깔린 상품은 회색 강등 후보
--   → jimscanner_trends_supplier 에 aliexpress row 가 짧은 lead_time 으로 존재하면 표시.
--
-- 노출 정책: 어드민(service-role) read-only. 기존 jimscanner_trends_* 패턴 동일.
-- 적용: psql + PGPASSWORD (docs/database.md). 적용 후 `as any` 캐스팅 유지(타입 미반영).
-- ────────────────────────────────────────────────────────────

CREATE OR REPLACE VIEW jimscanner_trends_v5_import_gap AS
WITH alias_buckets AS (
  -- product_id 별 버킷 등장 여부 + 소스 디테일
  SELECT
    a.product_id,
    bool_or(a.source IN (
      '82cook_talk', 'natepan_ranking', 'dcinside_realtime', 'ppomppu_main',
      'daum_news', 'naver_news', 'naver_tvtime'
    ))                                                          AS has_demand,
    bool_or(a.source IN ('aliex_best', 'musinsa_best', '1688')) AS has_foreign,
    bool_or(a.source IN (
      'naver_shopping_hot', 'naver_shopping_insight', 'domeggook_main', 'coupang'
    ))                                                          AS has_domestic,
    -- 버킷별 등장 소스 목록 (UI 배지·디버깅)
    array_agg(DISTINCT a.source) FILTER (WHERE a.source IN (
      '82cook_talk', 'natepan_ranking', 'dcinside_realtime', 'ppomppu_main',
      'daum_news', 'naver_news', 'naver_tvtime'
    ))                                                          AS demand_sources,
    array_agg(DISTINCT a.source) FILTER (WHERE a.source IN ('aliex_best', 'musinsa_best', '1688'))
                                                                AS foreign_sources,
    array_agg(DISTINCT a.source) FILTER (WHERE a.source IN (
      'naver_shopping_hot', 'naver_shopping_insight', 'domeggook_main', 'coupang'
    ))                                                          AS domestic_sources,
    count(*)                                                    AS alias_total
  FROM jimscanner_trends_aliases a
  GROUP BY a.product_id
),
latest_score AS (
  -- product_id 별 최신 score
  SELECT DISTINCT ON (s.product_id)
    s.product_id, s.trend_score, s.commerce_score, s.supplier_score,
    s.competition_score, s.final_score, s.computed_at
  FROM jimscanner_trends_scores s
  ORDER BY s.product_id, s.computed_at DESC
),
dumping AS (
  -- 알리(aliexpress)가 KR 직배 저가로 깔렸는지 — 짧은 lead_time = 직배 가능성
  SELECT
    sup.product_id,
    bool_or(sup.supplier_source IN ('aliexpress', 'temu')
            AND coalesce(sup.lead_time_days, 99) <= 14)         AS aliexpress_kr_direct,
    min(sup.price_krw) FILTER (
      WHERE sup.supplier_source IN ('aliexpress', 'temu')
    )                                                            AS aliexpress_min_krw
  FROM jimscanner_trends_supplier sup
  GROUP BY sup.product_id
),
ggsan_match AS (
  -- canonical_name 과 ggsan 카탈로그 title trigram 매칭 (위탁 소싱 가능 여부)
  SELECT
    p.id AS product_id,
    g.goods_no AS ggsan_goods_no,
    g.title    AS ggsan_title,
    g.price_krw AS ggsan_price_krw,
    g.detail_url AS ggsan_detail_url,
    similarity(p.canonical_name, g.title) AS ggsan_sim
  FROM jimscanner_trends_products p
  JOIN LATERAL (
    SELECT gg.goods_no, gg.title, gg.price_krw, gg.detail_url
    FROM jimscanner_ggsan_products gg
    WHERE gg.status <> 'removed'
      AND similarity(p.canonical_name, gg.title) > 0.2
    ORDER BY similarity(p.canonical_name, gg.title) DESC
    LIMIT 1
  ) g ON true
)
SELECT
  p.id                                         AS product_id,
  p.canonical_name,
  p.category_top,
  p.category_mid,
  p.brand,
  p.last_seen_at,
  p.alias_count,

  coalesce(ab.has_demand, false)               AS has_demand,
  coalesce(ab.has_foreign, false)              AS has_foreign,
  coalesce(ab.has_domestic, false)             AS has_domestic,
  coalesce(ab.demand_sources, '{}')            AS demand_sources,
  coalesce(ab.foreign_sources, '{}')           AS foreign_sources,
  coalesce(ab.domestic_sources, '{}')          AS domestic_sources,
  coalesce(ab.alias_total, 0)                  AS alias_total,

  -- 핵심: 수요 ON ∧ 해외공급 ON ∧ 국내리테일 OFF
  (coalesce(ab.has_demand, false)
   AND coalesce(ab.has_foreign, false)
   AND NOT coalesce(ab.has_domestic, false))   AS presence_gap,

  ls.trend_score,
  ls.commerce_score,
  ls.supplier_score,
  ls.competition_score,
  coalesce(ls.final_score, 0)                  AS final_score,
  ls.computed_at,

  (gm.ggsan_goods_no IS NOT NULL)              AS has_ggsan,
  gm.ggsan_goods_no,
  gm.ggsan_title,
  gm.ggsan_price_krw,
  gm.ggsan_detail_url,
  gm.ggsan_sim,

  coalesce(d.aliexpress_kr_direct, false)      AS aliexpress_kr_direct,
  d.aliexpress_min_krw
FROM jimscanner_trends_products p
LEFT JOIN alias_buckets ab ON ab.product_id = p.id
LEFT JOIN latest_score  ls ON ls.product_id = p.id
LEFT JOIN dumping        d ON d.product_id = p.id
LEFT JOIN ggsan_match   gm ON gm.product_id = p.id
ORDER BY
  -- 선점 후보 먼저, 그 안에서 final_score 내림차순
  (coalesce(ab.has_demand, false)
   AND coalesce(ab.has_foreign, false)
   AND NOT coalesce(ab.has_domestic, false)) DESC,
  coalesce(ls.final_score, 0) DESC;

-- VIEW 는 base 테이블 RLS 를 상속 (security_invoker 미사용 시 view owner 권한).
-- service-role 로만 조회하므로 추가 정책 불필요.
COMMENT ON VIEW jimscanner_trends_v5_import_gap IS
  '수입 선점 갭 레이더: 수요 ON·해외공급 ON·국내리테일 OFF 상품을 선점 후보로 랭킹 (2026-06-02)';
