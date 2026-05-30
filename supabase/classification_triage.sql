-- ────────────────────────────────────────────────────────────
-- LLM 분류 예산 트리아지 (2026-05-31)
-- ────────────────────────────────────────────────────────────
-- 무료 티어 LLM 토큰/요청 한도가 희소 자원이라, 수백 건/일 유입되는
-- 미분류 trends_product 를 LLM 없이 저렴한 휴리스틱으로 기대가치(EV) 랭킹한다.
--
-- EV = (1 + 교차소스 빈도) × 최근 출현 기울기 × (1 + 커머스 어휘 매칭)
--   · 교차소스 빈도: alias 가 등장한 distinct source 수 (여러 소스에서 잡히면 화제성↑)
--   · 최근 출현 기울기: 출현 밀도(alias_count / 관측기간) × 최근성 감쇠(최근일수록↑)
--   · 커머스 어휘 매칭: 가격/구매 소구 어휘 사전 매칭 횟수 (구매전환 가능성)
--
-- classify-trends-llm.mjs 와 어드민 /admin/trend-radar/triage 가 공통으로 호출.
-- 두 소비자가 동일한 순위를 보도록 점수 산식을 SQL 한 곳에 둔다.
-- ────────────────────────────────────────────────────────────

create or replace function jimscanner_classification_triage(p_limit int default 200)
returns table (
  product_id uuid,
  canonical_name text,
  category_top text,
  alias_count int,
  source_count int,
  age_days numeric,
  days_since_last numeric,
  recency_slope numeric,
  commerce_hits int,
  ev_score numeric
)
language sql
stable
as $$
  with base as (
    select
      p.id,
      p.canonical_name,
      p.category_top,
      p.alias_count,
      greatest(extract(epoch from (p.last_seen_at - p.first_seen_at)) / 86400.0, 0) as age_days,
      greatest(extract(epoch from (now() - p.last_seen_at)) / 86400.0, 0) as days_since_last,
      (
        select count(distinct a.source)
        from jimscanner_trends_aliases a
        where a.product_id = p.id and a.source is not null
      ) as source_count,
      (
        -- 커머스 어휘 사전 매칭 (가격/구매 소구) — canonical + alias 표면형
        (case when p.canonical_name ~ '(최저가|구매|할인|특가|세일|쿠폰|무료배송|가성비|정품|세트|대용량|선물|추천|핫딜)' then 1 else 0 end)
        + (
            select count(*)
            from jimscanner_trends_aliases a
            where a.product_id = p.id
              and a.alias ~ '(최저가|구매|할인|특가|세일|쿠폰|무료배송|가성비|정품|세트|대용량|선물|추천|핫딜)'
          )
      )::int as commerce_hits
    from jimscanner_trends_products p
    where p.llm_classified_at is null
  ),
  scored as (
    select
      b.*,
      -- 최근 출현 기울기: 출현밀도 × 최근성 감쇠(최근 7일≈1.0, 30일≈0.19)
      (b.alias_count::numeric / greatest(b.age_days, 1))
        * (1.0 / (1.0 + b.days_since_last / 7.0)) as slope
    from base b
  )
  select
    s.id,
    s.canonical_name,
    s.category_top,
    s.alias_count,
    s.source_count::int,
    round(s.age_days, 2),
    round(s.days_since_last, 2),
    round(s.slope, 4),
    s.commerce_hits,
    round((1 + s.source_count) * s.slope * (1 + s.commerce_hits), 4) as ev_score
  from scored s
  order by ev_score desc, s.source_count desc, s.alias_count desc
  limit p_limit;
$$;

-- service_role(어드민·cron)만 호출. 공개 권한 부여 없음.
revoke all on function jimscanner_classification_triage(int) from public;
