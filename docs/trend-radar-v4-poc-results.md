# 트렌드 레이더 v4 — Tier 1 소스 PoC 결과

> 검증일: 2026-05-08
> 검증 환경: Vercel cron 환경 시뮬레이션 (Node fetch / curl, realistic UA `Chrome/124`, Accept-Language `ko-KR`)
> 검증 범위: v4 §5.2 Tier 1 (쿠팡·네이버쇼핑·알리·YouTube·도매·Reddit) + 대체 후보(무신사·11번가·테무)
> 입력 문서: `./trend-radar-v4-execution-plan.md` §5

본 문서는 Phase B-1 후반 PR 의 cron 추가 결정을 위한 입력값. D5(어드민 한정) 가 대전제이므로 robots/약관 위반은 운영자 1인 책임 범위로 가정하되, **차단 회피 비용이 운영자 1인 도구 가치 대비 합리적인 소스만** 채택.

---

## 1. 종합 판정

| 소스 | 결과 | 추천 단계 | 이유 |
|------|------|----------|------|
| **Naver DataLab Top 키워드** (`getCategoryKeywordRank.naver`) | ✅ **즉시 채택** | Phase B-1 PR-3 | 인증 없이 카테고리별 Top 20 키워드 응답 (POST AJAX). 큰 발견. |
| **Reddit r/Korea_Direct** | ✅ 채택 | Phase B-1 PR-3 | HTML 페이지 200 OK (473KB). JSON endpoint 는 추가 검증 필요. 직구 본업과 정합. |
| **AliExpress 베스트** | ✅ 채택 (제한) | Phase B-1 후반 | best.aliexpress.com 200 OK, `window._dida_config_._init_data_` SSR 데이터. 단 robots 가 `/productdetail/*`, `/search/*` 차단 → 베스트 리스트만. |
| **Musinsa 베스트** | ✅ 채택 (대체) | Phase B-1 후반 | 일반 UA 허용 + Next.js SSR 데이터 embedded. v4 의 "도매" 항목 대신 "한국 패션 트렌드" 로 재포지션. |
| **Domeggook (도매꾹)** | ⚠️ 채택 가능 | Phase B-3 | robots `Allow: /` 완전 허용. 단 EUC-KR 인코딩 처리 필요(`iconv -f EUC-KR//TRANSLIT -t UTF-8`). |
| **YouTube Data API** | ⚠️ 키 발급 후 | Phase B-3 | 공식 API. 키 + 일 1만 quota 충분. 우선순위 낮음(직구 정합도 약함). |
| **Naver DataLab 검색어/쇼핑 카테고리 API** | ✅ 가동 중 | Phase A 완료 | 이미 운영 중 (`collect-naver-search-trends`, `collect-naver-shopping-trends` cron). |
| **쿠팡 베스트** | ❌ 보류 | — | 모든 경로 403. robots.txt 자체도 403. 회피 비용 비합리적. |
| **11번가 베스트** | ❌ 보류 | — | robots.txt `User-agent: * Disallow: /` 명시. 본 페이지도 0 byte. |
| **Temu 베스트** | ❌ 보류 | — | 베스트 페이지가 SPA shell (2.8KB). robots 에 ClaudeBot 명시 차단. JS 렌더링 비용 비합리적. |
| **Ownerclan (오너클랜)** | ❌ 보류 | — | 3KB 응답, 데이터 없음. JS-only 렌더링. |
| **Domemae (도매매)** | ❌ 보류 | — | DNS 실패 (HTTP 000). |

---

## 2. 상세 결과

### 2.1 Naver DataLab Top 키워드 — ✅ 큰 발견

**엔드포인트:** `POST https://datalab.naver.com/shoppingInsight/getCategoryKeywordRank.naver`

**Body (form-urlencoded):**
- `cid` — 카테고리 cid (예: `50000003` 디지털/가전)
- `timeUnit` — `date`
- `startDate`, `endDate` — `YYYY-MM-DD`
- `age`, `gender`, `device` — 빈 값 가능
- `page=1`, `count=20`

**필수 헤더:**
- `Referer: https://datalab.naver.com/shoppingInsight/sCategory.naver`
- `X-Requested-With: XMLHttpRequest`
- `Content-Type: application/x-www-form-urlencoded; charset=UTF-8`

