# jimscanner-personal

위탁 판매 상품 발굴 도구 — **로컬 전용 개인 비즈니스용**.

본업(`C:\Web\jimscanner\jimpass-agent-platform\`)에서 2026-05-11에 옵션 A 결정으로 분리된 레포.

## 정체성

운영자 본인이 별도 온라인 몰에서 위탁 판매할 건강식품을 발굴하는 도구. 본업(짐스캐너 — 배대지 비교 플랫폼)과는 비즈니스가 분리됨.

- **공유**: Supabase DB (`obxvucyhzlakensopalf`), WSL collector 11종
- **분리**: UI, 의사결정 도메인, 라우트, 권한 노출

## 핵심 화면

- `/admin/trend-radar` — 대시보드 (KPI + Top 상품 카드)
- `/admin/trend-radar/ggsan` — ggsan 도매 카탈로그 (1,879건, 22 카테고리, 임박특가)
- `/admin/trend-radar/tv-ggsan-match` — TV 편성표 ↔ ggsan 매칭 (홈쇼핑 push 시그널)
- `/admin/trend-radar/opportunity` — 기회 점수 산점도
- `/admin/trend-radar/tv-pushes` — 홈쇼핑 9사 통합 편성 키워드
- `/admin/trend-radar/sources` — 수집 cron 헬스
- `/admin/trend-radar/pins` — 채택 후보 핀

## 분리 메모

- 본업과 같은 Supabase 프로젝트 공유 (`obxvucyhzlakensopalf`)
- 같은 ggsan 테이블 3개 + `jimscanner_tv_ggsan_match` RPC 그대로 사용
- 본업에서 ggsan/tv-ggsan-match 코드는 검증 후 제거 예정

## 로컬 실행

```bash
npm install
npm run dev
```

dev 서버는 본업과 포트 충돌 피하기 위해 별도 포트(예: 3001) 사용 권장.

## 분리 의사결정 컨텍스트

- 짐스캐너 메모 `seller_tools_context.md` — 위탁 판매 도구 컨텍스트
- 짐스캐너 메모 `strategic_pivot_2026_05_09.md` — 옵션 A 분리 결정문
- 짐스캐너 메모 `b2b_track_plan.md` — 본업에 유지되는 B2B 트랙
