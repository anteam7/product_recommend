-- ────────────────────────────────────────────────────────────
-- 건기식 원료 ↔ ggsan 완제품 브릿지 (PR-INGREDIENT-1, 2026-05-21)
-- ────────────────────────────────────────────────────────────
-- 목적: ggsan 22 카테고리 中 14개가 건기식. 그러나 trigram 매칭은
-- 상품/브랜드 단위(예: '고려은단 비타민C')만 잡고, 'NMN', '아쉬와간다'
-- 같이 원료가 먼저 트렌드화되는 패턴을 못 본다.
-- 원료 어휘집(lexicon)을 신설해서 trends_keywords + market_raw 의 원료
-- 멘션을 집계하고, ggsan title/description 에 ILIKE 매칭 → 브릿지 보드를 만든다.
-- ────────────────────────────────────────────────────────────

-- 1) 원료 어휘집 (운영자가 시드 + 수동 확장)
CREATE TABLE IF NOT EXISTS jimscanner_ingredient_lexicon (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,                       -- canonical 한글/영문 원료명 ('NMN', '아쉬와간다')
  aliases text[] NOT NULL DEFAULT '{}',            -- 변형/오타/영문 동치 ('니코틴아미드모노뉴클레오티드', 'Ashwagandha')
  functional_class text,                           -- '항노화' | '수면' | '항산화' | '에너지대사' | '관절' | '면역' ...
  regulatory_tag text,                             -- 'KFDA_고시형' | 'KFDA_개별인정' | '식품원료' | '직구만' | null
  notes text,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS jimscanner_ingredient_lexicon_active
  ON jimscanner_ingredient_lexicon(name) WHERE is_active;
CREATE INDEX IF NOT EXISTS jimscanner_ingredient_lexicon_class
  ON jimscanner_ingredient_lexicon(functional_class) WHERE is_active;

ALTER TABLE jimscanner_ingredient_lexicon ENABLE ROW LEVEL SECURITY;
-- 어드민(service_role) 전용

-- updated_at 트리거
CREATE OR REPLACE FUNCTION jimscanner_ingredient_lexicon_set_updated_at()
RETURNS trigger AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS jimscanner_ingredient_lexicon_updated_at ON jimscanner_ingredient_lexicon;
CREATE TRIGGER jimscanner_ingredient_lexicon_updated_at
  BEFORE UPDATE ON jimscanner_ingredient_lexicon
  FOR EACH ROW EXECUTE FUNCTION jimscanner_ingredient_lexicon_set_updated_at();

-- ────────────────────────────────────────────────────────────
-- 2) 원료별 멘션 velocity 뷰 (14d / 30d 카운트 + velocity 비율)
-- trends_keywords + market_raw(google_suggest, naver_news, naver_blog) 두 소스에서
-- canonical name 또는 alias 가 keyword/title 내에 ILIKE 매칭되는 row 카운트.
-- velocity = (14d count / 14) ÷ (30d count / 30) — 1.0 이면 평년, >1 이면 가속.
-- ────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW jimscanner_ingredient_velocity AS
WITH lex AS (
  SELECT
    id, name, aliases, functional_class, regulatory_tag,
    -- canonical + alias 합쳐 한 배열로
    array_prepend(name, aliases) AS all_terms
  FROM jimscanner_ingredient_lexicon
  WHERE is_active
),
-- trends_keywords 신호 (수집된 키워드 자체에 원료명 포함)
trk_30 AS (
  SELECT
    l.id AS ingredient_id,
    COUNT(*) FILTER (WHERE k.collected_at > now() - interval '14 days')::int AS trk_14d,
    COUNT(*) FILTER (WHERE k.collected_at > now() - interval '30 days')::int AS trk_30d,
    (ARRAY_AGG(k.keyword ORDER BY k.collected_at DESC) FILTER (WHERE k.collected_at > now() - interval '14 days'))[1] AS trk_recent_kw,
    (ARRAY_AGG(k.source ORDER BY k.collected_at DESC) FILTER (WHERE k.collected_at > now() - interval '14 days'))[1] AS trk_recent_src
  FROM lex l
  LEFT JOIN jimscanner_trends_keywords k
    ON k.collected_at > now() - interval '30 days'
   AND EXISTS (
     SELECT 1 FROM unnest(l.all_terms) t
     WHERE k.keyword ILIKE '%' || t || '%'
   )
  GROUP BY l.id
),
-- market_raw 신호 (google_suggest / naver_news / naver_blog title/query 에 포함)
mr_30 AS (
  SELECT
    l.id AS ingredient_id,
    COUNT(*) FILTER (WHERE m.captured_at > now() - interval '14 days' AND m.source = 'google_suggest')::int AS mr_suggest_14d,
    COUNT(*) FILTER (WHERE m.captured_at > now() - interval '14 days' AND m.source = 'naver_news')::int AS mr_news_14d,
    COUNT(*) FILTER (WHERE m.captured_at > now() - interval '14 days' AND m.source = 'naver_blog')::int AS mr_blog_14d,
    COUNT(*) FILTER (WHERE m.captured_at > now() - interval '14 days')::int AS mr_14d,
    COUNT(*) FILTER (WHERE m.captured_at > now() - interval '30 days')::int AS mr_30d
  FROM lex l
  LEFT JOIN jimscanner_market_raw m
    ON m.captured_at > now() - interval '30 days'
   AND m.source IN ('google_suggest','naver_news','naver_blog')
   AND EXISTS (
     SELECT 1 FROM unnest(l.all_terms) t
     WHERE COALESCE(m.title,'') ILIKE '%' || t || '%'
        OR COALESCE(m.query,'') ILIKE '%' || t || '%'
   )
  GROUP BY l.id
)
SELECT
  l.id,
  l.name,
  l.aliases,
  l.functional_class,
  l.regulatory_tag,
  COALESCE(trk_30.trk_14d, 0) AS trk_14d,
  COALESCE(trk_30.trk_30d, 0) AS trk_30d,
  COALESCE(mr_30.mr_suggest_14d, 0) AS mr_suggest_14d,
  COALESCE(mr_30.mr_news_14d, 0) AS mr_news_14d,
  COALESCE(mr_30.mr_blog_14d, 0) AS mr_blog_14d,
  COALESCE(mr_30.mr_14d, 0) AS mr_14d,
  COALESCE(mr_30.mr_30d, 0) AS mr_30d,
  (COALESCE(trk_30.trk_14d, 0) + COALESCE(mr_30.mr_14d, 0)) AS total_14d,
  (COALESCE(trk_30.trk_30d, 0) + COALESCE(mr_30.mr_30d, 0)) AS total_30d,
  -- velocity: 일평균 비율. 30d 합계가 0 이면 NULL.
  CASE
    WHEN (COALESCE(trk_30.trk_30d,0) + COALESCE(mr_30.mr_30d,0)) = 0 THEN NULL
    ELSE ROUND(
      (((COALESCE(trk_30.trk_14d,0) + COALESCE(mr_30.mr_14d,0))::numeric / 14.0)
       / NULLIF(((COALESCE(trk_30.trk_30d,0) + COALESCE(mr_30.mr_30d,0))::numeric / 30.0), 0))
      ::numeric, 3)
  END AS velocity,
  trk_30.trk_recent_kw,
  trk_30.trk_recent_src
