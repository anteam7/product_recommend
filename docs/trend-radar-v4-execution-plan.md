# 트렌드 레이더 v4 — 실행 계획서 (v2, 위탁 판매 상품 발굴 도구)

> 작성일: 2026-05-08 (v2 재작성)
> 입력 자료:
> - `../JimScanner_Trend_Radar_v4_Full_Architecture.md` (786줄, 비전)
> - `./trend-radar-upgrade-design.md` (343줄, 5축 분류 설계)
> - `./trend-radar-v4-poc-results.md` (PoC 7개 소스 결과)
> - 운영 중 자산: `jimscanner_trends_*` 테이블 5종 + Naver DataLab cron 2개 (Phase A)

> **v2 변경 이유 (v1 폐기):** v1 은 "운영자가 짐스캐너 콘텐츠 발굴에 쓰는 보조 인사이트 도구" 로 위치시켜 mock 점수 / 차단 사이트 보류 / Vercel cron 한도 안에 들어가는 *축소된 v4* 였음. 사용자의 실제 목적은 **별도로 운영하는 온라인 몰의 위탁 판매 상품 발굴** — v4 의 원래 의도(셀러용 커머스 인텔리전스) 와 일치. v1 의 보수적 가정 다수가 무효. v2 는 실제 사용 사례에 맞춰 재설계.

---

## 1. 목표 재정의

**한 줄:** 사용자가 운영하는 별도 온라인 몰에서 **위탁 판매할 상품을 자동 발굴** 하기 위한 트렌드·공급망·경쟁·마진 인텔리전스 도구.

**대상 카테고리 (1차):**
1. **건강식품** — 영양제·프로바이오틱스·다이어트·홍삼 등
2. **생활/리빙** — 수납·청소·욕실·주방·차량용품
3. **디지털/가전 액세서리** — 충전기·케이블·조명·스마트홈 소품

**의사결정 흐름:**
```
트렌드 발견 (어디가 뜨고 있는가)
  ↓
공급 가능성 확인 (도매에서 받을 수 있나, MOQ·리드타임)
  ↓
경쟁 강도 (이미 포화 상태인가)
  ↓
마진 추정 (도매가 vs 판매가)
  ↓
위탁 결정 / 보류 / 모니터링
```

이 4점수가 **실데이터로** 산출돼야 의미. mock 으로는 위탁 판매 의사결정 불가능.

---

## 2. 결정 8개

v1 의 D1~D4 유지 + D5 (어드민 한정) 보존 + D6~D8 신규.

| # | 결정 항목 | 선택 | v1 → v2 변경점 |
|---|----------|------|--------------|
| D1 | DB 통합 정책 | `jimscanner_trends_*` 로 점진 흡수 | 동일. Supabase 그대로 사용 |
| D2 | 점수 전략 | **모든 점수 실데이터 (mock 폐기)** | v1: trend 만 실관, 나머지 mock → v2: **4점수 모두 실관**. 위탁 판매 결정에 mock 무용 |
| D3 | MVP 범위 | **B-1 + B-3 전체 (4점수 실관 포함)** | v1: trend_score 만 → v2: 위탁 결정에 필요한 최소 = 4점수 모두. ~6주 |
| D4 | Worker 인프라 | **로컬 WSL Ubuntu + cron/systemd-timer + Playwright** | v1: Vercel cron + Postgres queue → v2: **로컬 실행, Supabase 는 적재만**. Vercel cron 한도 이슈 사라짐 |
| D5 | 노출 범위 | 운영자 전용 어드민 한정 (`/admin/trend-radar`) | 유지. 짐스캐너 본업 노출 0 |
| **D6** | **코드 위치** | **짐스캐너 코드베이스 안 (`jimpass-agent-platform/src/app/admin/trend-radar/*`)** | v2 신규. 별도 프로젝트 분리 안 함 — Supabase·UI 자산 재사용 |
| **D7** | **수집/적재 분리** | **수집은 로컬 WSL, 적재는 Supabase, UI 는 Vercel** | v2 신규. 짐스캐너 어드민에서 읽기만. 로컬에서 service-role key 로 INSERT |
| **D8** | **차단 사이트 정책** | **Playwright 우회 적극 활용 (쿠팡·1688·테무·도매·알리 모두 채택 검토)** | v1: 회피 비용 비합리적이라 보류 → v2: 위탁 판매 ROI 가 회피 비용 정당화 |

