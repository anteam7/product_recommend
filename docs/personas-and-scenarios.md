# 팀 페르소나 & 작업 시나리오 (셀러 조직 시뮬레이션)

> 본업 짐스캐너(jimpass-agent-platform)의 페르소나/시나리오/운영일지 패턴을
> **오픈마켓 셀러 자동화 도메인**으로 이식한 것. 발굴→소싱→등록→운영 파이프라인을
> "누가(페르소나) · 어떻게 연결되어(시나리오) 일하고 · 무엇을 했는지(운영 일지)"로 형식화한다.

## 1. 설계 근거 — 왜 이 조직인가 (이커머스/비즈니스 프레임워크)

페르소나·부서·시나리오는 뇌피셜이 아니라 시장에서 검증된 프레임워크에 근거한다.

| 영역 | 적용 프레임워크 | 어디에 쓰였나 |
|------|----------------|--------------|
| 조직 구조 | **포터 가치사슬** (인바운드 소싱 → 머천다이징 → 가격 → 아웃바운드 등록 → 서비스) | 부서(Dept) 정의 |
| 퍼널 | **AARRR** (노출→클릭→전환→재구매→추천) | 각 페르소나의 `framework.aarrr` |
| 머천다이징 | **카테고리 매니지먼트(ECR 8-step)**, **Assortment Planning** | category-manager |
| 소싱 | **전략적 소싱**, **Open-to-Buy(OTB)**, **Make-or-Buy** | sourcing-buyer |
| 재무 | **GMROI(재고총이익률)**, **기여이익**, **Unit Economics** | margin-analyst |
| 가격 | **경쟁 가격전략**, **가격탄력성**, **MAP/MSP 하한** | pricing-strategist |
| 검색 | **마켓플레이스 SEO**, **Striking-distance** | marketplace-seo |
| 전환 | **CRO**, **사회적 증거(Cialdini)** | conversion-optimizer |
| 운영 | **Order-to-Cash**, **OTIF**, **재고관리/품절예방**, **Andon** | order-ops, inventory-ops |
| 통제 | **GRC**, **SoD(직무분리)**, **Maker-Checker(4-eyes)** | compliance-officer, 게이트(🚦) 단계 |
| 전략 | **OKR(Doerr)**, **리테일 전략**, **Balanced Scorecard** | seller-director, 분기/월간 시나리오 |
| 발굴 | **Jobs-to-be-Done**, **Weak Signal(약신호) 분석**, **Demand Sensing** | trend-scout |
| 개선 | **PDCA(Deming)**, **Kaizen** | 일일/주간 루프 시나리오 |

## 2. 부서 & 페르소나 (13직무)

`src/lib/personas.ts` 가 단일 소스(코드 config — 조직 설정이라 DB 미사용).

```
🧭 전략·수익        seller-director(전략 디렉터·최상위) · margin-analyst(마진) · compliance-officer(컴플라이언스/게이트)
🛒 상품기획·소싱     category-manager(카테고리) ─ trend-scout(트렌드) · sourcing-buyer(소싱)
🏷️ 등록·콘텐츠      listing-specialist(등록) ─ pricing-strategist(가격) · content-merchandiser(상세·이미지)
📈 검색·전환        marketplace-seo(SEO) ─ conversion-optimizer(전환·리뷰)
📦 주문·재고·CS     order-ops(주문·풀필먼트) ─ inventory-ops(재고·품절) · cs-manager(CS, 도입 예정)
```

각 페르소나 필드: `framework(가치사슬+AARRR+근거)`, `mission`, `responsibilities`, `deliverables`,
`tools(어드민 화면 링크)`, `kpis`, `raci`, `reportsTo/collaborators(조직도)`,
`delegationSeed(AI 위임 프롬프트 시드)`, `harness(연결된 .claude 스킬/에이전트)`.

> **하네스 정렬**: 페르소나는 `.claude/agents/`(orchestrator·trend-analyst·registrar·ops-diagnostician)와
> `.claude/skills/`(market-orchestrator·trend-triage·coupang-register-pipeline·naver-seo-ops·ops-sweep 등)에
> 1:1 가깝게 매핑된다. `delegationSeed`는 그 직무로 Claude에 작업을 위임할 때의 시스템 프롬프트다.

## 3. 작업 시나리오 (16개)

`src/lib/scenarios.ts`. 각 시나리오 = 목적 + 프레임워크 + 페르소나 흐름(steps, 🚦=게이트) + 주기(cadence).
실제 `.claude/skills`의 루프를 형식화했다.

