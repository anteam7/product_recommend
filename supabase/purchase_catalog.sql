-- 매입 대상 상품 카탈로그 — 공급처(매입처) 5곳을 한 화면에서 비교/검색하기 위한 통합 뷰 + 일괄 쿠팡등록 큐
-- 화면: /admin/purchase-catalog   API: /api/admin/purchase-catalog, /api/admin/register-jobs
-- 적용: PGPASSWORD='...' node scripts/apply-sql.mjs supabase/purchase_catalog.sql
--
-- 마진 정의 — "최저판매가(MSP)로 팔았을 때" 기준:
--   원가   = 공급가(VAT 포함) + 매입배송비 1건
--   수수료 = MSP × 10.6%            (src/lib/coupang/price.ts FEE_RATE 와 동기화 지점)
--   순VAT  = max(0, (MSP - 원가)/11)  (매입 입력VAT 공제 반영 — upickb2b-register.mjs computePrice 와 동일)
--   마진   = MSP - 원가 - 수수료 - 순VAT
--   손익분기가 = ceil((0.9091 × 원가 / 0.8031) / 100) × 100  (순마진 0이 되는 판매가)

drop view if exists public.jimscanner_purchase_catalog;

create view public.jimscanner_purchase_catalog as
with base as (
  -- ── ggsan (건강산) ─────────────────────────────────────────────
  select 'ggsan'::text            as source,
         g.goods_no::text         as goods_no,
         g.title                  as title,
         g.brand                  as brand,
         g.image_url              as thumb_url,
         g.detail_url             as detail_url,
         g.price_krw              as supply_price,
         g.list_price_krw         as list_price,
         3000                     as ship_fee,
         '고정 3,000원 가정'::text as ship_basis,
         g.min_sell_price_krw     as msp,
         null::jsonb              as tiered_msp,
         g.status                 as status,
         (g.status = 'active')    as is_active,
         true                     as supports_coupang,
         (g.status = 'active' and coalesce(g.min_sell_price_krw,0) > 0) as coupang_target,
         null::text               as note,
         nullif(g.raw_payload->'coupang_predicted_category'->>'id','')::int as category_code,
         g.updated_at             as updated_at
  from public.jimscanner_ggsan_products g

  union all
  -- ── upickb2b (유픽B2B) ────────────────────────────────────────
  select 'upickb2b', u.product_no::text, u.title, null, u.image_thumb, u.detail_url,
         u.member_price_krw, null::int,
         coalesce(nullif(regexp_replace(coalesce(substring(u.shipping_fee_text from '([0-9,]+)\s*원'), ''), ',', '', 'g'), '')::int, 3000),
         coalesce(substring(u.shipping_fee_text from '([0-9,]+\s*원)'), '고정 3,000원 가정'),
         u.min_sell_price_krw, u.tiered_msp,
         u.status, (u.status = 'active'), true,
         (u.status = 'active' and coalesce(u.min_sell_price_krw,0) > 0),
         u.sellable_platforms, null::int, u.updated_at
  from public.jimscanner_upickb2b_products u

  union all
  -- ── bio77 (77바이오) ──────────────────────────────────────────
  select 'bio77', b.goods_no::text, coalesce(b.display_title, b.title), b.brand, b.thumb_url, b.detail_url,
         b.dome_price_krw, null::int, 3000, '고정 3,000원 가정',
         b.msp_price_krw, null::jsonb,
         b.status, (b.status = '정상'), true,
         (b.status = '정상' and b.coupang_sellable and coalesce(b.msp_price_krw,0) > 0),
         case when b.coupang_sellable then null else '쿠팡 판매불가 표기' end,
         b.coupang_category_code,
         b.updated_at
  from public.jimscanner_bio77_products b

  union all
  -- ── beseller (비셀러) ─────────────────────────────────────────
  --   네이버 스마트스토어 전용으로 운영 중 — 쿠팡 등록 파이프라인 없음(supports_coupang=false)
  select 'beseller', e.product_code::text, e.title, null, e.thumb_url, e.detail_url,
         e.supply_price, null::int, 0, '무료배송(공급처 부담)',
         e.min_sell_price, null::jsonb,
         e.status, (e.status = 'active'), false, false,
         '네이버 전용 — 쿠팡 등록기 없음', null::int, e.updated_at
  from public.jimscanner_beseller_products e

  union all
  -- ── wellroot (웰루트B2B) ──────────────────────────────────────
  select 'wellroot', w.product_no::text, coalesce(w.title_clean, w.title), w.brand, w.thumb_url, w.detail_url,
         w.supply_price_krw, w.list_price_krw,
         coalesce(w.shipping_fee_krw, 3000),
         coalesce(w.shipping_text, '고정 3,000원 가정'),
         w.msp_price_krw, w.tiered_msp,
         w.status, (w.status = 'active'), true, w.coupang_eligible,
         nullif(concat_ws(' · ',
           case when w.is_health_functional then '건기식' end,
           case when w.has_option           then '옵션상품' end,
           case when w.register_excluded    then '등록제외: ' || coalesce(w.register_excluded_reason,'') end,
           case when coalesce(w.msp_price_krw,0) = 0 then 'MSP 미확인' end), ''),
         w.coupang_category_code,
         w.updated_at
  from public.jimscanner_wellroot_products w
),
calc as (
  -- 수수료율은 등록 카테고리로 정해진다(영양제 7.6% vs 그 외 식품 10.6%) — 고정 상수를 쓰면 마진 순위가 뒤바뀐다.
  -- 근거표: jimscanner_coupang_category_commission (supabase/coupang_category_commission.sql)
  -- 손익분기가 유도: margin = S - C - S·f - (S-C)/11 = 0 → S = 0.909091·C / (0.909091 - f)
  select b.*,
         (coalesce(b.supply_price,0) + coalesce(b.ship_fee,0))                                as real_cost,
         coalesce(cc.rate, 0.106)                                                             as fee_rate,
         coalesce(cc.name, '(미확인)')                                                         as fee_category,
         ceil((0.909091 * (coalesce(b.supply_price,0) + coalesce(b.ship_fee,0))
               / (0.909091 - coalesce(cc.rate, 0.106))) / 100) * 100                          as breakeven_price
  from base b
  left join public.jimscanner_coupang_category_commission cc on cc.display_category_code = b.category_code
)
select c.source, c.goods_no, c.title, c.brand, c.thumb_url, c.detail_url,
       c.supply_price, c.list_price, c.ship_fee, c.ship_basis, c.msp, c.tiered_msp,
       c.status, c.is_active, c.supports_coupang, c.coupang_target, c.note, c.updated_at,
       c.real_cost, c.breakeven_price::int as breakeven_price,
       c.category_code, c.fee_rate, c.fee_category,
       -- MSP 판매 시 마진
       case when coalesce(c.msp,0) > 0 then round(c.msp * c.fee_rate)::int end                     as msp_fee,
       case when coalesce(c.msp,0) > 0 then greatest(0, round((c.msp - c.real_cost) / 11.0))::int end as msp_vat,
       case when coalesce(c.msp,0) > 0
            then (c.msp - c.real_cost - round(c.msp * c.fee_rate) - greatest(0, round((c.msp - c.real_cost) / 11.0)))::int
       end                                                                                     as msp_margin,
       case when coalesce(c.msp,0) > 0
            then round(((c.msp - c.real_cost - round(c.msp * c.fee_rate) - greatest(0, round((c.msp - c.real_cost) / 11.0))) / c.msp::numeric) * 100, 1)
       end                                                                                     as msp_margin_pct,
       -- MSP가 공급가보다 낮음 = 수집 파싱 오류 의심(유픽 'MSP 900원' 등) — 화면에 ⚠ 표시
       (coalesce(c.msp,0) > 0 and c.msp < c.supply_price) as msp_suspicious,
       -- 쿠팡 등록 현황 (같은 상품에 여러 행이 있으면 SKIPPED 아닌 최신 건을 대표로)
       l.id                as listing_id,
       l.seller_product_id as seller_product_id,
       l.status            as listing_status,
       l.list_price_krw    as listed_price,
       (l.id is not null)  as is_registered