> **D6 의 의미:** UI 만 짐스캐너 어드민 안. Supabase RLS 로 운영자 본인만 접근. 본업 라우트·SEO·트래픽 영향 0 (D5 유지). 다만 **빌드/배포는 짐스캐너와 함께** — 로컬 빌드 망가지지 않도록 trend-radar 모듈은 본업과 *데이터·코드 의존성 최소화*.

> **D7 의 의미:** Vercel 함수에서 차단 사이트 호출 ❌ (IP 차단·Playwright 비용·콜드스타트). 대신 본인 PC WSL Ubuntu 에서 cron job 으로 수집 → Supabase service-role key 로 직접 INSERT → 짐스캐너 Vercel 어드민이 Supabase 에서 읽음. 짐스캐너 본업 인프라는 그대로 유지.

---

## 3. 카테고리별 소스 매트릭스

3개 카테고리 × 소스별 가용성. PoC 결과(`./trend-radar-v4-poc-results.md`) + Playwright 우회 가능성 반영.

### 3.1 건강식품

| 소스 | 가용성 | 수집 방식 | 가치 |
|------|------|---------|------|
| 네이버 쇼핑 인기검색어 (cid=50000008 생활/건강) | ✅ | DataLab `getCategoryKeywordRank.naver` AJAX (PoC 검증) | 트렌드 시그널 |
| 네이버 DataLab 카테고리 ratio | ✅ | 공식 API (이미 운영 중) | 시계열 |
| iHerb 베스트셀러 | ⚠️ 검증 필요 | HTTP fetch 또는 Playwright | 해외 소싱 후보 |
| 쿠팡 베스트 (건강식품) | ⚠️ Playwright | headless + 회전 IP | 국내 경쟁 분석 |
| 11번가 베스트 (건강식품) | ⚠️ Playwright | headless | 국내 경쟁 분석 |
| 도매꾹 (식품 카테고리) | ✅ | HTTP fetch (EUC-KR 인코딩 주의) | 위탁 공급원 |
| 오너클랜 (식품) | ⚠️ Playwright | JS-only, headless 필요 | 위탁 공급원 |
| 알리/1688 (영양제·다이어트 보조제) | ⚠️ Playwright | 1688 은 중국어 자동번역 후 수집 | 해외 소싱 |

### 3.2 생활/리빙

| 소스 | 가용성 | 수집 방식 | 가치 |
|------|------|---------|------|
| 네이버 쇼핑 인기검색어 (cid=50000004 가구/인테리어, 50000008 생활/건강, 50000009 여가/생활편의) | ✅ | DataLab AJAX | 트렌드 |
| 네이버 DataLab ratio | ✅ | 공식 | 시계열 |
| 다이소몰 베스트 | ⚠️ Playwright | 강한 봇 차단, headless 필수 | 한국 생활 트렌드 핵심 |
| 오늘의집 인기 | ⚠️ Playwright | SPA, headless | 리빙 트렌드 |
| 쿠팡 베스트 (생활용품·주방용품) | ⚠️ Playwright | headless | 국내 경쟁 |
| 도매꾹 (생활/주방) | ✅ | HTTP fetch | 위탁 공급원 |
| 알리/1688 (생활용품) | ⚠️ Playwright | 1688 핵심 — 중국 도매 | 해외 소싱 |
| Reddit r/BuyItForLife / r/lifehacks | ✅ | JSON API | 글로벌 시그널 |

### 3.3 디지털/가전 액세서리

