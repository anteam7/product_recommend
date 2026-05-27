# Session Log

## 2026-05-27 — 트렌드 레이더 v5: 카테고리 Lead-Lag 선행지표 보드 (auto-implement)

**목표**: jimscanner_trends_keywords 의 (category_top, day) 시계열로 카테고리간 시점차
인과(선행 → 후행)를 추정해 위탁 발주 사이클(7~14일)보다 앞서 매입 타이밍을 잡기.

**구현**
- `supabase/trends_v5_category_leadlag.sql` 신규
  - VIEW `jimscanner_trends_category_daily` — (category_top, day) 일별 demand_index
    = `AVG(volume_relative × 1/sqrt(max(rank,1)))` · KST 일자, 최근 90일.
  - RPC `jimscanner_trends_category_leadlag(window_days, min_overlap, max_lag)` —
    카테고리 쌍별 1~14일 lag 중 Pearson r 최대 lag + 선행 카테고리 최근 5일 2차 미분(가속도).
  - RPC `jimscanner_trends_category_overlay(lead_cat, lag_cat, window_days)` —
    두 카테고리 시계열 + 선행 카테고리 최근 3일 급등 키워드 Top10 (delta=recent3 - prev7).
  - 둘 다 SECURITY DEFINER · service_role only.
- 어드민 UI
  - `src/app/admin/(dashboard)/trend-radar/leadlag/page.tsx` 신규 — 푸시 callout +
    LeadLagBoard 렌더링.
  - `LeadLagBoard.tsx` — 행=선행 / 열=후행 히트맵, 셀 클릭 → fetch overlay →
    두 시계열 SVG 오버레이 차트 + 선행 키워드 Top10.
  - `/admin/trend-radar/page.tsx` 메인에 lead-lag callout 추가 (r≥0.5 & lag≥3 &
    lead_accel>0 인 Top3).
  - `layout.tsx` 서브내브에 'Lead-Lag' 탭 추가.
- API
  - `src/app/api/admin/trend-radar/leadlag/overlay/route.ts` — auth 후 overlay RPC
    프록시.
- 캐스팅: 신규 RPC 는 types/supabase.ts 미반영 → `as never` 두 번 (admin-supabase 호출
  + page 호출).

**검증**: `npm run build` 통과.

**미적용**
- DB 마이그레이션은 사람이 적용해야 함 (CLAUDE.md 룰). 적용 전까지 페이지는 빈 상태 +
  RPC 에러 박스 노출 (graceful).
- 슬랙 알림 / `_memory/session-log` 자동 기록은 미구현 — DB 적용 후 cron 단계에서 추가
  하는 게 자연스러움. 본 PR 은 read-only 시각화 + callout 까지.

## 2026-05-15 — Improvement Scout 관점 분리: jimscanner = UX/운영/수익화, product_recommend = 트렌드 유지

**문제 인식**
- jimscanner(=구 `jimpass` 라벨) 측 proposed 아이디어 11개가 전부 트렌드 데이터 파이프라인(분류/시각화/상품 발굴)으로만 몰림
- 원인 진단: `scripts/improvement-scout.mjs` 의 `buildPrompt()` 가 프로젝트 구분 없이
  (1) 트렌드 3축만 유도하고 (2) 스냅샷도 `jimscanner_trends_*` 만 보여줘서 LLM 입장에서 다른 도메인 근거가 없음
- jimscanner 본업은 B2C 배대지 비교 사이트라 트렌드는 사업자(셀러) 도구 — 본 미션에서 한 발 떨어짐

**완료**
- DB 마이그레이션 (`improvement_ideas_expand_category_and_rename_projects`)
  - `category` CHECK 확장: `ux`, `ops`, `monetization` 추가 (기존 5종 + 3 = 8종)
  - row 라벨 리네임: `personal → product_recommend`, `jimpass → jimscanner` (23 row UPDATE)
- `scripts/improvement-scout.mjs` 프로젝트 분기
  - `fetchDataSnapshot()` 디스패처 + `fetchProductRecommendSnapshot()` / `fetchJimscannerSnapshot()`
  - jimscanner 스냅샷: rate_fetch_runs 7d, forwarder_reviews pending/approved, exchange_rates/shipping_rates lastAt, gsc_pages 28d, blog_posts 상태 분포, sale_events active/upcoming, admin_actions 7d, forwarders count
  - `buildPrompt()` 디스패처 + `buildJimscannerPrompt()` 신규 (UX/Ops/Monetization 3축, 트렌드는 후순위 명시)
  - `normalize()` cats 리스트 확장
