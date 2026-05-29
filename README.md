# product_recommend (jimscanner-personal)

**오픈마켓 셀러 자동화 도구** — 로컬 전용 개인 비즈니스용.

> 트렌드로 발굴한 상품을 도매처(ggsan)에서 소싱해 **쿠팡 등 오픈마켓에 자동 등록**하고,
> **재고·주문을 운영**하는 1인 셀러 자동화 도구. 쿠팡 우선, 멀티마켓 지향.

본업(`C:\Web\jimscanner\jimpass-agent-platform\` — 배대지 비교 플랫폼)에서 2026-05-11 옵션 A로 분리.
배대지/물류 SaaS 방향은 본업 소관이며 이 레포에서는 폐기 (옛 문서는 `archive/`).

## 파이프라인

```
① 발굴(트렌드 9종 + TV홈쇼핑) → ② 소싱(ggsan 도매) → ③ 등록(쿠팡 Open API) → ④ 운영(재고·주문 동기화)
```

## 핵심 화면 (사이드바)

**위탁 발굴**
- `/admin/trend-radar` — 대시보드 (KPI + Top 상품 카드)
- `/admin/trend-radar/recommend` — ⭐ 추천 후보
- `/admin/trend-radar/ggsan` — ggsan 도매 카탈로그 (1,879건, 임박특가)
- `/admin/trend-radar/tv-ggsan-match` — TV 편성표 ↔ ggsan 매칭
- `/admin/trend-radar/opportunity` — 기회 점수
- `/admin/trend-radar/tv-pushes` — 홈쇼핑 9사 편성 키워드
- `/admin/trend-radar/sources` — 수집 크론 헬스
- `/admin/trend-radar/pins` — 채택 후보 핀

**쿠팡 자동등록**
- `/admin/coupang-publish` — 등록 상품 관리 (상태·가격·노출·마진)
- `/admin/coupang-orders` — 주문 ↔ 매입 매칭

## 인프라 (본업과 공유)

- Supabase DB (`obxvucyhzlakensopalf`) — ggsan 테이블·RPC, WSL collector 공유
- 분리된 것: UI / 사이드바 / 의사결정 도메인(위탁 vs 직구)
- 배포: Vercel `product-recommend-nine.vercel.app` / 리포 `github.com/anteam7/product_recommend`

## 로컬 실행

```bash
npm install
npm run dev    # 포트 3001 — 본업 3000과 충돌 회피
npm run build  # 배포 전 검증
```

본업 관리자 계정으로 로그인 (같은 Supabase auth 공유).

## 문서

- `platform_direction.md` — **최우선 방향 정의서**
- `CLAUDE.md` / `AGENTS.md` — 하네스 규칙·목차
- `docs/` — 아키텍처, 로드맵, 스택, DB, 트렌드 레이더 설계
- `SEPARATION_NOTES.md` — 본업 분리 내역 + 잔재 제거 가이드
- `archive/` — 폐기된 배대지/물류 SaaS 기획 문서