| 소스 | 가용성 | 수집 방식 | 가치 |
|------|------|---------|------|
| 네이버 쇼핑 인기검색어 (cid=50000003 디지털/가전) | ✅ | DataLab AJAX (PoC: 냉장고·선풍기·노트북·제습기·공기청정기) | 트렌드 |
| 네이버 DataLab ratio | ✅ | 공식 | 시계열 |
| 쿠팡 베스트 (디지털·가전) | ⚠️ Playwright | headless | 국내 경쟁 |
| 알리익스프레스 best | ✅ | HTTP fetch (PoC: SSR 데이터 OK) | 해외 소싱 |
| 1688 (중국 도매 액세서리) | ⚠️ Playwright | 핵심 — 중국 도매 1순위 | 해외 소싱 핵심 |
| 테무 베스트 | ⚠️ Playwright | headless | 글로벌 가격 비교 |
| YouTube 쇼츠 트렌딩 (가전 리뷰) | ✅ | YouTube Data API (키 발급 후) | 바이럴 시그널 |
| Reddit r/gadgets, r/BudgetAudiophile | ✅ | JSON API | 해외 시그널 |

### 3.4 모든 카테고리 공통

- **GSC** (jimscanner 유입 검색어) — 직접 본업 시그널, 본 도구에는 *우선순위 낮음*. (셀러 도구와 본업 데이터는 분리 유지)
- **Hermes Agent** (WSL 안 설치 완료) — 1688 중국어 페이지 분석, 상품명 한국어 변환, 카테고리 자동 분류 등 LLM 작업에 활용 가능

---

## 4. 인프라 아키텍처 (D4 + D7 구체화)

```text
┌────────────────────────────────────────────────────────────┐
│                  로컬 PC (Windows 11)                       │
│                                                            │
│  ┌────────────────────────────────────────────────────┐   │
│  │            WSL Ubuntu 26.04 (anteam7)              │   │
│  │                                                    │   │
│  │  cron / systemd-timer (KST 03:00, 06:00, 21:00)   │   │
│  │   ├─ collect-naver-shopping-hot.ts (HTTP)         │   │
│  │   ├─ collect-coupang-best.ts (Playwright)         │   │
│  │   ├─ collect-1688-best.ts (Playwright + 번역)     │   │
│  │   ├─ collect-domeggook.ts (HTTP, EUC-KR)          │   │
│  │   ├─ collect-aliex-best.ts (HTTP)                 │   │
│  │   ├─ collect-musinsa-best.ts (HTTP)               │   │
│  │   ├─ collect-reddit-products.ts (JSON)            │   │
│  │   └─ recompute-scores.ts (4점수 일 1회 재계산)    │   │
│  │                                                    │   │
│  │  결과 → Supabase service-role INSERT              │   │
│  │  Hermes Agent (~/.hermes) — LLM 분류·번역 호출    │   │
│  └────────────────────────────────────────────────────┘   │
└────────────────────────────────────────────────────────────┘
                          │
                          ↓ (HTTPS, service_role key)
┌────────────────────────────────────────────────────────────┐
│                  Supabase (서울)                            │
│                                                            │
│  jimscanner_trends_raw          (수집 원천)                │
│  jimscanner_trends_keywords     (정규화 키워드, 시계열)    │
│  jimscanner_trends_products     (canonical 상품, 신규)     │
│  jimscanner_trends_aliases      (별칭 → canonical, 신규)   │
│  jimscanner_trends_scores       (4점수 + final, 신규)      │
│  jimscanner_trends_supplier     (도매 공급원 데이터, 신규) │
│  jimscanner_trends_runs         (cron 감사)                │
│  jimscanner_trends_pins         (운영자 핀)                │
│  RLS: anon 접근 ❌, service_role + admin 본인만 ✅         │
└────────────────────────────────────────────────────────────┘
                          │
                          ↓ (Supabase JS, RLS)
┌────────────────────────────────────────────────────────────┐
│         짐스캐너 어드민 (Vercel — UI 만)                    │
│                                                            │
│  /admin/trend-radar                                        │
│   ├─ /                  대시보드 (KPI + Top 50)            │
│   ├─ /products/[id]     상품 디테일 + 4점수 + supplier     │
│   ├─ /opportunity       Opportunity Matrix (X=경쟁, Y=트렌드)│
│   ├─ /pins              핀한 상품 워크보드                 │
│   └─ /sources           cron 감사 + 마지막 수집 시각       │
└────────────────────────────────────────────────────────────┘
```

