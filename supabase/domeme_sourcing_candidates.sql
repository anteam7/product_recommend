-- 위탁 상품발굴 도출 결과 (2026-06-27)
-- 짐스캐너 트렌드 키워드 → 도매매(위탁) 검색 → 시장가(쿠팡 CDP/네이버 쇼핑) 매칭 → 마진순 '팔 상품' 후보.
-- 적재: scripts/domeme-sourcing-from-trends.mjs (일일). 소비: /admin/trend-radar/domeme.
-- 본업 공유 DB이나 jimscanner_ 접두 신규 테이블이라 기존 객체와 무관(추가형, 안전).
CREATE TABLE IF NOT EXISTS jimscanner_domeme_sourcing_candidates (
  supplier            text NOT NULL DEFAULT 'domeme',   -- 도매처 (현재 domeme=도매매)
  supplier_goods_no   text NOT NULL,                    -- 도매매 상품번호 (no)
  title               text,
  supply_price        integer,                          -- 도매매 위탁(공급)가
  moq                 integer,                          -- 최소구매수량
  inventory           integer,                          -- 재고
  overseas            boolean,                          -- 해외(중국 등) 재수출 여부
  category_hint       text,                             -- 도매매 카테고리(참고)
  -- 트렌드 근거
  trend_keyword       text,                             -- 매칭된 트렌드 키워드
  trend_signal        numeric,                          -- 가중 신호강도(소스 가중 합)
  trend_sources       text[],                           -- 신호 출처 소스들
  -- 시장가/마진
  market_source       text,                             -- 'coupang' | 'naver'
  market_price        integer,                          -- 경쟁 시장가(유사상품 하위30분위)
  market_n            integer,                          -- 시장가 산정에 쓴 유사 비교상품 수
  low_confidence      boolean DEFAULT false,            -- 저신뢰(비교상품 부족 or 시장가≥도매가×6 = 등급 불일치 의심)
  safe_cost           integer,                          -- 안전원가(목표순익 충족 상한)
  est_margin_krw      integer,                          -- 시장가 판매 시 예상 순이익(원)
  est_margin_rate     numeric,                          -- 예상 순마진율(%)
  sourcing_score      numeric,                          -- 신호강도 × 마진율 (랭킹 점수)
  -- 표시/링크
  image_url           text,
  detail_url          text,
  -- 운영
  adopted             boolean DEFAULT false,            -- 채택(핀) 여부 — 등록 진행 표식
  first_seen_at       timestamptz DEFAULT now(),
  last_sourced_at     timestamptz DEFAULT now(),
  PRIMARY KEY (supplier, supplier_goods_no)
);
CREATE INDEX IF NOT EXISTS idx_domeme_sourcing_score ON jimscanner_domeme_sourcing_candidates (sourcing_score DESC);
CREATE INDEX IF NOT EXISTS idx_domeme_sourcing_seen ON jimscanner_domeme_sourcing_candidates (last_sourced_at DESC);
CREATE INDEX IF NOT EXISTS idx_domeme_sourcing_margin ON jimscanner_domeme_sourcing_candidates (est_margin_rate DESC);