from calc c
left join lateral (
  select li.id, li.seller_product_id, li.status, li.list_price_krw
  from public.jimscanner_coupang_listings li
  where li.source = c.source and li.source_goods_no = c.goods_no
  order by (li.status = 'SKIPPED'), li.created_at desc
  limit 1
) l on true;

comment on view public.jimscanner_purchase_catalog is
  '매입처 5곳(ggsan/upickb2b/bio77/beseller/wellroot) 상품을 정규화한 통합 카탈로그 + MSP 판매 시 마진 + 쿠팡 등록 현황. /admin/purchase-catalog 전용.';

-- 뷰는 소유자 권한으로 동작해 하위 테이블 RLS를 우회하므로 service_role(어드민 API) 외에는 접근 차단
revoke all on public.jimscanner_purchase_catalog from anon, authenticated;

-- ── 일괄 쿠팡 등록 큐 ────────────────────────────────────────────
--   웹(모바일 포함)에서 체크 → QUEUED insert → 집 PC 로컬 러너(scripts/register-agent.mjs)가 폴링해 실제 등록
create table if not exists public.jimscanner_register_jobs (
  id                uuid primary key default gen_random_uuid(),
  source            text not null,
  goods_no          text not null,
  status            text not null default 'QUEUED',   -- QUEUED|RUNNING|DONE|FAILED|CANCELED
  requested_by      text,
  requested_at      timestamptz not null default now(),
  started_at        timestamptz,
  finished_at       timestamptz,
  attempts          integer not null default 0,
  seller_product_id bigint,
  listing_id        uuid,
  error             text,
  log               text,
  constraint jimscanner_register_jobs_status_check
    check (status in ('QUEUED','RUNNING','DONE','FAILED','CANCELED'))
);

-- 같은 상품이 대기/실행 중에 중복 적재되지 않도록
create unique index if not exists jimscanner_register_jobs_pending_uniq
  on public.jimscanner_register_jobs (source, goods_no)
  where status in ('QUEUED','RUNNING');
create index if not exists jimscanner_register_jobs_status_idx
  on public.jimscanner_register_jobs (status, requested_at);

alter table public.jimscanner_register_jobs enable row level security;
