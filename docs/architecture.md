# 아키텍처 — 셀러 자동화 파이프라인

> 상세 원본: `platform_direction.md`
> 정체성: 트렌드 발굴 → ggsan 도매 소싱 → 쿠팡 자동 등록 → 재고·주문 운영

---

## 파이프라인 4단계

```
① 발굴 (Discovery)                    ② 소싱 (Sourcing)
   트렌드 9개 소스 수집                    ggsan 도매 카탈로그 (1,879건)
   네이버(검색/쇼핑/블로그/뉴스)     →     상세·패키지·MSP 파싱
   구글 서제스트 / GSC                     마진 계산
   클리앙 / 퀘이사존 / KCA                추천 후보(⭐) / 핀
   TV홈쇼핑 9사 편성
         │                                       │
         └───────────────┬───────────────────────┘
                         ▼
              ③ 등록 (Registration) — 쿠팡 Open API
                 카테고리 예측 → 메타 조회 → 필수 고시정보·옵션·이미지
                 → 가격(도매가→판매가)·마진 → 등록 → 승인 요청
                         │
                         ▼
              ④ 운영 (Operations)
                 재고 동기화(매시간): ggsan 품절 → 쿠팡 판매중지/재개
                 주문 동기화(매시간): 쿠팡 주문 수집 → ggsan 발주 매칭
                 최적화: 이름/키워드 부스트, 필수항목 보정, 가격 정정
```

---

## 레이어별 구성

### UI (어드민)

- `src/app/admin/(dashboard)/AdminShell.tsx` — 사이드바 NAV(정체성의 단일 출처)
- `trend-radar/**` — 발굴 화면군 (대시보드, 추천 후보, ggsan, TV매칭, 기회 점수, 편성표, 수집 상태, 핀)
- `coupang-publish/` — 등록 상품 상태·가격·노출·마진 관리
- `coupang-orders/` — 쿠팡 주문 ↔ ggsan 매입 매칭

### 백엔드 (API / 크론)

- `src/app/api/cron/coupang-stock-sync` — 재고 동기화 (매시간)
- `src/app/api/cron/coupang-orders-sync` — 주문 동기화 (매시간)
- `src/app/api/cron/collect-*` — 트렌드 수집 (네이버/구글/GSC/클리앙/퀘이사존/KCA/TV편성)

### 운영 스크립트

- `scripts/coupang-*.mjs` — 등록·재고·속성보정·이름부스트·카테고리메타·진단
- `scripts/ggsan-*.mjs` — 도매 상세/패키지/MSP/가격 소싱
- `scripts/run-crons.mjs` — 로컬 크론 스케줄러 (Vercel Hobby 한도 우회)

### 데이터 (Supabase, 본업 공유)

- 쿠팡: `jimscanner_coupang_listings` / `_orders` / `_stock_sync_runs`
- 트렌드: `jimscanner_trends_keywords` / `_pins` / `_runs`
- 소싱: ggsan 테이블 3종 + `jimscanner_tv_ggsan_match` RPC

---

## 쿠팡 등록 상태 머신

```
DRAFT → TEMPORARY_SAVE → PENDING_APPROVAL → APPROVED → SELLING ⇄ STOPPED
                                          ↘ REJECTED
                                          ↘ FAILED / SKIPPED
```

- `STOPPED` ⇄ `SELLING`: 재고 동기화 크론이 ggsan 품절/재입고에 따라 전환
- 상태/가격/노출/마진/거절사유는 `jimscanner_coupang_listings`에 기록

---

## 멀티마켓 확장 지점 (미래)

- 마켓별 어댑터: 인증/서명(쿠팡 HMAC ↔ 네이버 OAuth), 카테고리 매핑, 필수항목 스키마
- 공통 도메인(발굴·소싱·마진·재고)은 마켓 무관 재사용
- 쿠팡 운영 안정화 후 착수

---

## 본업 잔재 (숨김)

사이드바에 없는 라우트(rates/forwarders/blog/content/deals/analytics/search-console 등)는
본업 robocopy 잔재. 점진 제거 대상. **DB 객체는 공유 모델이라 제거 금지.** 상세 `SEPARATION_NOTES.md`.
