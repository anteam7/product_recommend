-- ─────────────────────────────────────────────────────────────
-- 트렌드 레이더 — 발굴↔소싱 카테고리 정합 매트릭스 (sourcing-fit)
-- ─────────────────────────────────────────────────────────────
-- 발굴 수요(jimscanner_trends_*)와 소싱 공급(jimscanner_ggsan_products)을
-- 공통 카테고리 축으로 정규화 매핑하기 위한 선택적 오버라이드 테이블.
--
-- 코드(src/lib/trend-radar/sourcing-fit.ts)에 기본 정적 매핑(CANON)이 내장돼
-- 있으므로 이 테이블이 비어 있어도 보드는 동작한다. 운영자가 매핑을
-- 세밀하게 조정하고 싶을 때만 row 를 추가한다 (LLM 1회 정렬 결과 적재 등).
--
-- 노출 정책: 기존 jimscanner_trends_* 와 동일하게 RLS enable + 정책 X
--   = service-role(어드민)만 접근.
-- ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS jimscanner_trends_category_map (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  canon_key   text NOT NULL,            -- 정규화 카테고리 키 (예: 'gut', 'eye')
  label       text NOT NULL,            -- 표시명 (예: '장건강')

  -- 발굴(수요) 측 매칭 힌트
  category_top   text,                  -- 'health' | 'living' | 'digital' | NULL(=any)
  mid_keywords   text[] NOT NULL DEFAULT '{}',  -- category_mid / canonical_name 부분일치 키워드

  -- 소싱(공급) 측 매칭: ggsan cate_cd 목록
  ggsan_cate_cds text[] NOT NULL DEFAULT '{}',

  sort_order  int NOT NULL DEFAULT 100,
  created_at  timestamptz NOT NULL DEFAULT now(),

  UNIQUE (canon_key)
);

ALTER TABLE jimscanner_trends_category_map ENABLE ROW LEVEL SECURITY;