**응답 (cid=50000003, 30일):**
```json
{
  "statusCode": 200,
  "ranks": [
    {"rank":1,"keyword":"냉장고","linkId":"냉장고"},
    {"rank":2,"keyword":"선풍기","linkId":"선풍기"},
    {"rank":3,"keyword":"노트북","linkId":"노트북"},
    {"rank":4,"keyword":"제습기","linkId":"제습기"},
    {"rank":5,"keyword":"공기청정기","linkId":"공기청정기"}
  ]
}
```

**의미:** 메모 `trend_radar_pipeline.md` 가 *"공식 API 없음 — 페이지 스크래핑 유일"* 로 적었던 항목이 사실은 **공식 페이지 내부 AJAX 로 직접 호출 가능**. 시드 11개 카테고리 × 20 = 일 220개 키워드 자동 수집.

**리스크:**
- 비공식 endpoint — Naver 가 임의로 막을 수 있음
- 약관 위반 가능성 — 운영자 1인 책임(D5)
- Rate limit 명시 없음 — 보수적으로 카테고리당 1회/일

**구현 단계:** Phase B-1 PR-3 의 `collect-naver-shopping-hot` cron 으로 신설.

---

### 2.2 Reddit r/Korea_Direct — ✅ 채택

**검증:**
- `https://www.reddit.com/r/Korea_Direct/hot.json?limit=10` — 첫 호출 시 473KB 응답
- `https://www.reddit.com/r/Korea_Direct/` (HTML) — 200 OK
- `r/koreanshoppinghaul` — children=[] (비활성, 사용 X)
- `r/Haerokorea` — 빈 응답

**채택 사유:** 활성 직구 커뮤니티 + JSON endpoint 가능(약한 OAuth 의존, 호출량 적으면 토큰 없이도 동작).

**리스크:** Reddit 이 비로그인 JSON 호출에 점진 차단 도입 중. 토큰 없으면 일 호출 수십 회로 제한. 어드민 한정 도구라 충분.

**구현 단계:** Phase B-1 PR-3 의 `collect-reddit-direct` cron (KST 04:30, 일 1회).

---

### 2.3 AliExpress 베스트 — ✅ 채택 (제한)

**검증:**
- `https://best.aliexpress.com/` — 200 OK, 140KB
- `window._dida_config_._init_data_` 에 베스트 카테고리 데이터 embedded
- robots.txt: `/productdetail/*`, `/search/*`, `/items/*` 차단. 베스트 리스트는 허용.

**채택 사유:** 직구 글감 발굴에 핵심 (해외 트렌드 → 국내 직구 글감).

**리스크:** robots 위반 가능성 낮으나 상세 페이지 호출 금지. 베스트 리스트만 추출.

**구현 단계:** Phase B-1 후반 또는 Phase B-3.

---

### 2.4 Musinsa 베스트 — ✅ 채택 (대체)

**검증:**
- `https://www.musinsa.com/main/musinsa/ranking?categoryCode=000&...` — 200 OK, 65KB
- robots.txt: `Allow: /` for 일반 UA + 검색엔진/AI bot 다 허용
- Next.js SSR 데이터 embedded — `data: {"defaultCode":"musinsa","store":[...]}`

**v4 와의 매핑:** 도매(차단 다수) 대신 **한국 패션 트렌드 소스** 로 재포지션. supplier_score 와는 무관, trend_score 의 한국 측 시그널.

**구현 단계:** Phase B-1 후반.

---

### 2.5 Domeggook (도매꾹) — ⚠️ 채택 가능, 인코딩 주의

**검증:**
- 200 OK, 673KB
- robots.txt: `User-agent: * Allow: /` (완전 허용)
- **인코딩: EUC-KR** — 일반 grep/parse 시 깨짐. `iconv -f EUC-KR -t UTF-8` 필요. 단 일부 invalid byte 가 있을 수 있어 `iconv -c -f EUC-KR -t UTF-8` (skip invalid) 권장.
- 본 PoC 에서는 변환 자체에서 사이즈 0 으로 떨어졌음 → 첫 페이지에 EUC-KR 외 바이트 혼재 추정. 추후 stream 단위 인코딩 처리 필요.

**구현 단계:** Phase B-3 (분류 엔진과 함께. 그 시점에 다국어/인코딩 핸들링 코드 일괄 정리).

---

### 2.6 YouTube Data API — ⚠️ 키 발급 후