- `scripts/improvement-scout-all.mjs` TARGETS 라벨 product_recommend/jimscanner, `SCOUT_JIMSCANNER_PATH` env (구 `SCOUT_JIMPASS_PATH` fallback 유지)
- `scripts/improvement-implement.mjs`
  - 라벨 검증 리스트 갱신
  - 잠재 버그 수정: `fetchNextProposedIdea()` 에서 `.eq('project', 'personal')` 하드코딩되어 있던 것 → `.eq('project', PROJECT)`
  - `triggered_by` 도 PROJECT 변수로
- 어드민 UI
  - `src/app/admin/(dashboard)/improvement-ideas/page.tsx`: PROJECT_FILTERS, counts 키, 헤더 문구, 운영 노트 모두 새 라벨로
  - `IdeaCard.tsx`: project 배지 색상 매핑, CATEGORY_LABELS 에 ux/ops/monetization 한글 라벨 추가
  - CATEGORY_FILTERS 에 UX/운영/수익화 칩 추가

**스모크 테스트**
- jimscanner: 16 turns / 100s / $0.96 → `[monetization/high/proposed] 배대지 외부이동 서버측 트래킹 + /compare 인라인 CTA` 적재 (의도대로 수익화 축)
- product_recommend: 11 turns / 92s / $0.74 → `[product_discovery/high/proposed] 연관 상품 그래프 — 동시 언급 기반 인접 상품 발굴 뷰` 적재 (기존 트렌드 축 유지)
- `npm run build` 통과 (jimscanner-personal 측 — 어드민 UI 변경분)

**Task Scheduler 주기 조정**
- `jimscanner-improvement-implement` 반복 간격 PT1H → **PT20M** (3회/시, 영구). 백로그 8건을 ~2.7시간 내 소화. 12분 내부 timeout 과 8분 여유.
- scout 는 PT1H 유지 (자연 생산률 = product_recommend 1 + jimscanner 1 / 시).

**미정**
- jimscanner 본업 레포(jimpass-agent-platform) 의 어드민에도 같은 improvement-ideas UI 가 있는지는 미확인. 만약 있다면 거기도 동일 라벨/카테고리 패치 필요할 수 있음
- 라벨 'jimpass' 가 다른 곳(forwarder 브랜드 매핑 4개 파일)에서 발견되었으나 그건 배송사 브랜드 이름이라 무관
- jimscanner 측 proposed 11건은 현재 자동 구현 대상 아님(implement cron 은 product_recommend 만 처리). 별도 jimscanner-implement cron 필요 여부는 사용자 판단

## 2026-05-14 (저녁) — Improvement Scout (시간당 Claude CLI 개선 제안 cron) 신설

**목표**: 시간당 1회 Claude Code CLI 가 agentic read-only 모드로 admin 영역을 둘러보면서
효과적인 데이터 분석/시각화/경쟁력 상품 발굴 방향의 새 개선안을 1개씩 적재. 중복 회피.

**완료**
- 신규 테이블 `jimscanner_improvement_ideas` 적용 (Supabase MCP `apply_migration` 사용):
  id, project ('personal'|'jimpass'), title, category, priority, description, rationale,
  referenced_files[], dedup_signature, status, generated_at, cost/token meta, note
- `scripts/improvement-scout.mjs`:
  - `--project=personal|jimpass` + `--cwd=<path>` 인자
  - Supabase 통계 + 이전 60개 아이디어 컨텍스트 pre-fetch → 프롬프트에 인라인
  - Claude CLI 호출 (`-p --output-format json --model sonnet --permission-mode bypassPermissions --allowed-tools Read Grep Glob`)
  - **stdin pipe 대신 임시 파일 + shell `<` 리다이렉션** (Windows shell:true 와 Node child stdin
    조합이 불안정해서 8KB+ 프롬프트에서 exit=1 발생. 임시파일은 `%TEMP%/jimscanner-scout/` 사용 후 unlink)
  - 결과를 jimscanner_improvement_ideas + jimscanner_trends_runs(source=improvement_scout) 에 적재
  - dedup: 같은 title (case-insensitive) 또는 같은 dedup_signature → status='duplicate' 로 마킹
- `scripts/improvement-scout-all.mjs`: wrapper. personal cwd + jimpass cwd 순차 실행.
  `SCOUT_JIMPASS_PATH` env 로 jimpass 경로 override 가능 (기본 `C:/Web/jimscanner/jimpass-agent-platform`)
