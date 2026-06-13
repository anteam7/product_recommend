# 방향 정의서 — 오픈마켓 셀러 자동화 도구

> 작성일: 2026-02-12 (물류 SaaS 방향) → **2026-05-29 전면 재정의 (오픈마켓 셀러 자동화)**
> 상태: 정체성 재정의 — 위탁 상품 발굴 → 쿠팡 자동 등록 → 주문·재고 운영
> 기반: 본업(짐스캐너) 분리(2026-05-11) → 쿠팡 등록 기능 성숙 → 정체성 재정의(2026-05-29)

> ⚠️ **방향 전환 안내**: 이 레포는 원래 본업(짐스캐너 배대지 비교 → 물류 SaaS)에서 robocopy로
> 복제·분리되어, 본업 기획 문서가 그대로 딸려왔습니다. 그 "배대지 비교 → 물류 SaaS" 방향은
> **별도 본업 레포에서 계속 진행되며, 이 레포에서는 폐기**합니다. 옛 문서는 `archive/`에 보존
> (`archive/platform_direction_logistics_saas.md` 등). 이 레포의 정체성은 아래 정의가 최우선입니다.

---

## 목차

1. [프로젝트 개요](#1-프로젝트-개요)
2. [핵심 파이프라인](#2-핵심-파이프라인)
3. [화면 구조 (실제 사이드바)](#3-화면-구조-실제-사이드바)
4. [쿠팡 연동](#4-쿠팡-연동)
5. [멀티마켓 확장 방향](#5-멀티마켓-확장-방향)
6. [데이터 모델](#6-데이터-모델)
7. [자동화 / 크론](#7-자동화--크론)
8. [인프라 / 분리 모델](#8-인프라--분리-모델)
9. [로드맵](#9-로드맵)
10. [본업 잔재 정리](#10-본업-잔재-정리)
11. [의사결정 로그](#11-의사결정-로그)

---

## 1. 프로젝트 개요

### 1.1 한 줄 정의

> **트렌드로 발굴한 상품을 도매처에서 소싱해 쿠팡 등 오픈마켓에 자동 등록하고,
> 재고·주문을 운영하는 1인 셀러 자동화 도구.**
> (쿠팡 우선, 멀티마켓 지향)

### 1.2 핵심 컨셉

- 운영자(1인) 본인이 별도 온라인 몰/오픈마켓에서 **위탁 판매**할 상품을 발굴·등록·운영
- "어떤 상품을 팔지"(발굴) → "어디서 떼올지"(소싱) → "어디에 올릴지"(등록) → "팔린 뒤 처리"(주문·재고)까지 **end-to-end 자동화**
- 반복적·정형적 작업(카테고리 메타 조회, 필수항목 채우기, 상태 동기화, 재고 품절 대응)은 **스크립트·크론으로 자동 처리**, 사람은 채택 판단만

### 1.3 포지셔닝

- 범용 셀러툴(셀러허브/사방넷 등)과 달리 **트렌드 발굴 → 도매 소싱 → 등록**을 하나의 파이프라인으로 묶음
- 쿠팡 Open API를 직접 호출하는 **코드/스크립트 기반** 운영 (수작업 셀러센터 입력 최소화)
- 현재는 쿠팡 단일 마켓 + ggsan 단일 도매처에 최적화. 구조는 멀티마켓·멀티 도매처로 확장 가능하게 유지

### 1.4 무엇이 아닌가 (스코프 밖)

- ❌ 배대지(배송대행) 비교 플랫폼 — **본업 레포 소관, 이 레포에서 폐기**
- ❌ 물류 SaaS / 4계층 멀티테넌트 — 본업 소관
- ❌ B2C 엔드유저 대상 서비스 — 이 도구는 **운영자 본인 전용 내부 도구** (로컬/어드민)

---

## 2. 핵심 파이프라인

```
① 발굴 (Discovery)                    ② 소싱 (Sourcing)
   트렌드 9개 소스 수집                    ggsan 도매 카탈로그(1,879건)
   (네이버 검색/쇼핑/블로그/뉴스,    →     상세·패키지·MSP 파싱
    구글 서제스트, GSC, 클리앙,            마진 계산
    퀘이사존, KCA, TV홈쇼핑 편성)
         │                                       │
         ▼                                       ▼
   기회 점수 산정 / TV↔ggsan 매칭         추천 후보 (⭐) / 핀
         │                                       │
         └───────────────┬───────────────────────┘
                         ▼
              ③ 등록 (Registration)
                 쿠팡 Open API 자동 등록
                 - 카테고리 예측 + 메타 조회
                 - 필수 고시정보·옵션·이미지 구성
                 - 가격(도매가→판매가) / 마진 계산
                 - 상태: DRAFT→TEMPORARY_SAVE→PENDING_APPROVAL→APPROVED→SELLING
                         │
                         ▼
              ④ 운영 (Operations)
                 - 재고 동기화: ggsan 품절 감지 → 쿠팡 판매중지/재개 (매시간 크론)
                 - 주문 동기화: 쿠팡 주문 수집 → 매입(ggsan 발주) 매칭 (매시간 크론)
                 - 이름/키워드 부스트, 필수항목 보정, 가격 정정 (보정 스크립트군)
```

---

## 3. 화면 구조 (실제 사이드바)

> 정의의 단일 출처(source of truth)는 `src/app/admin/(dashboard)/AdminShell.tsx`의 NAV. 아래는 그 반영.

| 그룹 | 메뉴 | 경로 | 역할 |
|------|------|------|------|
| **개요** | 대시보드 | `/admin/trend-radar` | KPI + Top 상품 카드 |
| **위탁 발굴** | ⭐ 추천 후보 | `/admin/trend-radar/recommend` | 발굴 파이프라인 최종 채택 후보 |
| | ggsan 카탈로그 | `/admin/trend-radar/ggsan` | 도매 카탈로그(1,879건, 임박특가) |
| | TV ↔ ggsan 매칭 | `/admin/trend-radar/tv-ggsan-match` | 홈쇼핑 편성 ↔ 도매 상품 매칭 |
| | 기회 점수 | `/admin/trend-radar/opportunity` | 수요·경쟁 기반 기회 점수 |
| | TV 편성표 | `/admin/trend-radar/tv-pushes` | 홈쇼핑 9사 통합 편성 키워드 |
| | 수집 상태 | `/admin/trend-radar/sources` | 수집 크론 헬스 |
| | 핀 (채택 후보) | `/admin/trend-radar/pins` | 수동 핀 |
| **쿠팡 자동등록** | 등록 상품 관리 | `/admin/coupang-publish` | 등록 상품 상태·가격·노출·마진 관리 |
| | 주문 ↔ 매입 | `/admin/coupang-orders` | 쿠팡 주문 ↔ ggsan 발주 매칭 |
| **메타** | 개선 제안 | `/admin/improvement-ideas` | 기능 백로그 |

> 사이드바에 없는 라우트(rates, forwarders, blog, content, deals, analytics, search-console 등)는
> 전부 본업 잔재로 **숨김 처리**됨. [10. 본업 잔재 정리](#10-본업-잔재-정리) 참조.

---

## 4. 쿠팡 연동

### 4.1 인증

- HMAC-SHA256 서명. 환경변수 `COUPANG_ACCESS_KEY` + `COUPANG_SECRET_KEY`
- 헤더: `Authorization: CEA algorithm=HmacSHA256, access-key=..., signed-date=..., signature=...`

### 4.2 호출하는 Open API 작업

| 작업 | 엔드포인트(요지) | 용도 |
|------|------------------|------|
| 카테고리 예측 | predicted-category | 상품명 → 카테고리 자동 추론 |
| 카테고리 메타 | `.../meta/category-related-metas/display-category-codes/{code}` | 필수속성·고시정보·옵션 메타 |
| 상품 등록 | `POST .../marketplace/products` | 신규 상품 등록 |
| 상품 수정 | 상품 PATCH / vendor-item PUT | 속성·가격·이름·재고 정정 |
| 재고/판매 제어 | vendor-items 가격/수량 API | 품절 시 판매중지, 재입고 시 재개 |
| 주문 조회 | `GET .../v4/vendors/{vendorId}/ordersheets` | 최근 주문 수집 |

### 4.3 등록 상태 머신

```
DRAFT → TEMPORARY_SAVE → PENDING_APPROVAL → APPROVED → SELLING ⇄ STOPPED
                                          ↘ REJECTED        (재고 0 시 STOPPED)
                                          ↘ FAILED / SKIPPED
```

상태/가격/노출/마진은 `jimscanner_coupang_listings`에 기록.

---

## 5. 멀티마켓 확장 방향

- 현재 구현은 **쿠팡 단일**. 다만 정체성은 "오픈마켓 셀러 자동화"이므로 네이버 스마트스토어/11번가 등으로 확장 가능하게 본다.
- 확장 시 분리 지점:
  - 마켓별 인증/서명 어댑터 (쿠팡 HMAC ↔ 네이버 OAuth 등)
  - 마켓별 카테고리 매핑 / 필수항목 스키마
  - 공통 도메인: 발굴·소싱·마진 계산·재고 소스(ggsan)는 마켓 무관하게 재사용
- **확장은 쿠팡 운영이 안정화된 뒤** 진행. 지금은 쿠팡 깊이 우선.

---

## 6. 데이터 모델

> Supabase(`obxvucyhzlakensopalf`)는 본업과 **공유**. 이 도구가 직접 접근. 상세는 `docs/database.md`.

| 도메인 | 주요 테이블 |
|--------|-------------|
| 쿠팡 | `jimscanner_coupang_listings`(등록 상품), `jimscanner_coupang_orders`(주문), `jimscanner_coupang_stock_sync_runs`(재고 동기화 로그) |
| 발굴(트렌드) | `jimscanner_trends_keywords`, `jimscanner_trends_pins`, `jimscanner_trends_runs` |
| 소싱(ggsan) | ggsan 카탈로그 테이블 3종 + `jimscanner_tv_ggsan_match` RPC (본업 DB 공유) |
| (본업 잔재) | forwarders / shipping_rates / centers / 환율 / 블로그 등 — 이 도구에서 미사용 |

---

## 7. 자동화 / 크론

| 크론 | 주기 | 역할 |
|------|------|------|
| `cron/coupang-stock-sync` | 매시간 | ggsan 재고 조회 → 품절 시 쿠팡 판매중지, 재입고 시 재개 |
| `cron/coupang-orders-sync` | 매시간 | 최근 24h 쿠팡 주문 수집 → `jimscanner_coupang_orders` UPSERT |
| `cron/collect-*` (트렌드 9종) | 주기 수집 | 네이버/구글/GSC/클리앙/퀘이사존/KCA/TV편성 등 시그널 수집 |

> ⚠️ Vercel Hobby 한도로 쿠팡 크론은 Vercel에서 제거되고 **로컬 스케줄러(`scripts/run-crons.mjs`)로 우회** 중.
> 트렌드 수집 일부는 WSL collector(`/home/anteam7/jimscanner-collector/`)가 본업 DB에 적재(공유).

### 7.1 운영 스크립트 (scripts/)

| 분류 | 대표 스크립트 |
|------|---------------|
| 등록 | `coupang-register-batch-v2.mjs`, `coupang-register-one.mjs`, `coupang-request-approval-2.mjs` |
| 재고/수량 | `coupang-bulk-set-quantity.mjs`, `coupang-fix-zero-stock.mjs`, `coupang-resume-all.mjs`, `coupang-sync-listings.mjs` |
| 속성/필수항목 보정 | `coupang-bulk-fill-attrs.mjs`, `coupang-fix-mandatory.mjs`, `coupang-fix-itemname.mjs`, `coupang-fix-original-price.mjs`, `coupang-fix-temporary-save.mjs` |
| 이름/키워드 부스트 | `coupang-rename-keyword-boost.mjs`, `coupang-rename-b-boost.mjs`, `coupang-update-name-full.mjs` |
| 카테고리 메타 | `coupang-category-meta.mjs`, `coupang-category-batch.mjs`, `coupang-restore-category-and-discount.mjs` |
| 진단 | `coupang-diagnose-status.mjs`, `coupang-diagnose-mandatory.mjs`, `coupang-ggsan-diff-diagnose.mjs`, `coupang-api-test.mjs` |
| 소싱(ggsan) | `ggsan-detail-*.mjs`, `ggsan-extract-package-info.mjs`, `ggsan-msp-*.mjs`, `ggsan-price-check.mjs` |

---

## 8. 인프라 / 분리 모델

- **본업 분리(2026-05-11, 옵션 A)**: UI·의사결정 도메인·라우트 노출만 분리, 데이터·인프라는 공유. 상세 `SEPARATION_NOTES.md`.
- **공유**: Supabase 프로젝트(`obxvucyhzlakensopalf`), ggsan 테이블·RPC, WSL collector
- **분리**: 어드민 UI/사이드바, 위탁 vs 직구 의사결정 도메인
- 배포: Vercel `product-recommend-nine.vercel.app` / 리포 `github.com/anteam7/product_recommend`
- 로컬 dev: `npm run dev` (포트 3001, 본업 3000과 충돌 회피)

---

## 9. 로드맵

| 단계 | 목표 | 상태 |
|------|------|------|
| **발굴 파이프라인** | 트렌드 9종 + ggsan + TV매칭 + 기회점수 | ✅ 가동 |
| **쿠팡 등록** | 배치/단건 등록, 카테고리 메타, 필수항목 자동 | ✅ 가동 (보정 스크립트 다수) |
| **쿠팡 운영** | 재고 동기화 ✅ / 주문 동기화 (스켈레톤 → 매입 매칭 고도화) | 🚧 진행 |
| **이름/가격 최적화** | 키워드 부스트, 마진 정정 | 🚧 진행 |
| **멀티마켓** | 네이버/11번가 등 어댑터 | ⏳ 쿠팡 안정화 후 |
| **본업 잔재 제거** | 숨김 라우트·스크립트 단계적 삭제 | ⏳ 점진 |

---

## 10. 본업 잔재 정리

robocopy 복제로 본업 코드가 그대로 존재. 사이드바에서만 숨김. 무해하므로 점진 제거.

| 잔존 라우트 | 본업 용도 | 처리 |
|-------------|-----------|------|
| `src/app/(b2c)/**` | 짐스캐너 메인(배대지 비교) | URL 직접 입력 안 하면 무해, 그대로 둠 |
| `admin/rates|services|rate-fetcher|rate-checks|exchange-rates` | 배대지 요금 관리 | 사이드바 미노출 |
| `admin/content|blog|deals` | 콘텐츠/세일 | 사이드바 미노출 |
| `admin/reports|review-collection|forwarder-reviews` | 신고·후기 | 사이드바 미노출 |
| `admin/trends|market-signals|manifest|search-console|analytics` | 본업 인사이트 | 사이드바 미노출 |

**점진 제거 가이드**: 본 도구 안정화 후 폴더 단위 삭제 → `npm run build` 통과 확인 → `src/lib/` 본업 전용 모듈 제거. 단, **DB 객체는 공유 모델이므로 제거 금지**.

---

## 11. 의사결정 로그

| 일자 | 결정 | 이유 |
|------|------|------|
| 2026-05-11 | 본업에서 옵션 A 분리 | 위탁 판매 발굴 도구를 본업 배대지 사업과 도메인 분리 |
| 2026-05-(이후) | ggsan 소싱 + 쿠팡 자동 등록 기능 구축 | 발굴 → 등록 → 운영 end-to-end 자동화 |
| 2026-05-29 | **정체성 재정의: 오픈마켓 셀러 자동화 도구** | 실제 코드(쿠팡 등록·주문·발굴)와 문서 정합. 배대지/물류 SaaS 방향은 본업 소관으로 폐기 |
| 2026-05-29 | 배대지·물류 SaaS 기획 문서 `archive/` 이동 | 본업 소관, 이 레포 정체성과 무관 |
| 2026-05-29 | 멀티마켓은 쿠팡 안정화 후 확장 | 지금은 쿠팡 깊이 우선 |

---

> **최우선 원칙**: 방향 충돌 시 본 문서가 최우선. 옛 물류 SaaS 문서(`archive/`)는 참고용 히스토리일 뿐 실행 방향이 아니다.
