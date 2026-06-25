# AGENTS.md — product_recommend 목차

> 이 파일은 목차(TOC)만 담당합니다. 실제 내용은 `docs/`와 루트 문서를 참조하세요.

## 핵심 규칙

- 작업 전 반드시 `CLAUDE.md` → 해당 `docs/*.md` 순으로 읽기
- 방향 충돌 시 `platform_direction.md`가 최우선
- cron 레포이므로 코드 수정 후 커밋 전 사용자 확인

---

## 정체성 (한 줄)

> **오픈마켓 셀러 자동화 도구** — 트렌드로 발굴 → ggsan 도매 소싱 → 쿠팡 자동 등록 → 재고·주문 운영.
> 쿠팡 우선, 멀티마켓 지향. (본업 짐스캐너 배대지 사업과 분리됨)

---

## 문서 맵

| 파일 | 역할 |
|------|------|
| [`CLAUDE.md`](./CLAUDE.md) | 하네스 규칙 (작업 순서, 제약, DB 연결) |
| [`platform_direction.md`](./platform_direction.md) | **최우선 방향 정의서** (파이프라인, 쿠팡 연동, 로드맵) |
| [`docs/architecture.md`](./docs/architecture.md) | 발굴→소싱→등록→운영 파이프라인 아키텍처 |
| [`docs/personas-and-scenarios.md`](./docs/personas-and-scenarios.md) | 팀 페르소나·작업 시나리오·운영 일지 (셀러 조직 시뮬레이션, 이커머스 프레임워크 근거) |
| [`docs/phase-roadmap.md`](./docs/phase-roadmap.md) | 단계별 로드맵 |
| [`docs/tech-stack.md`](./docs/tech-stack.md) | 기술 스택 & 개발 환경 |
| [`docs/database.md`](./docs/database.md) | Supabase DB 연결 & 테이블 인벤토리 |
| [`docs/json-import-rules.md`](./docs/json-import-rules.md) | JSON 임포트 규칙 |
| [`docs/trend-radar-upgrade-design.md`](./docs/trend-radar-upgrade-design.md) | 트렌드 레이더 5축·DIKW·Topic Cluster 설계 |
| [`docs/trend-radar-v4-execution-plan.md`](./docs/trend-radar-v4-execution-plan.md) | 트렌드 레이더 v4 실행 계획 |
| [`docs/trend-radar-v4-poc-results.md`](./docs/trend-radar-v4-poc-results.md) | v4 소스 PoC 결과 |
| [`SEPARATION_NOTES.md`](./SEPARATION_NOTES.md) | 본업 분리(옵션 A) 내역 + 잔재 제거 가이드 |
| [`README.md`](./README.md) | 레포 개요 / 로컬 실행 |
| [`archive/`](./archive/) | 폐기된 배대지/물류 SaaS 기획 문서 (히스토리) |

---

## 실제 화면 (사이드바 = 정체성)

| 그룹 | 메뉴 |
|------|------|
| 개요 | 대시보드 |
| 위탁 발굴 | 추천 후보 / ggsan 카탈로그 / TV↔ggsan 매칭 / 기회 점수 / TV 편성표 / 수집 상태 / 핀 |
| 쿠팡 자동등록 | 등록 상품 관리 / 주문↔매입 |
| 메타 | 개선 제안 |

> source of truth: `src/app/admin/(dashboard)/AdminShell.tsx`

---

## 서브시스템 가이드

| 영역 | 위치 |
|------|------|
| 쿠팡 등록/운영 | `src/app/admin/(dashboard)/coupang-publish`, `coupang-orders`, `scripts/coupang-*.mjs`, `src/app/api/cron/coupang-*` |
| 발굴(트렌드) | `src/app/admin/(dashboard)/trend-radar/**`, `src/app/api/cron/collect-*` |
| 소싱(ggsan) | `scripts/ggsan-*.mjs`, ggsan 테이블·RPC (본업 DB 공유) |
| 본업 잔재 | 사이드바 미노출 라우트 (`SEPARATION_NOTES.md` 참조) |
