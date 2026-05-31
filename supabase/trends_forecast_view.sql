-- 수요 궤적 예측 보드 — product별 score 이력 집계 헬퍼 뷰
-- jimscanner_trends_scores (trend_score/final_score, computed_at 시계열)를
-- product_id 기준으로 시간순 정렬해 외삽 적합용 표본으로 노출한다.
--
-- 적용은 사람이 직접 수행 (psql + PGPASSWORD, Connection Pooler 6543).
-- 코드는 이 뷰가 존재한다고 가정하고 `as any` 캐스팅으로 접근한다.

create or replace view jimscanner_trends_score_history as
select
  s.product_id,
  s.computed_at,
  s.trend_score,
  s.final_score
from jimscanner_trends_scores s
where s.product_id is not null
  and s.computed_at is not null
order by s.product_id, s.computed_at;

comment on view jimscanner_trends_score_history is
  '수요 궤적 예측 보드용: product별 trend/final score 시계열 (Holt/선형 외삽 표본)';