**핵심 설계 원칙:**
1. **Vercel 함수에서 외부 사이트 직접 호출 ❌** — 모든 수집은 로컬 WSL
2. **로컬 ↔ Supabase 통신은 service_role key** — `.env.local` 의 `SUPABASE_SERVICE_ROLE_KEY`
3. **어드민 UI 는 안전한 RLS 통과** — service_role 또는 admin 본인 세션
4. **로컬 PC 가 꺼져 있어도 어드민 UI 는 정상 작동** — 마지막 수집 시각만 오래되어 보임 (`/sources` 페이지에서 확인 가능)

---

## 5. 4점수 실관 — 데이터 출처 매핑

v1 에서 mock 으로 두었던 부분을 *각 점수의 컴포넌트별 실데이터 출처* 로 정의. 이게 실행 계획의 핵심.

### 5.1 trend_score (0~100)
```
trend_score = velocity × 0.35 + source_consensus × 0.25 + persistence × 0.20 + search_growth × 0.20
```

| 컴포넌트 | 데이터 출처 | 산출 |
|---------|----------|------|
| velocity | `trends_keywords` 7일 vs 직전 7일 | `(avg_last7 / avg_prev7 - 1) * 100`, clamp 0~100 |
| source_consensus | 같은 키워드가 몇 개 소스에 나타나는가 | `unique source 수 / 8 * 100` (8 = 최대 소스 수) |
| persistence | 첫 등장 후 누적 일수 + 변동성 | `min(days_since_first / 30, 1) * 100 - stddev_normalized` |
| search_growth | Naver DataLab volume_relative 30일 추세 | 회귀 기울기 normalize |

### 5.2 commerce_score (0~100)
```
commerce_score = purchase_intent × 0.25 + problem_solving × 0.20 + repeat × 0.15 + supplier_avail × 0.15 + margin × 0.15 - saturation × 0.10
```

| 컴포넌트 | 데이터 출처 | 산출 |
|---------|----------|------|
| purchase_intent | LLM 분류 (Hermes Agent 또는 OpenRouter) — informational/commercial/transactional | transactional=100, commercial=70, informational=20 |
| problem_solving | LLM — "이 키워드는 어떤 문제를 해결?" 분류 + 강도 | 0~100 |
| repeat | 카테고리별 휴리스틱 (영양제 90, 생활용품 60, 가전 30) | 시드 룰 + LLM 보강 |
| supplier_availability | 도매꾹/오너클랜/1688 검색 결과 수 | `match_count / 100 * 100` clamp |
| margin | (예상 판매가 - 도매가) / 판매가. 판매가 = 쿠팡 평균, 도매가 = 도매꾹/1688 최저 | 정수 % |
| saturation | 쿠팡 검색 결과 수 + 평균 리뷰 수 | log scale, 높을수록 감점 |

### 5.3 supplier_score (0~100)
```
supplier_score = supplier_count × 0.20 + stable_inventory × 0.20 + low_moq × 0.15 + domestic_shipping × 0.20 + easy_fulfillment × 0.15 - return_risk × 0.10
```

| 컴포넌트 | 데이터 출처 | 산출 |
|---------|----------|------|
| supplier_count | 도매꾹/오너클랜/1688 결과 합산 | `min(count, 50) / 50 * 100` |
| stable_inventory | 7일 연속 검색 시 수량 변동률 | 변동 적을수록 100 |
| low_moq | 도매꾹·오너클랜 MOQ 파싱 (1~5개) | MOQ ≤ 1: 100, MOQ ≤ 10: 70 |
| domestic_shipping | 국내 도매(도매꾹/오너클랜) 비중 | `domestic_count / total * 100` |
| easy_fulfillment | 카테고리별 휴리스틱 (식품 50, 생활 80, 가전 70) | 시드 |
| return_risk | LLM — "반품 위험 키워드" (사이즈·전자·화장품 등) | 0~100 |