**검증:**
- 키 없이 호출 → 403 (예상)
- 공식 API: `videos.list?part=snippet&chart=mostPopular&regionCode=KR`
- 무료 quota: 일 10,000 units, mostPopular 호출은 1 unit/call

**채택 사유 (낮은 우선순위):** 직구 정합도 약함. 글감 발굴에 보조적.

**구현 단계:** Phase B-3 이후. 키 발급 + secrets.md 등록 → cron `collect-youtube-trending-kr`.

---

### 2.7 차단된 소스 — 회피 비용 평가

| 소스 | 차단 종류 | 회피 옵션 | 운영자 1인 도구로서 ROI |
|------|----------|----------|----------------------|
| 쿠팡 베스트 | 403 (모든 경로) | Playwright + 회전 IP + 강한 헤더 위장. 또는 Coupang Partners API (제휴 가입 필수) | ❌ 비합리적. Naver 쇼핑 인기검색어 + Musinsa 로 갈음 |
| 11번가 베스트 | robots Disallow / | 11번가 API (인증 필요) | ❌ 비합리적. Naver/Musinsa 로 갈음 |
| Temu 베스트 | SPA + ClaudeBot 차단 | Playwright headless | ❌ 비합리적. JS 렌더링 비용 + Naver 가 더 한국 시장 정합 |
| Ownerclan | JS-only | Playwright headless | ❌ 도매 정보 mock 유지가 합리적 |
| Domemae | DNS 실패 | (해결 불가) | ❌ Domeggook 으로 갈음 |

**결론:** 차단 사이트 회피는 **이번 v4 1차 MVP 에서 모두 보류**. supplier_score 는 mock 유지 + 도매 정보가 필요하면 운영자가 수동 메모 (`jimscanner_trends_supplier_notes` 같은 어드민 입력 테이블 — Phase B-3 검토).

---

## 3. 본 PoC 가 §5 의 어떤 결정을 갱신했는가

| §5 의 가설 | 실제 결과 | 영향 |
|------------|----------|------|
| 쿠팡 베스트 = 차단 가능성 매우 큼 | **확정 차단** (모든 경로 403) | "무신사 / 11번가 베스트" 대안 → 11번가도 차단, **Musinsa 만 살아남음** |
| 네이버 쇼핑 인기검색어 = 페이지 스크래핑만 가능 | **POST AJAX endpoint 직접 호출 가능** (큰 발견) | Phase B-1 PR-3 구현 난이도 ↓↓. 메모 갱신 필요 |
| 알리 = 차단 가능 | 베스트 페이지 OK / 상세 차단 (robots) | 베스트 리스트 한정 채택 |
| 도매 = robots 검증 필요 | Domeggook 허용 / Domemae·Ownerclan 불가 | Domeggook 1개만 채택 (인코딩 주의) |
| YouTube = API 키 필요 | 확인 — 우선순위 낮음 | Phase B-3 이후 |
| Reddit = OAuth 필요 가능 | r/Korea_Direct 활성, JSON 직접 가능 | Phase B-1 PR-3 채택 |

---

## 4. Phase B-1 PR-3 갱신된 cron 목록

원래 §4 PR-3 = "네이버 쇼핑 인기검색어 + Dashboard 확장". 본 PoC 결과로 다음 cron 들 묶어서 PR-3 안에 흡수:

1. `collect-naver-shopping-hot` — `getCategoryKeywordRank.naver` (시드 11 카테고리 × Top 20 키워드)
2. `collect-aliexpress-best` — best.aliexpress.com SSR 데이터 추출
3. `collect-musinsa-best` — Next.js SSR 데이터 추출
4. `collect-reddit-direct` — Reddit r/Korea_Direct hot.json (직구 키워드 필터링)

> Hobby plan cron 한도 재점검: 기존 8개 + 신규 4개 = **12개**. Hobby 한도 초과 가능성 → Pro 업그레이드 필요하거나 cron 통합 필요. **Phase B-1 PR-3 시작 전 vercel.json 한도 재점검 필수**.

---

## 5. 메모 갱신 필요

PoC 결과를 사용자 메모에 반영:

