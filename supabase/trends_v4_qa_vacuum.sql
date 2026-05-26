-- ─────────────────────────────────────────────────────────────
-- 트렌드 레이더 v4 — Q&A Vacuum Mining (2026-05-26)
-- ─────────────────────────────────────────────────────────────
-- SERP 미답변 Q&A 클러스터 진입 보드.
-- 쿠팡·네이버 스마트스토어 SERP 상위 상품 상세의 Q&A 섹션을
-- 수집·정량화해 '응답성 빈 구멍' 을 위탁 진입 차별화 게이트로.
--
-- 게이트: 답변율 < 40% AND 미답변 질문 ≥ 10건 → 'Q&A Vacuum' 핀 큐
-- 노출 정책: service-role 만 (RLS enable, 정책 미정의)
-- 관련: docs/trend-radar-v4-execution-plan.md, trends_v4_seller_tools.sql
-- ─────────────────────────────────────────────────────────────

-- 1) Raw Q&A 수집 — keyword × product_url × question 단위
CREATE TABLE IF NOT EXISTS jimscanner_trends_qa_raw (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  keyword text NOT NULL,                  -- 수집 시드 키워드 (예: '오메가3')
  source text NOT NULL,                   -- 'coupang' | 'smartstore' | 'naver_brand'
  product_url text NOT NULL,              -- 상세 페이지 URL
  product_title text,                     -- 상세에서 추출 (옵션)

  question text NOT NULL,                 -- Q&A 본문 (질문)
  question_hash text NOT NULL,            -- sha1(question) — 중복 가드용
  asked_at timestamptz,                   -- 질문 등록 시각 (사이트 표기)
  answered_at timestamptz,                -- 답변 등록 시각 (NULL = 미답변)
  seller_responded boolean NOT NULL DEFAULT false,
  response_lag_hours numeric,             -- answered_at - asked_at (분→시 환산)

  intent_label text,                      -- LLM 분류 후 채워짐 (호환|사이즈|배송|AS|사용법|구성품|기타)
  classified_at timestamptz,
  classified_by text,                     -- 'llm_claude_cli' | 'manual' 등

  collected_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (source, product_url, question_hash)
);

CREATE INDEX IF NOT EXISTS jimscanner_trends_qa_raw_keyword_at
  ON jimscanner_trends_qa_raw(keyword, collected_at DESC);

CREATE INDEX IF NOT EXISTS jimscanner_trends_qa_raw_unanswered
  ON jimscanner_trends_qa_raw(keyword, collected_at DESC)
  WHERE seller_responded = false;

CREATE INDEX IF NOT EXISTS jimscanner_trends_qa_raw_unclassified
  ON jimscanner_trends_qa_raw(collected_at DESC)
  WHERE intent_label IS NULL;

ALTER TABLE jimscanner_trends_qa_raw ENABLE ROW LEVEL SECURITY;


-- 2) Cluster 집계 — keyword × intent_label 단위 (recompute 시 upsert)
CREATE TABLE IF NOT EXISTS jimscanner_trends_qa_clusters (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  keyword text NOT NULL,
  cluster_label text NOT NULL,            -- '호환' | '사이즈' | '배송' | 'AS' | '사용법' | '구성품' | '기타'

  total_count int NOT NULL DEFAULT 0,
  answered_count int NOT NULL DEFAULT 0,
  unanswered_count int NOT NULL DEFAULT 0,
  answer_rate numeric,                    -- answered/total (0..1)
  avg_response_lag_hours numeric,         -- 답변된 질문 평균 응답시간

  sample_questions jsonb NOT NULL DEFAULT '[]'::jsonb,  -- 대표 질문 5개

  is_vacuum_gate boolean NOT NULL DEFAULT false,        -- answer_rate < 0.4 AND unanswered >= 10
  faq_draft text,                                       -- LLM 생성 FAQ 초안 (옵션)
  faq_drafted_at timestamptz,

  computed_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (keyword, cluster_label)
);

CREATE INDEX IF NOT EXISTS jimscanner_trends_qa_clusters_keyword
  ON jimscanner_trends_qa_clusters(keyword, computed_at DESC);

CREATE INDEX IF NOT EXISTS jimscanner_trends_qa_clusters_vacuum
  ON jimscanner_trends_qa_clusters(computed_at DESC)
  WHERE is_vacuum_gate = true;

ALTER TABLE jimscanner_trends_qa_clusters ENABLE ROW LEVEL SECURITY;