### 5.4 competition_score (0~100)
```
competition_advantage = low_competition + high_margin + low_review_saturation + fast_trend_growth
```

| 컴포넌트 | 데이터 출처 | 산출 |
|---------|----------|------|
| low_competition | 쿠팡 검색 결과 수의 역수 | `100 - log(count) / log(10000) * 100` |
| high_margin | 위 commerce.margin 재사용 | 그대로 |
| low_review_saturation | 쿠팡 평균 리뷰 수의 역수 | `100 - log(avg_reviews) / log(1000) * 100` |
| fast_trend_growth | 위 trend.velocity 재사용 | 그대로 |

### 5.5 product_final_score
```
product_final_score = trend × 0.30 + commerce × 0.30 + supplier × 0.20 + competition × 0.20
```

이 점수가 **위탁 판매 우선순위 정렬 기준**. 60+ 면 후보, 75+ 면 적극 검토, 85+ 면 즉시 들어갈 만한 상품.

---

## 6. MVP 정의 (B-1 + B-3 전체)

**완료 정의:** 운영자가 `/admin/trend-radar` 진입 → 카테고리(건강식품/생활리빙/디지털가전) 별 **product_final_score 75+ 상품 TOP 20** + 4점수 breakdown + 도매 공급원 링크 + 핀 가능. 데이터는 *로컬 WSL cron 일 1회 적재* + 어드민에서 *Supabase 읽기만*.

### 6.1 MVP 에 들어가는 것
| 영역 | 항목 |
|------|------|
| 수집 | 카테고리별 12개 소스 모두 (Playwright 우회 포함) |
| 정규화 | Canonical 상품 + Alias 시스템 (`trends_aliases`) |
| 점수 | 4점수 모두 실데이터 산출 |
| LLM | Hermes Agent 또는 OpenRouter 통한 분류 (intent / problem-solving / return_risk) + 1688 중국어 번역 |
| DB | `trends_*` 8개 테이블 |
| 인프라 | WSL cron + systemd-timer 셋업 + Supabase service_role 적재 |
| UI | `/admin/trend-radar` 5개 페이지 (대시보드 / 상품 디테일 / Opportunity Matrix / 핀 / 소스 감사) |
| 안전 | RLS 정책, .env.local 분리, 로컬 PC 가 꺼져 있어도 UI 정상 |

### 6.2 MVP 밖 (다음 phase)
- Keyword Graph / Product Graph / Problem-Solution Graph (Phase B-2)
- Hysteresis lifecycle 자동 산출 (Phase B-2)
- 글감 큐 자동 생성 (짐스캐너 본업 SEO 와 분리 — 별도 검토)
- 자동 위탁 발주 / 알림 / 매출 추적 (Phase B-4)
- 본업 GSC 데이터 융합 (Phase B-4)

---

## 7. Phase 분해 (PR 단위, 6주)

### PR-1: DB 스키마 + Supabase service_role 적재 파이프라인 (1주)
- [ ] DDL: `trends_products`, `trends_aliases`, `trends_scores`, `trends_supplier` 4개 신규 테이블
- [ ] RLS 정책: anon ❌, service_role ✅, admin 본인 SELECT ✅
- [ ] WSL 안에 `/home/anteam7/jimscanner-collector/` 프로젝트 (TypeScript + tsx) 셋업
- [ ] Supabase client (service_role) 통신 모듈
- [ ] 기존 `jimscanner_trends_raw` / `_keywords` / `_runs` / `_seeds` / `_pins` 와 충돌 없음 확인
- [ ] 헬스체크 cron (`heartbeat.ts`) — 매시간 Supabase ping → `/sources` 페이지에 표시

