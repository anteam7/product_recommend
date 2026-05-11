# 분리 작업 노트 (2026-05-11)

본 레포는 `C:\Web\jimscanner\jimpass-agent-platform\`(이하 **본업**)에서 **옵션 A 분리** 결정으로 떨어져 나온 개인 비즈니스용 로컬 전용 레포.

## 분리 결정 컨텍스트

본업 메모 3개를 같이 봐야 함:
- `memory/seller_tools_context.md` — 사용자가 운영하는 별도 온라인 몰의 위탁 판매 상품 발굴 도구라는 정체성
- `memory/strategic_pivot_2026_05_09.md` — CEO/Eng/CSO/Design/Perf 5개 리뷰 통합 후 듀얼 트랙 전략 + 옵션 A 분리 결정
- `memory/b2b_track_plan.md` — 본업에 유지되는 B2B 직구 사업자 트랙

## 데이터·인프라 공유 모델 (옵션 A)

분리는 **UI + 의사결정 도메인 + 라우트 노출**만. 데이터·인프라는 공유:

| 자산 | 위치 | 공유/분리 |
|---|---|---|
| Supabase 프로젝트 (`obxvucyhzlakensopalf`) | 같은 DB | **공유** |
| ggsan 테이블 3개 + tv_ggsan_match RPC | 본업 DB | **공유** (이 레포가 직접 접근) |
| 다른 11종 collector (naver_tvtime 등) | 본업 DB | **공유** (이 레포에서도 시그널 활용) |
| WSL collector (`/home/anteam7/jimscanner-collector/`) | WSL | **공유** (cron으로 본업 DB에 적재) |
| 어드민 UI · 사이드바 · 메뉴 | — | **분리** |
| 의사결정 도메인 (위탁 vs 직구) | — | **분리** |

## 본업 잔여 라우트 (사이드바 미노출, 코드 잔존)

robocopy로 본업 전체가 복사되어 personal에 본업 라우트가 코드상 존재. 사이드바에서만 숨김 처리.

| 잔존 라우트 | 본업 용도 | personal에서 처리 |
|---|---|---|
| `src/app/(b2c)/**` | 짐스캐너 메인 사이트 (배대지 비교) | URL 직접 입력 시 보이지만 의미 없음. 사용자가 입력 안 함 → 그대로 둠 |
| `src/app/admin/(dashboard)/content/` | 배대지 콘텐츠 관리 | 사이드바 미노출 |
| `src/app/admin/(dashboard)/blog/` | 본업 블로그 어드민 | 사이드바 미노출 |
| `src/app/admin/(dashboard)/deals/` | 세일 이벤트 | 사이드바 미노출 |
| `src/app/admin/(dashboard)/rates/`, `services/`, `rate-fetcher/`, `rate-checks/`, `exchange-rates/` | 배대지 요금 관리 | 사이드바 미노출 |
| `src/app/admin/(dashboard)/reports/`, `review-collection/`, `forwarder-reviews/` | 신고·후기 시스템 | 사이드바 미노출 |
| `src/app/admin/(dashboard)/trends/`, `market-signals/`, `manifest/`, `search-console/`, `analytics/` | 본업 인사이트 | 사이드바 미노출 |
| `src/app/api/**` (admin/trend-radar/ggsan 외) | 본업 API 라우트 다수 | 호출 안 됨, 그대로 둠 |
| `public/**` 본업 이미지·문서 | 짐스캐너 자산 | 그대로 둠 |
| `scripts/**` 본업 진단·이전 스크립트 | 본업 운영 | 그대로 둠 |
| `supabase/**` SQL (trends_v4_ggsan, tv_ggsan_match_rpc 외) | 본업 마이그레이션 | 그대로 둠 |
| `docs/**` 본업 아키텍처 문서 | 본업 컨텍스트 | 그대로 둠 |
| `_memory/**` 본업 세션 로그 | 본업 작업 기록 | robocopy 제외했음 (이미 부재) |

### 왜 적극 제거 안 했는가
- shared lib (`src/lib/`) 의존 추적 비용 + npm run build 실패 위험
- 1인 운영자가 URL 직접 입력하지 않으면 잔존 라우트 무해
- 추후 운영하면서 점진 제거 가능

### 점진 제거 가이드
- 본 도구 작동을 1주 검증한 뒤 `src/app/admin/(dashboard)/{content,blog,deals,rates,services,...}` 폴더 단위로 삭제
- 삭제 후 `npm run build` 통과 확인. 의존성 끊기면 `src/lib/` 안 본업 전용 모듈도 제거 가능

## 본업에서 제거해야 할 것 (검증 후 실행)

본 레포 ggsan/tv-ggsan-match 화면이 정상 작동 확인되면 본업에서 다음 제거:

1. `src/app/admin/(dashboard)/trend-radar/ggsan/page.tsx`
2. `src/app/admin/(dashboard)/trend-radar/ggsan/RefreshButton.tsx`
3. `src/app/admin/(dashboard)/trend-radar/tv-ggsan-match/page.tsx`
4. `src/app/api/admin/trend-radar/ggsan/refresh/route.ts`
5. `src/app/api/admin/trend-radar/ggsan/queue-status/route.ts`
6. `supabase/trends_v4_ggsan.sql` (파일만, DB 객체는 유지)
7. `supabase/trends_v4_tv_ggsan_match_rpc.sql` (파일만, DB 객체는 유지)
8. `src/app/admin/(dashboard)/AdminShell.tsx` L140-143 (ggsan 메뉴)
9. `src/app/admin/(dashboard)/trend-radar/page.tsx` L34-48, L135, L189-217 (ggsan callout)
10. `src/app/admin/(dashboard)/trend-radar/layout.tsx` L10 (tv-ggsan-match nav)

**DB 객체는 제거 안 함** — 같은 Supabase 공유 모델이므로 ggsan 테이블 3개 + RPC + 인덱스 + 트리거는 그대로 유지.

## 로컬 실행

```bash
npm install
npm run dev   # 포트 3001 — 본업 기본 3000과 충돌 회피
```

브라우저: `http://localhost:3001/admin/trend-radar/ggsan`

본업 관리자 계정으로 로그인 (같은 Supabase auth 공유).