- 어드민 UI:
  - `src/app/admin/(dashboard)/improvement-ideas/page.tsx` (서버 컴포넌트, project/status/category 필터)
  - `IdeaCard.tsx` (클라이언트, expand/collapse, status 변경 버튼, 메모 자유 텍스트)
  - `actions.ts` (server action: updateIdeaStatus, updateIdeaNote)
  - generated Database 타입에 새 테이블이 없어서 `sbLoose() as any` 우회 (rpc_type_workaround 패턴)
- `AdminShell.tsx` 에 '메타' 그룹 신규, '💡 개선 제안' 메뉴 추가

**해결된 트랩 (구독 vs API 키 자식 env)**
- 사용자 claude CLI 는 Max 구독 (`subscriptionType: max`, `authMethod: claude.ai`)
- 그러나 `.env.local` 에 `ANTHROPIC_API_KEY` 가 있고 `node --env-file=.env.local` 로 시작하면
  process.env 에 로드되어 자식 claude 가 **구독 무시하고 API 키 인증** 으로 빠짐
- 그 API 키 잔액이 0 → `is_error: api_error_status 400 "Credit balance is too low"`
- **수정**: 자식 spawn 시 `env: { ...process.env, ANTHROPIC_API_KEY: undefined, ... }` 후 delete.
  improvement-scout.mjs 와 classify-trends-llm.mjs 둘 다 동일 패턴 적용.

**스모크 테스트 (수정 후)**
- personal 스카우트 1회: 6 turn, 138초, "market_raw 미처리 뉴스·검색 시그널 → 트렌드 상품 자동 연결 배치" 적재
- scout-all (personal+jimpass): 5.5분, 양쪽 ok. 추가로 momentum 시각화 + Rising Stars 뷰 제안

**Task Scheduler 운영**
- `jimscanner-improvement-scout` 매시간 정각 (다음 09:00 KST), Limited user
- 래퍼 `scripts/improvement-scout.cmd` → `logs/improvement-scout-YYYY-MM.log` append
- 한 회차 평균 ~5-7분 (양쪽 합쳐서). ExecutionTimeLimit 15분 안에 끝남.

## 2026-05-14 (오후) — heartbeat 카드 제거 · classify-trends-llm 을 Claude CLI 로컬 스크립트로 이관

**진단**
- 소스 헬스 페이지 `✗ collector 다운` 표시는 `jimscanner_trends_heartbeat` 테이블 기반인데, 이 테이블에 upsert 하는 코드가 코드베이스 어디에도 없음. SQL 마이그레이션 시 `'init'` 으로 한 번 INSERT 된 게 전부 — heartbeat 가 죽어있는 게 아니라 **아무도 안 살리고 있음**
- `classify_trends_llm` 이 trends_runs 에 안 보이는 이유: 미분류 product 0개일 때 `processed: 0` 으로 early-return 하면서 로그를 안 남기는 버그성 코드 경로. cron 자체는 정상

**완료**
- `src/app/admin/(dashboard)/trend-radar/sources/page.tsx`: heartbeat 카드 + `jimscanner_trends_heartbeat` fetch + `HeartbeatRow` 인터페이스 전부 제거. trends_runs + market_raw 집계만으로 헬스 판정
- `src/app/api/cron/classify-trends-llm/route.ts` + `src/lib/gemma-classify.ts` 삭제 (Gemini API 의존성 제거)
- `scripts/classify-trends-llm.mjs` 신규: Supabase service-role 직접 접근, `claude -p --output-format json` 서브프로세스(stdin 으로 프롬프트 주입), 빈 케이스도 trends_runs 에 status=ok 기록, `triggered_by='local_cli'`, model 라벨 `claude-code-cli`
- `vercel.json` 에서 classify-trends-llm cron entry 제거 (12개로 감소)
- `scripts/run-crons.mjs`: HTTP cron 12개 호출 후 마지막에 classify-trends-llm.mjs 를 `spawn(process.execPath, ...)` 로 실행. `--no-classify` / 특정 filter 시 건너뜀
- `npm run build` 통과 (.next 클린 후. stale validator.ts 가 삭제된 라우트 type import 시도해서 1차 빌드 실패 → rm -rf .next 로 해결)
- 스모크 테스트: 분류 대상 0개 케이스에서 status=ok, duration_ms=100 로 trends_runs row 생성 확인