| 주기 | 시나리오 | 연결 스킬 |
|------|---------|----------|
| 매일 | 쿠팡 일일 운영 루프 · 주문↔매입 다이제스트 | coupang-daily-loop · coupang-order-digest |
| 매주 | 트렌드 위클리 다이제스트 · 네이버 SEO 루프 · 가격경쟁력 진단 | trend-weekly-digest · naver-seo-loop · naver-seo-ops |
| 격주 | 신규 소싱·등록 사이클 | coupang-register-pipeline · upick-naver-register |
| 매월 | 마진 감사 · 카테고리 구색 리뷰 · 셀러 헬스 종합 점검 | audit-rates · seller-health-audit |
| 분기 | 셀러 전략·OKR 정렬 | — |
| 상시 | 품절 자동중지 · 트렌드 진입 검증 · 송장 동기화 | ops-sweep · ggsan-coupang-invoice-sync |
| 프로젝트 | 네이버 마켓 진출 · 건기식 카테고리 진입 | upick-naver-register · coupang_food_type |

## 4. 운영 일지 (작업 단위 로그)

> ⚠️ **공유 DB 네임스페이스 주의**: 본업(jimscanner, 물류 SaaS)도 같은 공유 DB(ref `obxvucyhzlakensopalf`)에서
> `jimscanner_execution_logs` / `jimscanner_scenario_runs` 를 **동일 이름·다른 페르소나 체계**로 쓴다.
> 셀러 로그가 본업 운영일지에 혼입되지 않도록 이 레포는 **`jimscanner_seller_*`** 네임스페이스를 쓴다.

- **테이블**: `jimscanner_seller_execution_logs` (`supabase/seller_execution_logs.sql`)
  — kind(cron/persona/scenario_step) · persona_id · scenario_id · status · summary · output · duration · tokens · evidence.
- **기존 `jimscanner_agent_runs`(루프 단위 요약)보다 한 입자 작은 "작업 단위"** 기록. 둘은 보완 관계.
  - 운영 일지 → `/admin/execution-logs`
  - 루프 로그 → `/admin/agent-log`
- **기록 API**: `src/lib/execution-log.ts`의 `logExecution({ kind, source, personaId, scenarioId, task, status, summary, ... })`.
  실패해도 throw 안 함(본 작업 비방해). `.mjs` 스크립트는 `scripts/lib/execution-log.mjs` 사용.
- **시나리오 실행 큐**: `jimscanner_seller_scenario_runs` (`supabase/seller_scenario_runs.sql`).
  `/admin/scenarios` 의 **▶ 지금 실행** → `POST /api/admin/scenarios/[id]/run` 이 큐에 등록 →
  로컬 러너가 폴링해 단계 실행(게이트에서 승인 대기) → 단계마다 `jimscanner_seller_execution_logs`에 기록.

## 5. 적용 절차 (DDL)

DB 객체는 본업과 공유 모델이라 추가만(create if not exists) 하고 본업 객체는 건드리지 않는다.
**2026-06-25 Supabase MCP `apply_migration` 으로 셀러 테이블 2종 적용 완료.**
재적용/타 환경 적용 시:

```bash
# Supabase MCP apply_migration 또는:
PGPASSWORD='...' node scripts/apply-sql.mjs supabase/seller_execution_logs.sql
PGPASSWORD='...' node scripts/apply-sql.mjs supabase/seller_scenario_runs.sql
# 적용 후 타입 재생성: npm run gen:types (선택)
```

> 테이블 미적용 상태에서도 화면은 빈 상태로 안전하게 렌더된다(쿼리 실패를 흡수).

## 6. 확장 방법

- **페르소나 추가**: `PERSONAS` 배열에 객체 추가(framework 근거 필수) → 화면 자동 반영.
- **시나리오 추가**: `SCENARIOS` 배열에 추가(steps의 personaId는 실제 페르소나 id) → cadence 그룹에 자동 표시.
- **로깅 연결**: 크론/스크립트에서 작업 후 `logExecution(...)` 호출.

## 7. 화면

| 경로 | 내용 |
|------|------|
| `/admin/personas` | 부서별 로스터 + 조직도 토글 + 상세(미션·KPI·위임 시드) |
| `/admin/scenarios` | 주기별 시나리오 카드 + 상세(협업 흐름·게이트·▶ 실행) |
| `/admin/execution-logs` | 운영 일지(작업 단위 실행 로그, 24h 요약·필터) |