FROM lex l
LEFT JOIN trk_30 ON trk_30.ingredient_id = l.id
LEFT JOIN mr_30  ON mr_30.ingredient_id  = l.id;

REVOKE ALL ON jimscanner_ingredient_velocity FROM PUBLIC;
GRANT SELECT ON jimscanner_ingredient_velocity TO service_role;

-- ────────────────────────────────────────────────────────────
-- 3) 원료 ↔ ggsan 매칭 RPC
-- 특정 원료에 매칭되는 ggsan 상품 목록 (title ILIKE 매칭, alias 포함)
-- ────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION jimscanner_ingredient_ggsan_matches(
  ingredient_id_in uuid,
  result_limit int DEFAULT 50
)
RETURNS TABLE (
  goods_no text,
  title text,
  cate_cd text,
  cate_label text,
  price_krw int,
  is_imminent boolean,
  image_url text,
  detail_url text,
  matched_term text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  WITH terms AS (
    SELECT unnest(array_prepend(name, aliases)) AS term
    FROM jimscanner_ingredient_lexicon
    WHERE id = ingredient_id_in AND is_active
  )
  SELECT DISTINCT ON (gp.goods_no)
    gp.goods_no,
    gp.title,
    gp.cate_cd,
    gp.cate_label,
    gp.price_krw,
    gp.is_imminent,
    gp.image_url,
    gp.detail_url,
    t.term AS matched_term
  FROM jimscanner_ggsan_products gp
  CROSS JOIN terms t
  WHERE gp.title ILIKE '%' || t.term || '%'
  ORDER BY gp.goods_no, (CASE WHEN gp.is_imminent THEN 0 ELSE 1 END), gp.last_seen_at DESC
  LIMIT result_limit;
$$;

REVOKE ALL ON FUNCTION jimscanner_ingredient_ggsan_matches(uuid, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jimscanner_ingredient_ggsan_matches(uuid, int) TO service_role;

-- ────────────────────────────────────────────────────────────
-- 4) ggsan 상품별 ingredient_match_count (recommend RPC 가 LEFT JOIN 할 수 있는 view)
-- 한 상품 title 안에 lexicon term 이 몇 개 매칭되는지 + matched ingredient names
-- ────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW jimscanner_ggsan_ingredient_match AS
WITH lex AS (
  SELECT name, aliases, functional_class,
         array_prepend(name, aliases) AS all_terms
  FROM jimscanner_ingredient_lexicon
  WHERE is_active
),
matches AS (
  SELECT
    gp.goods_no,
    l.name AS ingredient_name,
    l.functional_class
  FROM jimscanner_ggsan_products gp
  CROSS JOIN lex l
  WHERE EXISTS (
    SELECT 1 FROM unnest(l.all_terms) t WHERE gp.title ILIKE '%' || t || '%'
  )
)
SELECT
  goods_no,
  COUNT(DISTINCT ingredient_name)::int AS ingredient_match_count,
  ARRAY_AGG(DISTINCT ingredient_name ORDER BY ingredient_name) AS matched_ingredients,
  ARRAY_AGG(DISTINCT functional_class ORDER BY functional_class)
    FILTER (WHERE functional_class IS NOT NULL) AS matched_classes
FROM matches
GROUP BY goods_no;

REVOKE ALL ON jimscanner_ggsan_ingredient_match FROM PUBLIC;
GRANT SELECT ON jimscanner_ggsan_ingredient_match TO service_role;

-- ────────────────────────────────────────────────────────────
-- 5) 시드: NMN/베르베린/아쉬와간다/마그네슘비스글리시네이트/MCT오일/락토페린 외 40+
-- ON CONFLICT (name) DO NOTHING — 재실행 안전
-- ────────────────────────────────────────────────────────────
INSERT INTO jimscanner_ingredient_lexicon (name, aliases, functional_class, regulatory_tag) VALUES
  ('NMN', ARRAY['니코틴아미드모노뉴클레오티드','Nicotinamide Mononucleotide','엔엠엔'], '항노화', '직구만'),
  ('NAD+', ARRAY['NAD','니코틴아미드아데닌디뉴클레오티드'], '항노화', '직구만'),
  ('레스베라트롤', ARRAY['Resveratrol','트랜스레스베라트롤'], '항산화', 'KFDA_개별인정'),
  ('베르베린', ARRAY['Berberine','베르베린HCl'], '혈당관리', '직구만'),
  ('아쉬와간다', ARRAY['Ashwagandha','아슈와간다','인도인삼','위타니아솜니페라'], '스트레스완화', '식품원료'),
  ('마그네슘비스글리시네이트', ARRAY['Magnesium Bisglycinate','마그네슘 글리시네이트','Mg Glycinate'], '수면/이완', 'KFDA_고시형'),
  ('마그네슘트레오네이트', ARRAY['Magnesium Threonate','Magtein'], '인지/수면', '직구만'),
  ('MCT오일', ARRAY['MCT Oil','중쇄지방산','C8오일','카프릴산'], '에너지대사', '식품원료'),
  ('락토페린', ARRAY['Lactoferrin'], '면역', 'KFDA_개별인정'),
  ('콜라겐펩타이드', ARRAY['Collagen Peptide','저분자콜라겐','피쉬콜라겐','어류콜라겐'], '피부/관절', 'KFDA_고시형'),
  ('히알루론산', ARRAY['Hyaluronic Acid','HA'], '피부', 'KFDA_개별인정'),
  ('밀크씨슬', ARRAY['Milk Thistle','실리마린','Silymarin'], '간건강', 'KFDA_고시형'),
  ('UDCA', ARRAY['우르소데옥시콜산','웅담산','Ursodeoxycholic Acid'], '간건강', 'KFDA_고시형'),
  ('오메가3', ARRAY['Omega-3','EPA','DHA','피쉬오일','크릴오일','Krill'], '혈행건강', 'KFDA_고시형'),
  ('루테인', ARRAY['Lutein','지아잔틴','Zeaxanthin'], '눈건강', 'KFDA_고시형'),
  ('아스타잔틴', ARRAY['Astaxanthin'], '눈건강', 'KFDA_개별인정'),
  ('쏘팔메토', ARRAY['Saw Palmetto','쏘팔메또'], '전립선', 'KFDA_개별인정'),
  ('보스웰리아', ARRAY['Boswellia','유향수지','보스웰릭산'], '관절', 'KFDA_개별인정'),
  ('초록입홍합', ARRAY['Green Lipped Mussel','Lyprinol','립리놀','뉴질랜드초록홍합'], '관절', '직구만'),
  ('MSM', ARRAY['메틸설포닐메탄','Methylsulfonylmethane'], '관절', 'KFDA_고시형'),
  ('글루코사민', ARRAY['Glucosamine'], '관절', 'KFDA_고시형'),
  ('콘드로이친', ARRAY['Chondroitin'], '관절', 'KFDA_고시형'),
  ('CoQ10', ARRAY['코엔자임Q10','Ubiquinol','유비퀴놀'], '심장/에너지', 'KFDA_고시형'),
  ('PQQ', ARRAY['피롤로퀴놀린퀴논','Pyrroloquinoline Quinone'], '미토콘드리아', '직구만'),
  ('스피루리나', ARRAY['Spirulina'], '면역', 'KFDA_고시형'),
  ('클로렐라', ARRAY['Chlorella'], '면역', 'KFDA_고시형'),
  ('비타민D', ARRAY['Vitamin D','비타민D3','콜레칼시페롤','Cholecalciferol'], '면역/뼈', 'KFDA_고시형'),
  ('비타민K2', ARRAY['Vitamin K2','MK-7','메나퀴논'], '뼈건강', '직구만'),
  ('비오틴', ARRAY['Biotin','비타민B7'], '모발/피부', 'KFDA_고시형'),
  ('아연', ARRAY['Zinc','징크'], '면역', 'KFDA_고시형'),
  ('셀레늄', ARRAY['Selenium'], '항산화', 'KFDA_고시형'),
  ('프로바이오틱스', ARRAY['Probiotics','유산균','락토바실러스','Lactobacillus','비피더스'], '장건강', 'KFDA_고시형'),
  ('포스트바이오틱스', ARRAY['Postbiotics'], '장건강', '식품원료'),
  ('이뮤네이드', ARRAY['Immunade','베타글루칸','Beta-Glucan','베타글루칸'], '면역', 'KFDA_개별인정'),
  ('퀘르세틴', ARRAY['Quercetin'], '항산화/면역', '식품원료'),
  ('커큐민', ARRAY['Curcumin','강황','터메릭','Turmeric'], '항염', 'KFDA_개별인정'),
  ('마카', ARRAY['Maca','마카뿌리'], '에너지/남성', '식품원료'),
  ('홍경천', ARRAY['Rhodiola','로디올라'], '피로/스트레스', '식품원료'),
  ('테아닌', ARRAY['L-Theanine','엘테아닌'], '수면/이완', 'KFDA_개별인정'),
  ('GABA', ARRAY['가바','감마아미노부티르산'], '수면/이완', 'KFDA_개별인정'),
  ('5-HTP', ARRAY['5HTP','5-하이드록시트립토판'], '수면/기분', '직구만'),
  ('멜라토닌', ARRAY['Melatonin'], '수면', '직구만'),
  ('카르노신', ARRAY['Carnosine','L-Carnosine'], '항노화', '직구만'),
  ('타우린', ARRAY['Taurine'], '에너지', 'KFDA_고시형'),
  ('아세틸L카르니틴', ARRAY['Acetyl-L-Carnitine','ALCAR'], '인지/에너지', '직구만'),
  ('알파리포산', ARRAY['Alpha Lipoic Acid','ALA','알파-리포산'], '항산화', '직구만'),
  ('피크노제놀', ARRAY['Pycnogenol','소나무껍질추출물'], '혈행', 'KFDA_개별인정'),
  ('포도씨추출물', ARRAY['Grape Seed Extract','OPC','프로안토시아니딘'], '혈행/항산화', 'KFDA_개별인정'),
  ('블랙코호시', ARRAY['Black Cohosh','승마'], '갱년기여성', '직구만'),
  ('EGCG', ARRAY['녹차카테킨','Green Tea Extract','카테킨'], '체지방', 'KFDA_고시형')
ON CONFLICT (name) DO NOTHING;