### PR-2: 수집기 8종 + 카테고리 시드 확장 (2주)
- [ ] `collect-naver-shopping-hot.ts` — `getCategoryKeywordRank.naver` (cid=50000003,50000004,50000008,50000009)
- [ ] `collect-domeggook.ts` — HTTP fetch + EUC-KR `iconv -c`
- [ ] `collect-aliex-best.ts` — HTTP fetch + SSR 데이터 추출
- [ ] `collect-musinsa-best.ts` — HTTP fetch + Next.js SSR 추출
- [ ] `collect-reddit-products.ts` — JSON API (r/Korea_Direct, r/BuyItForLife, r/gadgets)
- [ ] `collect-coupang-best.ts` — Playwright headless (3 카테고리)
- [ ] `collect-1688-best.ts` — Playwright headless + Hermes 중국어 번역
- [ ] `collect-ownerclan.ts` — Playwright (식품/생활)
- [ ] systemd-timer 또는 cron 설정 (KST 03~06시 사이 분산)
- [ ] `trends_seeds` 카테고리 확장 (20개+ 키워드 그룹)

### PR-3: Canonical / Alias / 4점수 산출 (1.5주)
- [ ] `src/lib/scoring/` (로컬 프로젝트 안)
  - `compute-trend-score.ts` (velocity, source_consensus, persistence, search_growth)
  - `compute-commerce-score.ts` (purchase_intent[LLM], problem_solving[LLM], repeat, supplier_availability, margin, saturation)
  - `compute-supplier-score.ts` (supplier_count, stable_inventory, low_moq, domestic_shipping, easy_fulfillment, return_risk[LLM])
  - `compute-competition-score.ts` (low_competition, high_margin, low_review_saturation, fast_trend_growth)
  - `compute-final-score.ts` (가중합)
- [ ] LLM 분류 모듈 — OpenRouter 통한 GPT-4 mini 또는 Claude Haiku batch (intent / problem-solving / return_risk)
- [ ] Alias 시스템 — 키워드 → canonical_product_id 매핑 (LLM 도움)
- [ ] `recompute-scores.ts` cron (일 1회, 새벽 06시)

### PR-4: 짐스캐너 어드민 UI 5개 페이지 (1.5주)
- [ ] `/admin/trend-radar/` — 대시보드. KPI 4종 + 카테고리 탭 + Top 20 카드
- [ ] `/admin/trend-radar/products/[id]` — 상품 디테일. 4점수 breakdown + sparkline + 도매 공급원 링크 + 핀 토글
- [ ] `/admin/trend-radar/opportunity` — Opportunity Matrix (Recharts ScatterChart). X=competition, Y=trend, 크기=margin, 색=supplier
- [ ] `/admin/trend-radar/pins` — 핀한 상품 카드 그리드 + 메모 + 위탁 검토 상태 토글
- [ ] `/admin/trend-radar/sources` — cron 감사 (`trends_runs`) + 마지막 수집 시각 + 헬스체크 신호
- [ ] 메뉴 추가: 어드민 사이드바 "트렌드 레이더 PRO" 진입점 (기존 "트렌드 레이더 📈" 와 분리)

---

## 8. 위험 / 미결 사항

