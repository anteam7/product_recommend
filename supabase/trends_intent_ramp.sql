-- 구매의도 성숙도 램프 (Intent Maturation) — 2026-05-30
-- jimscanner_trends_keywords.classified_intent (휴면 필드) 활성화 후 시계열 집계.
--
-- intent 4종: informational / commercial / transactional / navigational
-- 같은 category_top 안에서 정보탐색(informational) 비중이 떨어지고
-- 거래형(transactional) 비중이 오르면 = '구매 직전'으로 성숙 중.
--
-- 적용:  psql "$PG_POOLER_URL" -f supabase/trends_intent_ramp.sql
-- (코드는 이 마이그레이션 적용 후 상태를 가정. 뷰는 types 에 없으므로 클라이언트에서 `as any`)

-- 주별 × category_top 인텐트 구성비 (분류된 키워드만 분모).
CREATE OR REPLACE VIEW jimscanner_trends_intent_weekly AS
SELECT
  category_top,
  date_trunc('week', collected_at)::date            AS week,
  count(*)                                           AS classified_count,
  avg(volume_relative)                               AS avg_volume,
  (count(*) FILTER (WHERE classified_intent = 'informational'))::numeric
    / NULLIF(count(*), 0)                            AS informational_share,
  (count(*) FILTER (WHERE classified_intent = 'commercial'))::numeric
    / NULLIF(count(*), 0)                            AS commercial_share,
  (count(*) FILTER (WHERE classified_intent = 'transactional'))::numeric
    / NULLIF(count(*), 0)                            AS transactional_share,
  (count(*) FILTER (WHERE classified_intent = 'navigational'))::numeric
    / NULLIF(count(*), 0)                            AS navigational_share
FROM jimscanner_trends_keywords
WHERE classified_intent IS NOT NULL
  AND category_top IS NOT NULL
GROUP BY category_top, date_trunc('week', collected_at)::date;

COMMENT ON VIEW jimscanner_trends_intent_weekly IS
  '구매의도 램프: category_top 별 주간 인텐트 구성비 (informational→transactional 이동 추세 추적용)';
