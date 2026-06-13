# Supabase DB 연결

> 상세 원본: `CLAUDE.md` "Supabase DB 연결" 섹션
> ⚠️ 이 DB는 **본업(짐스캐너)과 공유**. ggsan 테이블·RPC는 본업 소유, 이 레포가 직접 접근. 상세 `SEPARATION_NOTES.md`.

## 프로젝트 정보

- **Project ref**: `obxvucyhzlakensopalf`
- **URL**: `https://obxvucyhzlakensopalf.supabase.co`
- **Region**: ap-northeast-2 (서울)

## 테이블 인벤토리 (이 도구가 쓰는 것)

| 도메인 | 테이블 / 객체 |
|--------|---------------|
| 쿠팡 | `jimscanner_coupang_listings` (등록 상품: 상태·가격·노출·마진·거절사유·판매수), `jimscanner_coupang_orders` (주문: 주문ID·상품·수량·금액·매입상태·송장), `jimscanner_coupang_stock_sync_runs` (재고 동기화 크론 로그) |
| 발굴(트렌드) | `jimscanner_trends_keywords`, `jimscanner_trends_pins`, `jimscanner_trends_runs` |
| 소싱(ggsan, 본업 공유) | ggsan 카탈로그 테이블 3종 + `jimscanner_tv_ggsan_match` RPC |
| 환율 | `jimscanner_exchange_rates`, `jimscanner_exchange_rate_logs` |
| 본업 잔재 (미사용) | `forwarders`, `shipping_rates`, `centers`, `member_grade_definitions`, 블로그/콘텐츠/리뷰 등 |

> **DB 객체는 본업과 공유 모델이라 제거 금지.** 잔재 라우트 삭제 시에도 테이블은 유지.

## 환경 변수 (.env.local)

```
NEXT_PUBLIC_SUPABASE_URL=https://obxvucyhzlakensopalf.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon key>
```

## 연결 방법 선택

| 작업 | 방법 |
|------|------|
| 앱에서 데이터 조회 | Supabase JS client (anon key) |
| 스크립트 데이터 조회/삽입 | REST API + service_role key |
| DDL (CREATE/ALTER TABLE) | psql + Connection Pooler |

## psql 연결 (DDL 필요 시)

**직접 연결(5432) 불가** — IPv6 전용. 반드시 Connection Pooler(Supavisor) 사용:

```bash
PGPASSWORD='비밀번호' psql \
  -h aws-0-ap-northeast-2.pooler.supabase.com \
  -p 6543 \
  -U "postgres.obxvucyhzlakensopalf" \
  -d postgres
```

## 주의사항

1. **IP 허용 필수**: Supabase Dashboard → Settings → Database → Network Restrictions
2. **비밀번호 특수문자**: URL 방식 아닌 `PGPASSWORD` 환경변수로 전달
3. **service_role key**: REST API만 가능, DDL 불가

## schema.sql 변경 절차

1. `supabase/schema.sql` 수정
2. IP 허용 확인
3. psql로 실행
4. `npm run build` → git commit → Vercel 자동 배포

## 데이터 파일 위치

`public/doc/`의 배송사 요금 데이터(`*_shipping_rates.json`, `collect_forwarder_rates.csv` 등)는
**본업 잔재**로 이 도구에서 미사용.