1. `trend_radar_pipeline.md` — "Top 인기검색어 발견 (공식 API 없음)" 줄 → **`getCategoryKeywordRank.naver` POST AJAX 로 가능, 인증 불필요** 로 수정
2. `external_scraping_blocklist.md` — 신규 섹션 추가:
   - ✅ best.aliexpress.com (베스트 리스트만), www.musinsa.com (Allow), domeggook.com (Allow, EUC-KR 주의), reddit.com r/Korea_Direct
   - ❌ coupang.com (모든 경로 403), 11st.co.kr (robots Disallow /), temu.com (SPA + ClaudeBot 차단), ownerclan.com (JS-only), domeme.domemedb.com (DNS 실패)

---

## 6. 다음 액션

본 PoC 결과로 §5 검증 완료. **Phase B-1 PR-1 시작 가능**:
- DDL: `jimscanner_trends_scores` 테이블
- `src/lib/trends/scoring.ts` — `computeTrendScore` + 3개 mock 함수
- `recompute-trend-scores` cron
- 어드민 API `/api/admin/trends/scores`

PR-2, PR-3 는 PR-1 완료 후 순차 진행. PR-3 시작 전 Vercel cron 한도 재점검 필요(§4 끝 메모).

---

## 7. 추가 평가 — Playwright + 로컬 실행 환경 (2026-05-08, v2 계획서 반영)

`./trend-radar-v4-execution-plan.md` v2 가 *위탁 판매 셀러 도구* 로 목적 재정의되며 **차단 사이트 회피 비용이 정당화** 됨. v2 의 D8 (Playwright 우회 적극 활용) + D4 (로컬 WSL 실행) 조합으로 §1 의 "❌ 보류" 5개 중 다수가 **재채택 후보**.

### 7.1 Playwright + 로컬 WSL 환경에서의 재평가

| 소스 | §1 판정 | 재평가 (v2) | 비고 |
|------|--------|-----------|------|
| 쿠팡 베스트 | ❌ 보류 (모든 경로 403) | ⚠️ **Playwright headless + 회전 IP 로 채택** | 일 1회, 카테고리별 1 페이지. 위탁 판매에 국내 경쟁 분석 핵심 |
| 11번가 베스트 | ❌ 보류 (robots Disallow /) | ⚠️ Playwright 시도 가능하나 **우선순위 낮음** | 쿠팡으로 갈음 가능. 후순위 |
| Temu 베스트 | ❌ 보류 (SPA shell + ClaudeBot 차단) | ⚠️ **Playwright headless 채택** | 글로벌 가격 비교 시그널. 일반 Chrome UA 로 우회 |
| Ownerclan | ❌ 보류 (JS-only 3KB) | ⚠️ **Playwright headless 채택** | 식품·생활 위탁 공급원 핵심. headless 로 상품 리스트 추출 |
| Domemae | ❌ 보류 (DNS 실패) | ❌ 그대로 보류 | DNS 자체가 무효 — 회피 불가 |

### 7.2 v2 가 추가로 채택한 신규 소스

| 소스 | 가용성 | 가치 |
|------|------|------|
| **1688.com (중국 도매)** | ⚠️ Playwright + 자동번역 | 디지털 액세서리·생활용품 위탁 핵심 공급원. 본 PoC 미검증 — 로컬 환경 셋업 후 PR-2 에서 검증 |
| **다이소몰 베스트** | ⚠️ Playwright | 한국 생활/리빙 트렌드 핵심 |
| **오늘의집 인기** | ⚠️ Playwright SPA | 리빙 트렌드 보조 |
| **iHerb 베스트셀러** | ⚠️ HTTP 또는 Playwright | 건강식품 해외 소싱 |
| **YouTube Data API (가전 리뷰 쇼츠)** | ✅ 키 발급 후 | 디지털 카테고리 바이럴 시그널 |

### 7.3 v2 채택 소스 총괄 (PR-2 수집기 8종 대상)

✅ HTTP fetch (4):
- `naver_shopping_hot` (`getCategoryKeywordRank.naver`)
- `domeggook` (EUC-KR `iconv -c`)
- `aliex_best` (SSR 데이터)
- `reddit_products` (JSON, r/Korea_Direct + r/BuyItForLife + r/gadgets)

⚠️ Playwright headless (4):
- `coupang_best`
- `1688_best` (+ Hermes 중국어→한국어 번역)
- `ownerclan`
- `musinsa_best` (HTTP 도 가능하나 Playwright 통합 운영이 깔끔)

> 다이소몰 / 오늘의집 / iHerb / Temu / YouTube 는 Phase B-3 또는 B-4 추가 검토. MVP 8종 수집기 안정화 후 단계 확장.
