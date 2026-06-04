-- 기상청 중기예보 선행 수요 레이더 (weather-radar 보드)
-- 단기/중기예보(기온·강수·미세먼지 10일 전망)를 적재해 '예보 임계 돌파'를
-- 뉴스 보도보다 7~10일 선행하는 D-7 소싱 신호로 번역한다.
--
-- 적용: psql + PGPASSWORD (docs/database.md). 적용 전까지 코드는 `as any` 캐스팅으로 가정.

create table if not exists public.jimscanner_weather_forecast (
  id            bigint generated always as identity primary key,
  base_date     date not null,                 -- 예보 발표일 (발표 회차)
  forecast_date date not null,                 -- 예보가 가리키는 미래 날짜
  region        text not null,                 -- 지역(중기예보 권역 / 단기 격자 라벨)
  metric        text not null,                 -- 'tmax' | 'tmin' | 'pm10' | 'pm25' | 'rain_prob'
  value         numeric,                       -- 예보 수치 (℃, ㎍/㎥, %)
  anomaly       numeric,                       -- 평년/임계 대비 편차 (선택)
  captured_at   timestamptz not null default now(),
  -- 같은 발표회차·날짜·지역·지표는 1행 (최신 발표가 덮어씀은 dedup_key 로 base_date 분리)
  dedup_key     text generated always as
                (base_date::text || ':' || forecast_date::text || ':' || region || ':' || metric) stored,
  unique (dedup_key)
);

-- D-카운트다운/타임라인 조회용: 미래 날짜 + 지표
create index if not exists idx_weather_forecast_timeline
  on public.jimscanner_weather_forecast (forecast_date, metric);

-- 최신 발표회차만 빠르게 추리기 위한 base_date 인덱스
create index if not exists idx_weather_forecast_base
  on public.jimscanner_weather_forecast (base_date desc);

-- 14일 지난 예보는 가치 없음 — cron 끝/정리 잡에서 삭제 (선택)
--   delete from public.jimscanner_weather_forecast where forecast_date < current_date - 1;
