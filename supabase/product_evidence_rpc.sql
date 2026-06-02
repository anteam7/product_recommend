-- ────────────────────────────────────────────────────────────
-- 신호 증거 원문 드릴다운 RPC (2026-06-03)
-- ────────────────────────────────────────────────────────────
-- 사용처: /admin/trend-radar/products/[id] 상세 — '근거 원문(Evidence)' 패널
--
-- 점수(4-score)는 추상 숫자뿐이라 '왜 이 점수인가'를 사람이 검증 불가.
-- 이 RPC 는 점수의 근거 사슬을 역추적해 원문을 끌어온다:
--
--   jimscanner_trends_aliases (이 canonical 에 묶인 키워드/제목)
--     → 해당 alias 텍스트로 jimscanner_market_signals.keywords 매칭
--       → signal.raw_ids[] 를 따라 jimscanner_market_raw 원문 추출
--
-- 신규 테이블/컬럼 불필요 — 기존 raw_ids 조인만 사용.
-- 출처별(clien_park/naver_news/naver_blog/82cook/dcinside 등) 그룹핑은 UI 가 담당.
-- ────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION get_product_evidence(
  p_product_id uuid,
  p_days int DEFAULT 30
)
RETURNS TABLE (
  raw_id uuid,
  source text,
  source_url text,
  title text,
  query text,
  metadata jsonb,
  captured_at timestamptz,
  matched_alias text,
  matched_keyword text,
  signal_type text,
  signal_category text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  WITH
  -- 1) 이 canonical 상품에 묶인 alias 텍스트 (소문자 정규화)
  prod_aliases AS (
    SELECT DISTINCT lower(trim(alias)) AS alias
    FROM jimscanner_trends_aliases
    WHERE product_id = p_product_id
      AND length(trim(alias)) >= 2          -- 1글자 alias 는 과매칭 방지
  ),
  -- 2) alias ↔ signal.keywords 매칭 (정확일치 + 부분포함 양방향)
  matched_signals AS (
    SELECT
      s.id            AS signal_id,
      s.signal_type,
      s.category      AS signal_category,
      s.raw_ids,
      kw              AS matched_keyword,
      a.alias         AS matched_alias
    FROM jimscanner_market_signals s
    CROSS JOIN LATERAL unnest(s.keywords) AS kw
    JOIN prod_aliases a
      ON lower(kw) = a.alias
      OR lower(kw) LIKE '%' || a.alias || '%'
      OR a.alias   LIKE '%' || lower(kw) || '%'
    WHERE s.last_seen > now() - (p_days || ' days')::interval
  ),
  -- 3) signal.raw_ids[] 펼치기 → 원문 id 단위
  raw_expanded AS (
    SELECT
      ms.signal_type,
      ms.signal_category,
      ms.matched_keyword,
      ms.matched_alias,
      unnest(ms.raw_ids) AS raw_id
    FROM matched_signals ms
  ),
  -- 4) 원문 조인 + 원문당 1행 (가장 강한 매칭 근거 유지)
  deduped AS (
    SELECT DISTINCT ON (r.id)
      r.id AS raw_id,
      r.source,
      r.source_url,
      r.title,
      r.query,
      r.metadata,
      r.captured_at,
      re.matched_alias,
      re.matched_keyword,
      re.signal_type,
      re.signal_category
    FROM raw_expanded re
    JOIN jimscanner_market_raw r ON r.id = re.raw_id
    ORDER BY r.id, length(re.matched_keyword) DESC
  )
  SELECT
    raw_id, source, source_url, title, query, metadata, captured_at,
    matched_alias, matched_keyword, signal_type, signal_category
  FROM deduped
  ORDER BY captured_at DESC;
$$;

-- 어드민 service-role 만 호출
REVOKE ALL ON FUNCTION get_product_evidence(uuid, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION get_product_evidence(uuid, int) TO service_role;
