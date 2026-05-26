-- 쿠팡 거절사유 클러스터링 → 자동수선 플레이북
--
-- jimscanner_coupang_listings.rejection_reason / approval_status_name 을
-- text-embedding-3-small + HDBSCAN 으로 클러스터링한 결과를 저장하는 테이블.
--
-- scripts/cluster-rejections.mjs (주 1회 cron) 가 INSERT/UPDATE 한다.
-- /admin/coupang-publish/rejections 어드민 페이지가 SELECT 해서 보드 표시.
-- /admin/coupang-publish/rejections 의 "자동 수선 재등록" 버튼 →
-- scripts/auto-repair-coupang.mjs 가 fix_template 을 적용한 신규 페이로드 생성.

CREATE TABLE IF NOT EXISTS jimscanner_coupang_rejection_patterns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cluster_id int NOT NULL,                                -- HDBSCAN 클러스터 인덱스 (-1 = noise)
  label text NOT NULL,                                    -- LLM 생성 라벨 (예: '이미지 누락', '성분표 누락', '광고문구 위반')
  exemplar_reason text NOT NULL,                          -- 해당 클러스터의 대표 거절 사유 텍스트
  fix_template jsonb NOT NULL DEFAULT '{}'::jsonb,        -- LLM 생성 수선 템플릿. 형태:
                                                          --   {
                                                          --     "summary": "성분표 누락 → ggsan 상세에서 성분 추출 후 attributes 매핑",
                                                          --     "steps": ["..."],
                                                          --     "payload_patch": { ... }  -- coupang-payload-builder 가 머지할 JSON 패치
                                                          --   }
  category_top jsonb NOT NULL DEFAULT '[]'::jsonb,        -- [{ "code": 73137, "name": "건강기능식품", "count": 12 }, ...]
  sample_count int NOT NULL DEFAULT 0,                    -- 클러스터에 속한 거절 리스팅 수
  recoverable_revenue_krw bigint NOT NULL DEFAULT 0,      -- 1회 수선 시 회수 가능 매출 추정 (sum of list_price_krw)
  generated_at timestamptz NOT NULL DEFAULT now(),
  generated_by text NOT NULL DEFAULT 'cluster-rejections.mjs',
  note text,
  UNIQUE (cluster_id, generated_at)
);

CREATE INDEX IF NOT EXISTS idx_coupang_rejection_patterns_cluster
  ON jimscanner_coupang_rejection_patterns (cluster_id);
CREATE INDEX IF NOT EXISTS idx_coupang_rejection_patterns_generated_at
  ON jimscanner_coupang_rejection_patterns (generated_at DESC);

-- 각 listing 이 어느 클러스터에 속하는지 매핑 (개별 reject → cluster_id)
CREATE TABLE IF NOT EXISTS jimscanner_coupang_rejection_assignments (
  listing_id uuid NOT NULL REFERENCES jimscanner_coupang_listings(id) ON DELETE CASCADE,
  cluster_id int NOT NULL,
  similarity real,                                        -- 클러스터 중심과의 코사인 유사도
  assigned_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (listing_id)
);

CREATE INDEX IF NOT EXISTS idx_coupang_rejection_assignments_cluster
  ON jimscanner_coupang_rejection_assignments (cluster_id);

-- 자동 수선 시도 로그
CREATE TABLE IF NOT EXISTS jimscanner_coupang_repair_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id uuid NOT NULL REFERENCES jimscanner_coupang_listings(id) ON DELETE CASCADE,
  cluster_id int NOT NULL,
  fix_template jsonb NOT NULL,
  result text NOT NULL CHECK (result IN ('queued','success','failed','skipped')),
  new_seller_product_id bigint,
  error_message text,
  attempted_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_coupang_repair_attempts_listing
  ON jimscanner_coupang_repair_attempts (listing_id);
CREATE INDEX IF NOT EXISTS idx_coupang_repair_attempts_attempted_at
  ON jimscanner_coupang_repair_attempts (attempted_at DESC);
