# 기술 스택

## 핵심 스택

| 레이어 | 기술 |
|--------|------|
| 프레임워크 | Next.js 16 (App Router) |
| UI | React 19 + Tailwind CSS v4 + shadcn/ui |
| DB/Auth | Supabase (서울 ap-northeast-2) |
| 배포 | Vercel |
| 언어 | TypeScript 5 |

## 주요 의존성

```json
"next": "16.1.6"
"react": "19.2.3"
"@supabase/ssr": "^0.8.0"
"@supabase/supabase-js": "^2.98.0"
"@vercel/analytics": "^1.6.1"
"tailwindcss": "^4"
"shadcn": "^3.8.5"
"radix-ui": "^1.4.3"
```

## 개발 환경

```bash
# 개발 서버 (포트 3001 — 본업 3000과 충돌 회피)
npm run dev    # http://localhost:3001

# 빌드 검증 (배포 전 필수)
npm run build

# 배포
git push origin main   # Vercel 자동 배포 → product-recommend-nine.vercel.app
```

## 폴더 구조 (App Router)

```
src/
├── app/
│   ├── admin/(dashboard)/   # 어드민 — 실제 정체성 (사이드바 AdminShell.tsx)
│   │   ├── trend-radar/**    # 위탁 발굴 화면군
│   │   ├── coupang-publish/  # 쿠팡 등록 상품 관리
│   │   └── coupang-orders/   # 쿠팡 주문 ↔ 매입
│   ├── api/cron/             # 쿠팡 재고·주문 동기화 + 트렌드 수집 크론
│   └── (b2c)/**              # 본업 잔재 (배대지 비교 — 미사용)
└── lib/
    ├── supabase.ts          # Supabase 클라이언트
    └── utils.ts
```

> 본업에서 robocopy로 딸려온 잔재 라우트가 다수 존재. 사이드바(`AdminShell.tsx`)에 노출된 것만 실사용.
> 상세 `SEPARATION_NOTES.md`.

## 코딩 규칙

- Server Components 기본, 클라이언트 상태 필요 시만 `"use client"`
- DB 접근은 `src/lib/supabase.ts` 통해서만
- 환경변수: `.env.local` (DB 연결 정보는 `docs/database.md` 참조)