**미정**
- Claude CLI 서브프로세스가 Windows Task Scheduler 의 사용자 컨텍스트에서 `~/.claude/` 인증을 읽을 수 있는지는 미검증. 실제 첫 분류 발생 시 확인 필요
- 새벽 03:30 KST 일괄 호출 후 03:30+5~7분에 classify 까지 끝나는 흐름이 됨

## 2026-05-14 — 루트 페이지 admin 리다이렉트 · 로컬 cron 우회

**완료된 작업**
- `src/middleware.ts`: hostname 에 `product-recommend` 가 포함된 요청은 `/` 를 `/admin` 으로 307 리다이렉트. matcher 에 `/` 추가. jimscanner.co.kr 은 영향 없음. 배포 확인 `curl -I` → `307 Location: /admin`
- `vercel crons list` 로 13개 cron 모두 등록 확인. 그러나 최근 2일 로그상 자동 실행은 `collect-naver-search-trends` 1개만 발생 — Hobby 플랜 한도로 추정
- 로컬 우회 스크립트 작성: `scripts/run-crons.mjs` (Bearer `CRON_SECRET` 으로 13개 endpoint 순차 호출)
- 13개 백필 1회 실행 — 신규 raw 신호: naver-search 7, naver-shopping 11, naver-news 40, naver-tvtime 27 (총 85건). google-suggest·blog·clien·quasarzone·kca 는 0건 (이미 최신)
- `classify-trends-llm` 은 "분류 대상 없음" — raw → products 단계는 다른 파이프라인이 처리해야 분류 대상 생김 (다음 tick에서 잡힐 것)

**미정**
- Windows Task Scheduler 자동 등록은 안 함. 다음 세션 또는 사용자가 직접 진행
- Vercel Pro 업그레이드 vs 로컬 cron 영구 정착 — 비용/안정성 비교 필요

## 2026-05-12 — GitHub 분리·Vercel 배포·식물성 멜라토닌 시장 검증

**완료된 작업**
- `anteam7/product_recommend` GitHub 리포에 코드/설정만 푸시 (비즈니스 분석 .md 제외)
- main 브랜치 사용. 본업 로컬은 master 그대로 유지
- Vercel 새 프로젝트 (`product-recommend`) 연결, 빌드 통과
  - 초기 빌드 실패: `jimscanner_ggsan_recommend` RPC 타입 누락 → `recommend/page.tsx:52`에서 `as never` 캐스팅으로 우회
  - 두 번째 실패 원인 발견: Framework Preset이 "Other"로 잡혀 모든 SSR 라우트 404. `vercel.json`에 `framework: "nextjs"` 추가해 해결
- 환경변수 등록 (production + preview):
  - 사용자 수동 등록분에 더해 `ADMIN_EMAILS`, `CRON_SECRET`, `GA4_SERVICE_ACCOUNT_JSON` (base64), `GSC_SERVICE_ACCOUNT_JSON` (base64) 추가
- Vercel SSO Protection 비활성화 (`*.vercel.app` URL 공개 접근 가능)
- 프로덕션 URL 확인: https://product-recommend-nine.vercel.app — 홈/about/admin login 모두 200

**시장 검증**
- ggsan 도매 카탈로그 "수면" 관련 스캔: 멜라토닌 7건, 마그네슘 36건 등 50건 확보
- 다나와에서 멜라레브·우먼멜라·멜라에스 시장가 비교
- 결론: **멜라레브가 1순위 (3배 마진), 멜라에스 2순위, 우먼멜라 보류**
- `jimscanner_trends_seeds`에 수면 관련 키워드 그룹 4개 INSERT

**다음 액션** (다음 세션 우선순위)
1. 내일(2026-05-13) 21:00 KST 이후 `/admin/trend-radar`에서 새 시드 4개의 검색량·순위 추세 확인
2. 추세 우상향이면 멜라레브 SKU 1개 시범 위탁 등록 (정상가 27,000~28,000원 또는 60정 묶음 차별화)
3. 30일 판매 데이터 후 멜라에스 60정 객단가 라인 확장 검토
4. 쿠팡 개별 상품 리뷰 수·별점 보강 (이번엔 다나와에서 미수집)

**임시 파일** (gitignored)
- `scripts/sleep-market-scan.mjs` — ggsan + 트렌드 스캔, 재실행 가능
- `scripts/add-sleep-seeds.mjs` — 시드 추가, 이미 실행 완료 (재실행 시 중복 스킵)
