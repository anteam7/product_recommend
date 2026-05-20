-- ────────────────────────────────────────────────────────────
-- 반품위험 스코어 — 위탁 ROI 사전 게이트 (2026-05-20)
-- ────────────────────────────────────────────────────────────
-- 위탁판매 손익을 무너뜨리는 반품률을 발굴 단계에서 차단.
-- 1) 카테고리별 baseline 반품률 테이블 (시드)
-- 2) ggsan 상품 단위 반품위험 점수 RPC (0~100)
-- 휴리스틱 신호:
--   (a) 카테고리 baseline
--   (b) 옵션·사이즈 변량 (title 토큰화)
--   (c) 가격대 (저가일수록 반품운임 비중 ↑)
--   (d) (장래) 리뷰/Q&A '사이즈 안맞', '색상 다름', '불량' 멘션 — V1
-- ────────────────────────────────────────────────────────────

-- 1) baseline 테이블
CREATE TABLE IF NOT EXISTS jimscanner_return_risk_baselines (
  category_top text PRIMARY KEY,
  baseline_return_rate numeric(5,2) NOT NULL,  -- % (0~100)
  evidence_n int DEFAULT 0,
  source_note text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE jimscanner_return_risk_baselines ENABLE ROW LEVEL SECURITY;

-- 시드 데이터 (한국 e-commerce 평균 반품률 — 업계 공개 통계 기반 추정)
-- 의류·패션잡화: 15~25%, 신발: 18~22%, 가전/디지털: 4~7%, 식품/건기식: 2~5%
INSERT INTO jimscanner_return_risk_baselines (category_top, baseline_return_rate, evidence_n, source_note) VALUES
  ('clothes',     20.0, 0, '의류 평균 반품률 추정 (사이즈/색상 불일치 주원인)'),
  ('shoes',       19.0, 0, '신발 평균 반품률 추정'),
  ('fashion_acc', 14.0, 0, '패션잡화 (가방/모자/시계) 평균'),
  ('beauty',      10.0, 0, '화장품 (피부 트러블 환불)'),
  ('living',       8.0, 0, '생활용품 평균'),
  ('digital',      6.0, 0, '디지털·가전 평균 (불량 위주)'),
  ('electronics',  6.0, 0, '가전 평균'),
  ('home',         7.0, 0, '홈리빙 평균'),
  ('kids',        12.0, 0, '유아동 (사이즈 의존성)'),
  ('sports',      11.0, 0, '스포츠/레저'),
  ('health',       3.0, 0, '건기식·식품 (개봉 불가)'),
  ('food',         2.5, 0, '식품 평균'),
  ('community',    5.0, 0, '커뮤니티 시그널 카테고리 fallback'),
  ('shopping_tv',  8.0, 0, 'TV쇼핑 카테고리 fallback'),
  ('all',          8.0, 0, '카테고리 불명 fallback')
ON CONFLICT (category_top) DO UPDATE SET
  baseline_return_rate = EXCLUDED.baseline_return_rate,
  source_note = EXCLUDED.source_note,
  updated_at = now();

-- ggsan cate_cd → category_top 매핑 (휴리스틱)
-- ggsan 의 카테고리 (001~014, 020) 는 대부분 건기식·식품 (반품률 낮음)
-- 의류/패션 ggsan 에 직접 없어도, 옵션 패턴이 의류성을 보이면 위험 가산
INSERT INTO jimscanner_return_risk_baselines (category_top, baseline_return_rate, evidence_n, source_note) VALUES
  ('ggsan_health',       3.0, 0, 'ggsan 건기식 카테고리 (001~013)'),
  ('ggsan_fresh',        4.0, 0, 'ggsan 신선식품 (014) — 변질 환불'),
  ('ggsan_imminent',     6.0, 0, 'ggsan 임박특가 (020) — 유통기한 클레임 ↑')
ON CONFLICT (category_top) DO UPDATE SET
  baseline_return_rate = EXCLUDED.baseline_return_rate,
  source_note = EXCLUDED.source_note,
  updated_at = now();

-- 2) RPC: goods_no 입력 → 반품위험 점수 0~100
CREATE OR REPLACE FUNCTION jimscanner_return_risk_score(
  p_goods_no text DEFAULT NULL,
  p_keyword text DEFAULT NULL
)
RETURNS TABLE (
  goods_no text,
  title text,
  cate_cd text,
  cate_label text,
  price_krw int,
  baseline_rate numeric,
  baseline_source text,
  option_variance_score int,    -- 0~30 (옵션·사이즈 변량)
  price_penalty_score int,      -- 0~20 (저가 → 반품운임 비중 ↑)
  category_score int,           -- 0~50 (baseline 변환)
  risk_score int,               -- 0~100 합산
  risk_tier text,               -- 'low' | 'medium' | 'high'
  signals text[]                -- 매칭된 위험 신호 (라벨)
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
AS $$
DECLARE
  v_title text;
  v_cate_cd text;
  v_cate_label text;
  v_price_krw int;
  v_goods_no text;
  v_baseline numeric := 8.0;
  v_baseline_src text := 'all';
  v_option int := 0;
  v_price int := 0;
  v_cat int := 0;
  v_risk int := 0;
  v_tier text;
  v_signals text[] := ARRAY[]::text[];
  v_lower text;
BEGIN
  -- 입력: goods_no 또는 keyword (keyword 면 가장 유사한 ggsan 상품 1건)
  IF p_goods_no IS NOT NULL THEN
    SELECT g.goods_no, g.title, g.cate_cd, g.cate_label, g.price_krw
      INTO v_goods_no, v_title, v_cate_cd, v_cate_label, v_price_krw
    FROM jimscanner_ggsan_products g
    WHERE g.goods_no = p_goods_no
    LIMIT 1;
  ELSIF p_keyword IS NOT NULL THEN
    SELECT g.goods_no, g.title, g.cate_cd, g.cate_label, g.price_krw
      INTO v_goods_no, v_title, v_cate_cd, v_cate_label, v_price_krw
    FROM jimscanner_ggsan_products g
    WHERE g.title % p_keyword
    ORDER BY similarity(g.title, p_keyword) DESC
    LIMIT 1;
  END IF;

  IF v_goods_no IS NULL THEN
    -- ggsan 미존재 — keyword 만으로 휴리스틱
    v_title := COALESCE(p_keyword, '');
    v_cate_cd := NULL;
    v_cate_label := NULL;
    v_price_krw := NULL;
  END IF;

  v_lower := lower(v_title);

  -- ───── (a) 카테고리 baseline ─────
  IF v_cate_cd IS NOT NULL THEN
    IF v_cate_cd = '020' THEN
      v_baseline_src := 'ggsan_imminent';
    ELSIF v_cate_cd = '014' THEN
      v_baseline_src := 'ggsan_fresh';
    ELSE
      v_baseline_src := 'ggsan_health';
    END IF;
  ELSE
    -- title 휴리스틱: 의류·신발 토큰이 보이면 강제 clothes/shoes baseline
    IF v_lower ~ '(티셔츠|셔츠|원피스|바지|팬츠|자켓|코트|니트|블라우스|레깅스|스커트|후드|맨투맨)' THEN
      v_baseline_src := 'clothes';
    ELSIF v_lower ~ '(운동화|구두|샌들|슬리퍼|부츠|스니커즈)' THEN
      v_baseline_src := 'shoes';
    ELSIF v_lower ~ '(가방|핸드백|지갑|벨트|모자|시계)' THEN
      v_baseline_src := 'fashion_acc';
    ELSIF v_lower ~ '(전자|가전|TV|냉장고|세탁기|에어컨|노트북|스마트폰)' THEN
      v_baseline_src := 'electronics';
    ELSE
      v_baseline_src := 'all';
    END IF;
  END IF;

  SELECT baseline_return_rate INTO v_baseline
  FROM jimscanner_return_risk_baselines
  WHERE category_top = v_baseline_src
  LIMIT 1;

  IF v_baseline IS NULL THEN
    v_baseline := 8.0;
    v_baseline_src := 'all';
  END IF;

  -- baseline % → category_score (0~50): 25% → 50점, 0% → 0점
  v_cat := LEAST(50, GREATEST(0, (v_baseline * 2)::int));

  -- ───── (b) 옵션·사이즈 변량 (title 토큰화) ─────
  -- 사이즈 토큰
  IF v_lower ~ '(\m(xs|s|m|l|xl|xxl|free)\M)' OR v_lower ~ '(사이즈|size)' THEN
    v_option := v_option + 15;
    v_signals := array_append(v_signals, '사이즈옵션');
  END IF;
  -- 컬러 N종 / 색상
  IF v_lower ~ '(\d+\s*(색|컬러|color))' OR v_lower ~ '(컬러|색상)' THEN
    v_option := v_option + 10;
    v_signals := array_append(v_signals, '컬러옵션');
  END IF;
  -- 옵션 N종 일반
  IF v_lower ~ '(\d+\s*(종|개입|타입))' THEN
    v_option := v_option + 5;
    v_signals := array_append(v_signals, '옵션다수');
  END IF;
  v_option := LEAST(30, v_option);

  -- ───── (c) 가격대 ─────
  -- 1만원 미만: 반품운임(보통 3~5천) 비중 30%↑ → +20
  -- 1~3만: +10
  -- 3만↑: 0
  IF v_price_krw IS NOT NULL THEN
    IF v_price_krw < 10000 THEN
      v_price := 20;
      v_signals := array_append(v_signals, '저가(반품운임↑)');
    ELSIF v_price_krw < 30000 THEN
      v_price := 10;
    ELSE
      v_price := 0;
    END IF;
  END IF;

  v_risk := LEAST(100, v_cat + v_option + v_price);

  IF v_risk >= 70 THEN
    v_tier := 'high';
  ELSIF v_risk >= 40 THEN
    v_tier := 'medium';
  ELSE
    v_tier := 'low';
  END IF;

  RETURN QUERY SELECT
    v_goods_no,
    v_title,
    v_cate_cd,
    v_cate_label,
    v_price_krw,
    v_baseline,
    v_baseline_src,
    v_option,
    v_price,
    v_cat,
    v_risk,
    v_tier,
    v_signals;
END;
$$;

GRANT EXECUTE ON FUNCTION jimscanner_return_risk_score(text, text) TO authenticated, service_role;

-- 3) 배치 RPC: 추천 후보 목록을 통째로 스코어링 (recommend 페이지·신규 return-risk 보드용)
CREATE OR REPLACE FUNCTION jimscanner_return_risk_batch(
  p_goods_nos text[]
)
RETURNS TABLE (
  goods_no text,
  risk_score int,
  risk_tier text,
  baseline_rate numeric,
  baseline_source text,
  signals text[]
)
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  SELECT
    s.goods_no,
    s.risk_score,
    s.risk_tier,
    s.baseline_rate,
    s.baseline_source,
    s.signals
  FROM unnest(p_goods_nos) AS g(gn)
  CROSS JOIN LATERAL jimscanner_return_risk_score(g.gn, NULL) AS s
$$;

GRANT EXECUTE ON FUNCTION jimscanner_return_risk_batch(text[]) TO authenticated, service_role;
