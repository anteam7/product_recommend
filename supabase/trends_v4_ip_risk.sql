-- ────────────────────────────────────────────────────────────
-- PR-4.6: 상표권/병행수입 리스크 스캐너 (2026-05-19)
-- ────────────────────────────────────────────────────────────
-- 위탁 IP 차단 자동 검출. 후보 상품별 다음 시그널 결합:
--   1) Naver 브랜드스토어/스마트스토어 공식 인증 마크 (셀러명 패턴)
--   2) SERP 상위 셀러명에 '공식'·'정품인증'·'한국지사'·'코리아' 패턴
--   3) KIPRIS 상표 등록 여부 + 권리자 국적 (수동 보강)
--   4) ggsan 도매 ↔ SERP 평균가 비율 비정상(>=3x) → 병행수입 의심
--
-- risk_score 0~100:
--   - 60+ : 진입 전 게이트 (빨간 배지)
--   - 30~59 : 주의
--   - 0~29 : 안전
-- ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS jimscanner_trends_ip_risk (
  product_id uuid PRIMARY KEY REFERENCES jimscanner_trends_products(id) ON DELETE CASCADE,

  -- 1) 공식 채널 존재 여부
  has_brand_store boolean NOT NULL DEFAULT false,         -- 네이버 브랜드스토어 매칭 발견
  official_seller_terms text[] NOT NULL DEFAULT '{}',     -- 감지된 패턴들 ('공식','정품인증','코리아',...)
  official_seller_hits int NOT NULL DEFAULT 0,            -- SERP top5 중 공식 패턴 매칭 셀러 수

  -- 2) 상표 등록
  trademark_found boolean NOT NULL DEFAULT false,
  owner_country text,                                     -- 'KR' | 'JP' | 'CN' | 'US' | NULL
  trademark_source text,                                  -- 'kipris' | 'google_patents' | 'heuristic' | NULL

  -- 3) 병행수입 의심
  parallel_import_suspect boolean NOT NULL DEFAULT false,
  ggsan_min_price_krw numeric,                            -- ggsan 매물 최저가
  serp_avg_price_krw numeric,                             -- SERP/Naver shopping 평균가
  price_ratio numeric,                                    -- serp / ggsan

  -- 4) 종합 위험도 (0~100)
  risk_score int NOT NULL DEFAULT 0 CHECK (risk_score >= 0 AND risk_score <= 100),
  risk_components jsonb,                                  -- 점수 분해 디테일

  last_checked_at timestamptz NOT NULL DEFAULT now(),
  check_source text,                                      -- 'local_heuristic' | 'kipris_api' 등
  notes text,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS jimscanner_trends_ip_risk_score
  ON jimscanner_trends_ip_risk(risk_score DESC, last_checked_at DESC);

CREATE INDEX IF NOT EXISTS jimscanner_trends_ip_risk_suspect
  ON jimscanner_trends_ip_risk(last_checked_at DESC)
  WHERE parallel_import_suspect;

CREATE INDEX IF NOT EXISTS jimscanner_trends_ip_risk_high
  ON jimscanner_trends_ip_risk(last_checked_at DESC)
  WHERE risk_score >= 60;

ALTER TABLE jimscanner_trends_ip_risk ENABLE ROW LEVEL SECURITY;
-- 어드민(service-role) 만.

-- updated_at 트리거
CREATE OR REPLACE FUNCTION jimscanner_trends_ip_risk_set_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_jimscanner_trends_ip_risk_updated_at
  ON jimscanner_trends_ip_risk;
CREATE TRIGGER trg_jimscanner_trends_ip_risk_updated_at
  BEFORE UPDATE ON jimscanner_trends_ip_risk
  FOR EACH ROW EXECUTE FUNCTION jimscanner_trends_ip_risk_set_updated_at();
