-- trends_v5_rank_trajectory.sql
-- 점수 시계열(jimscanner_trends_scores)을 일자×product_id 순위로 펼치는 RPC.
-- 현 UI 는 항상 MAX(computed_at) 1장만 소비 → 시간 정보가 통째로 버려짐.
-- 이 RPC 는 30일 윈도우의 일자별 final_score 를 랭킹화해 '순위 궤적'(bump chart)을 만든다.
--
-- 적용은 사람이 직접 (psql + PGPASSWORD, Connection Pooler 6543).
-- 프론트는 적용 후 상태를 가정하되, 현재 페이지는 RPC 없이도 동작하도록
-- 클라이언트 group-by 로 폴백 구현되어 있다 (이 RPC 는 성능 최적화용).

create or replace function jimscanner_trends_rank_trajectory(
  days_window int default 30
)
returns table (
  bucket_date date,
  product_id  uuid,
  final_score numeric,
  rank        int
)
language sql
stable
as $$
  with daily as (
    -- KST(UTC+9) 기준 일자별, product 별 그날의 마지막 점수
    select
      (s.computed_at at time zone 'Asia/Seoul')::date as bucket_date,
      s.product_id,
      (array_agg(s.final_score order by s.computed_at desc))[1] as final_score
    from jimscanner_trends_scores s
    where s.computed_at >= (now() - make_interval(days => days_window))
    group by 1, 2
  )
  select
    d.bucket_date,
    d.product_id,
    d.final_score,
    rank() over (
      partition by d.bucket_date
      order by d.final_score desc
    )::int as rank
  from daily d
  order by d.bucket_date, rank;
$$;

comment on function jimscanner_trends_rank_trajectory(int) is
  '30일 윈도우 점수 시계열을 일자×product 순위로 펼침 — rank trajectory bump chart 용';
