# CLAUDE.md — Harness 설정

## 하네스: 오픈마켓 셀러 자동화

**목표:** 트렌드 발굴 → 유픽/ggsan 소싱 → 쿠팡·네이버 등록 → 재고·주문 운영을 Loop Engineering L1/L2 수준으로 자동화한다.

**트리거:** 등록·소싱·운영·진단 작업 요청 시 `.claude/skills/market-orchestrator/SKILL.md`의 `market-orchestrator` 스킬을 사용하라. 단순 질문·코드 설명은 직접 응답 가능.

**에이전트:** `.claude/agents/` — orchestrator, trend-analyst, registrar, ops-diagnostician  
**스킬:** `.claude/skills/` — market-orchestrator, trend-triage, upick-naver-register, coupang-register-pipeline, naver-seo-ops, ops-sweep, script-diagnose

**변경 이력:**
| 날짜 | 변경 내용 | 대상 | 사유 |
|------|----------|------|------|
| 2026-06-13 | 초기 구성 | 전체 | Loop Engineering 적용 + 유픽→네이버 파이프라인 신규 구축 |

---

## 핵심 규칙

```
Agent = Model + Harness
```

- 작업 전 반드시 `AGENTS.md` → 관련 `docs/*.md` 순으로 읽기
- 방향 충돌 시 `platform_direction.md`가 최우선 문서
- 소스코드 변경 후 반드시 `npm run build` 검증
- implementer cron이 도는 레포이므로, 코드 수정 후엔 **다음 cron 전에 커밋 여부를 사용자에게 먼저 확인**

---

## 프로젝트 개요

**오픈마켓 셀러 자동화 도구** (쿠팡 우선, 멀티마켓 지향)

> 트렌드로 발굴한 상품을 도매처(ggsan)에서 소싱해 **쿠팡 등 오픈마켓에 자동 등록**하고,
> **재고·주문을 운영**하는 1인 셀러 자동화 도구.

- 본업(짐스캐너 — 배대지 비교)에서 **2026-05-11 분리**된 개인 비즈니스용 레포
- 상세: `platform_direction.md`, `docs/architecture.md`

> ⚠️ 이 레포에는 본업 robocopy 잔재(배대지 비교/물류 SaaS 라우트·문서)가 남아 있습니다.
> 배대지/물류 SaaS 방향은 **본업 소관, 이 레포에서 폐기**. 옛 문서는 `archive/`.

---

## 핵심 파이프라인

```
① 발굴(트렌드 9종 + TV홈쇼핑) → ② 소싱(ggsan 도매) → ③ 등록(쿠팡 Open API) → ④ 운영(재고·주문 동기화)
```

상세: `docs/architecture.md`

---

## 폴더 역할

| 폴더/파일 | 역할 |
|-----------|------|
| `docs/` | 하네스 지식 기반 (아키텍처, 로드맵, 스택, DB, 트렌드 레이더 설계) |
| `src/app/admin/(dashboard)/` | 어드민 UI (사이드바 = 실제 정체성) |
| `src/app/api/cron/` | 쿠팡 재고·주문 동기화 + 트렌드 수집 크론 |
| `scripts/` | 쿠팡 등록·보정·진단 + ggsan 소싱 운영 스크립트 |
| `supabase/` | DB 스키마 (본업과 공유) |
| `platform_direction.md` | **최우선 방향 정의서** |
| `SEPARATION_NOTES.md` | 본업 분리(옵션 A) 내역 — 잔재 제거 가이드 |
| `archive/` | 폐기된 배대지/물류 SaaS 기획 문서 (히스토리 보존) |

---

## 작업 순서

1. `AGENTS.md` 확인 → 관련 `docs/*.md` 읽기
2. `platform_direction.md` 확인 (방향 최우선)
3. 작업 수행
4. `npm run build` (소스코드 변경 시)
5. 커밋 전 사용자 확인 (cron 레포)

---

## 기술 스택

- Next.js 16 (App Router) + React 19 + TypeScript 5
- Tailwind CSS v4 + shadcn/ui + Radix UI
- Supabase (Postgres, 서울 ap-northeast-2) — **본업과 공유**
- Vercel 배포

상세: `docs/tech-stack.md`

---

## Supabase DB 연결

- Project ref: `obxvucyhzlakensopalf` (본업과 공유)
- 직접 연결(5432) **불가** — IPv6 전용
- **Connection Pooler(6543) 사용 필수**
- DDL 작업: psql + PGPASSWORD 환경변수 방식

상세: `docs/database.md`

---

## 쿠팡 연동

- 인증: HMAC-SHA256 (`COUPANG_ACCESS_KEY` / `COUPANG_SECRET_KEY`)
- 등록 상태: DRAFT → TEMPORARY_SAVE → PENDING_APPROVAL → APPROVED → SELLING ⇄ STOPPED
- 등록/보정/진단은 `scripts/coupang-*.mjs`, 동기화는 `src/app/api/cron/coupang-*`

상세: `platform_direction.md` 섹션 4

---

## 배포 / 실행

```bash
npm run dev            # 로컬 dev (포트 3001 — 본업 3000 충돌 회피)
npm run build          # 빌드 검증 (배포 전 필수)
git push origin main   # Vercel 자동 배포
```

- 프로덕션: https://product-recommend-nine.vercel.app
- 리포: https://github.com/anteam7/product_recommend
- 쿠팡 크론은 Vercel Hobby 한도로 **로컬 스케줄러(`scripts/run-crons.mjs`) 우회**

---

## 일관성 체크리스트

작업 전:
- [ ] `platform_direction.md` 방향 확인
- [ ] 관련 `docs/*.md` 읽기
- [ ] 건드리는 라우트가 본업 잔재인지 확인 (사이드바 노출 여부)

작업 후:
- [ ] `npm run build` 통과
- [ ] cron 레포이므로 커밋 전 사용자 확인
- [ ] 문서 변경 시 `AGENTS.md` 목차 동기화

---

## 주의: 본업 잔재

사이드바(`AdminShell.tsx` NAV)에 없는 라우트는 본업 robocopy 잔재(배대지 요금/블로그/콘텐츠/신고·후기/분석 등).
무해하므로 점진 제거하되, **DB 객체는 본업과 공유 모델이므로 제거 금지**. 상세 `SEPARATION_NOTES.md`.