1. **로컬 PC 의존 — 단일 실패점** — 사용자 PC 가 꺼져 있거나 인터넷 끊기면 수집 정지. 대응: ① `/sources` 에 마지막 수집 시각 표시 ② 24h 이상 지연 시 어드민에 빨간 배너 ③ 향후 부담되면 가성비 VPS ($5/월 Lightsail) 로 이전 가능하게 코드 분리
2. **Playwright 차단 회피의 지속성** — 쿠팡·1688·테무 가 어느 시점에 더 강한 차단 도입 가능. 대응: 회전 IP·UA 풀·딜레이 조정. 막히면 *해당 소스 일시 보류*, 다른 소스로 갈음. supplier_score 등은 도매꾹/오너클랜 최소한 살아 있으면 작동.
3. **LLM 호출 비용** — 신규 키워드 분류 (intent / problem-solving / return_risk) + 1688 번역. 일 100건 × 3분류 + 50건 번역 ≈ Haiku 사용 시 월 $5~10 추정. OpenRouter 키 등록 완료. **상한 관리** — `.env.local` 의 `LLM_DAILY_BUDGET_USD` 같은 변수로 일 한도.
4. **위탁 판매 ROI 검증 시점** — 도구만 만든다고 매출 나오지 않음. MVP 출시 후 4주차에 *"이 도구로 발굴한 상품 N개 위탁 시도 → 실제 판매 M개 발생?"* 자체 평가. 미달 시 도구 자체보다 *상품 선정 기준 재검토* (점수 가중치, 카테고리 우선순위).
5. **본업(짐스캐너 Phase 1) 시간 분배** — 6주 v4 빌드 동안 본업 진척 둔화 가능성. **2주 단위 체크포인트** — 진척 못 따라가면 PR-3 또는 PR-4 일시 정지 후 본업 우선.
6. **Naver `getCategoryKeywordRank.naver` 비공식 endpoint 의존** — 막힐 가능성. 대응: ① 막히면 카테고리별 ratio (공식 API) 만으로 graceful degrade ② 페이지 스크래핑 fallback 구현 (PoC 시 페이지에서 직접 추출 가능 확인됨)
7. **데이터 신뢰성 — 1688 가격 vs 한국 도착가** — 1688 도매가는 중국 내 가격. 직구 통관·운송 비용 추가 필요. supplier.margin 컴포넌트 산출 시 *국내 도착 추정가* (1688 가격 × 1.4 등 경험 계수) 적용. 정확한 통관세는 짐스캐너 본업 모듈(`recommend simulator`) 재사용 가능.
8. **법적 책임 — 봇 차단 사이트 우회** — robots.txt 위반은 운영자 1인 책임 (D5+D8). 사이트별 약관 위반 가능성. **수집 데이터 외부 공개 ❌, 학술/연구 목적 ❌, 본인 의사결정 보조용으로만 사용** 명시.

---

## 9. 다음 즉시 액션

본 v2 계획서 확정 후 작업 순서:

1. **메모 동기화** — 사용자 자동 메모에 다음 추가/갱신:
   - `trend_radar_pipeline.md` — Phase B 진행 중 + 본 v2 문서 경로 + 별도 셀러 도구 명시
   - `external_scraping_blocklist.md` — Playwright 우회 가능 섹션 추가
   - 신규 메모 `seller_tools_context.md` — 사용자가 별도 온라인 몰 운영 + 위탁 판매 상품 발굴 도구 컨텍스트 (다음 세션에서도 헷갈리지 않게)
2. **PR-1 시작** — DDL + WSL collector 프로젝트 셋업
3. **WSL 환경 점검** — Playwright 설치 (Hermes 가 우분투 26.04 미지원으로 실패한 것 재시도 — 일반 Playwright npm install 은 가능할지 별도 검증)

---

## 10. 본 v2 가 v1 에서 폐기한 결정 (참고)

| v1 결정 | v2 변경 | 이유 |
|---------|---------|------|
| trend_score 만 실관, 나머지 mock | 4점수 모두 실관 | 위탁 판매 의사결정에 mock 무용 |
| 차단 사이트 보류 (쿠팡/도매/테무/알리) | Playwright 우회로 모두 채택 검토 | 회피 비용이 위탁 판매 ROI 로 정당화됨 |
| Vercel cron + Postgres queue | 로컬 WSL + cron + Supabase 적재 | Vercel 함수에서 차단 사이트 호출 불가, 한도 이슈 사라짐 |
| 짐스캐너 본업 SEO 글감 발굴 부수 | 위탁 판매 상품 발굴 본 목적 | 사용자의 진짜 목적 명확화 |
| 운영자 1인 ROI = "주 N회 열어봤는가" | "이 도구로 발굴한 상품 위탁 → 매출 발생?" | 셀러 도구 기준 |
| MVP 3주 (B-1 + B-3 일부) | MVP 6주 (B-1 + B-3 전체) | 4점수 실관 + Playwright 8종 수집기 |
