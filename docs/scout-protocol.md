# 쿠팡 소싱 스카우트 — 아키텍처·JSON 프로토콜 (2026-07-22)

크롬 확장(손) ↔ 로컬 Claude 두뇌로 쿠팡 수요를 발굴하는 시스템.
최종 워크플로우: 확장으로 수집 → 두뇌가 분석해 "판매자 적고 수요 있는" 후보 선정 → 사용자가 도매꾹 소싱(수동).

## 아키텍처

```
[확장 (어느 PC든)]              [Vercel]               [Supabase]                [이 로컬 PC]
 사이드패널 채팅 ─ message ─▶ /api/ext/scout/*  ─▶ jimscanner_scout_*  ◀─ 폴링 ─ scripts/scout-agent.mjs
 SW 폴링 ◀──── poll(명령) ──── Bearer 토큰 검증      sessions/messages/        └ claude -p --resume (두뇌)
 content 수집 ─ result(청크) ─▶                      commands/products/reviews  └ data/scout/ 파일 저장·분석
```

- **원격 방식(3안 비교 후 채택)**: Supabase 큐/폴링 릴레이. 포트·터널 노출 없음, 원격 PC는 확장 설치+토큰 입력만.
  (대안이던 WebSocket+Tailscale은 원격 PC마다 VPN 설치·인증서 관리, 공개 터널은 노출 부담으로 기각)
- **보안**: 전용 `SCOUT_EXT_TOKEN`(CRON_SECRET·service_role 과 분리, env 교체로 회전). 확장은 `chrome.storage.local`에만 저장.
  라우트 쓰기 대상은 scout_* 테이블 한정. 확장 navigate 는 coupang.com 화이트리스트 + 검색 딥링크(`/np/search?q=`) 차단.

## 설치·기동

1. **DB**: `supabase/scout_console.sql` 를 psql(Pooler 6543)로 1회 적용
2. **Vercel env**: `SCOUT_EXT_TOKEN` 등록(.env.local 값과 동일) 후 재배포
3. **두뇌(이 PC 상주)**: `node scripts/scout-agent.mjs`
4. **확장(각 PC)**: `chrome://extensions` → 개발자 모드 → "압축해제된 확장 프로그램 로드" → `extension/` 폴더
   → 확장 아이콘 클릭(사이드패널) → [설정] → API 주소(`https://product-recommend-nine.vercel.app`)와 토큰 입력 → 연결 테스트
5. 사이드패널 채팅에 지시 (예: "캠핑 의자 5페이지 수집해줘")

## 메시지 흐름

1. 채팅 입력 → `POST /message` → `scout_messages(role=user)`
2. scout-agent 폴링(5초) → `claude -p`(세션 `--resume` 연속) → 응답 텍스트는 `role=brain` 게시,
   마지막 ` ```json {"commands":[...]}``` ` 블록은 `scout_commands(queued)` insert
3. 확장 SW 폴링 → `POST /poll` (ack·progress 동봉) → queued 명령 수신(낙관적 점유로 중복 배달 방지)
4. 확장 실행(페이지네이션·지연·재시도 자율) → `POST /result` 청크 업로드(멱등 upsert) → final 시 done
5. scout-agent 가 done/failed 감지 → `data/scout/` 에 JSON/CSV/XLSX 저장 → Claude 에 결과 보고 → 채팅 응답

## API (인증: `Authorization: Bearer <SCOUT_EXT_TOKEN>`)

| 라우트 | 메서드 | body / query | 응답 |
|---|---|---|---|
| `/api/ext/scout/poll` | POST | `{extVersion, selectorsVersion, ack:[cmdId], progress:[{commandId, phase,…}]}` | `{commands:[≤5], control:[전량], serverTime}` |
| `/api/ext/scout/result` | POST | `{commandId, ok, chunk?:{seq,final}, data?:{kind,items}, summary?, error?:{code,message,paused?,checkpoint?}}` | `{ok, saved}` |
| `/api/ext/scout/message` | POST | `{sessionId?, content}` | `{ok, sessionId, messageId}` |
| `/api/ext/scout/messages` | GET | `?sessionId=&after=<ISO>` (gte 조회 — 클라이언트가 id 중복 제거) | `{messages, activeCommands}` |

## 명령 카탈로그 (`scout_commands.command_type` + `payload`)

### 저수준 (단발)
| type | payload | 비고 |
|---|---|---|
| `ping` | `{}` | 확장 버전·셀렉터 버전·작업탭 URL 반환 |
| `navigate` | `{url}` | coupang.com 만. `/np/search?q=` 딥링크 거부(Akamai) |
| `search` | `{keyword}` | 사람처럼: 헤더 검색창 click→비우기→type(40ms)→submit |
| `category` | `{url}` | 카테고리 URL 이동 |
| `tab` | `{action: open\|close\|activate\|list}` | 작업탭 관리 |
| `scroll` | `{to: "end"\|"top"\|px}` | 분할 easing 스크롤(지연로딩 대응) |
| `click` | `{selector, nth?}` | hover+지연 후 클릭 |
| `input` | `{selector, text, checked?}` | 타이핑/체크박스/셀렉트 |
| `filter` | — | **v1 미지원** → `collect_list.applyFilter`(수집 후 데이터 필터) 사용 |

### 고수준 (확장 자율 실행 — 페이지네이션·8~12초 지터·차단복구·체크포인트 내장)
| type | payload |
|---|---|
| `collect_list` | `{keyword? \| categoryUrl?, maxPages≤20(기본5), maxItems≤2000, applyFilter?: {minPrice, maxPrice, minReviews, minRating, rocketOnly, excludeRocket}}` |
| `collect_detail` | `{productUrl \| productUrls[≤100], include?: ["options","seller","images","delivery","qna"]}` |
| `collect_reviews` | `{productUrl \| productUrls[≤30], maxPages≤30(기본5)}` |
| `extract_images` | `{productUrl \| productUrls[]}` — URL만 추출(다운로드는 로컬 측) |

### 제어 (poll 의 `control[]`로 즉시 배달 — 큐 순서 무시)
`job_pause {}` / `job_resume {}` / `job_stop {}` / `get_state {}`
사이드패널의 ⏸▶⏹ 버튼은 서버 왕복 없이 SW 에 직접 지시(로컬 즉시 제어).

## 진행 이벤트 (poll body 동봉)
```json
{"commandId": "...", "phase": "paging", "page": 3, "totalPages": 5, "items": 108, "pct": 60, "note": "3/5 페이지 · 누적 108건"}
```
phase: `navigating|searching|paging|parsing|uploading|throttled|blocked_retry|paused|resumed`

## 결과·오류
- 청크: 페이지/상품 단위 업로드, `chunk.final=true` 로 마감. 멱등 키 products=`(command_id, product_id)`, reviews=`(product_id, content_hash)`.
- 오류 코드: `BLOCKED`(Akamai — `paused:true` 면 체크포인트 보존·재개 가능) / `SELECTOR_MISS`(셀렉터 버전 동봉) /
  `TIMEOUT` / `TAB_LOST` / `NAV_FAIL` / `CANCELLED` / `BAD_PAYLOAD` / `RUNTIME`
- 명령 상태: `queued → sent → running → done | failed | cancelled | paused(재개 대기)`

## 수집 항목
- **목록**(products): product_id, url, name, price, original_price(취소선), discount_rate, rating(별 width%/20),
  review_count, delivery_badge(rocket|rocket_fresh|rocket_global|rocket_growth|seller), image_url, keyword, page_no, rank_in_page
- **상세**(같은 테이블에 병합): options[], seller/seller_info, manufacturer, origin(상품정보 테이블), detail_images[],
  delivery_info, qna, category_path[](breadcrumb)
- **리뷰**(reviews): review_date, rating, content, images[], option_text, helpful_count

## 안티봇 정책 (scripts/lib/market-price.mjs 검증 노하우 이식)
- 검색 딥링크 금지 — 반드시 검색창 흐름. 페이지 간 8~12초 지터, DOM 액션 간 0.3~0.9초.
- Access Denied → 메인 재워밍업 후 재시도, 연속 3회 → 자동 일시정지(BLOCKED, paused) + 채팅 알림.
- 사용자 실브라우저 프로필에서 실행되므로 CDP 헤드리스보다 차단에 유리.

## 확장 업데이트 알림 (새로고침 유도)
확장은 unpacked(개발자 모드)라 코드를 바꿔도 각 브라우저에서 수동 새로고침해야 반영된다. 이를 사용자가 놓치지 않도록:
- **버전 동기화 규칙**: `extension/` 안의 **어떤 파일이든 바뀌면** `extension/manifest.json`의 `version`과 `src/app/api/ext/scout/poll/route.ts`의 `LATEST_EXT_VERSION`을 **같은 값으로 함께 올린다**(같은 커밋).
- 확장은 poll 때 자신의 manifest 버전을 보낸다 → 서버가 `LATEST_EXT_VERSION`과 비교해 낡았으면 응답에 `update`를 실어 보냄 → 사이드패널 상단에 **노란 배너 + [지금 새로고침]** 버튼.
- 버튼은 `chrome.runtime.reload()`로 확장을 스스로 재시작해 디스크의 새 파일을 로드한다(집 PC는 폴더가 그대로라 즉시 반영. **원격 PC는 extension 폴더를 다시 복사한 뒤** 눌러야 새 코드가 로드됨).
- 셀렉터만 급히 고칠 때는 버전 안 올리고 옵션 페이지 storage 오버라이드로 무배포 패치(새로고침 불필요).

## 셀렉터 운용
`extension/selectors.json`(버전 필드) — serp/search 는 검증값, detail/review 는 다중 폴백 후보.
DOM 변경 시: 확장 재배포 없이 옵션 페이지에 수정 JSON 붙여넣기(chrome.storage 오버라이드 > 번들).
`SELECTOR_MISS` 오류에 셀렉터 버전이 동봉되므로 어느 버전이 깨졌는지 추적 가능.

## 분석 (시나리오 C — 가설 검증)
`node scripts/scout-analyze.mjs --command <id> | --session <id> | --keyword <kw>`
- 지표: 셀러 수·HHI(경쟁 밀도) / 리뷰 합·중앙값(수요량) / **최근 30일 리뷰 비율(저수요 vs 저경쟁 구분 핵심)** /
  로켓 점유율 / 트림 중앙값 가격(상·하위 10% 컷).
- 기회 판정(초기값): 셀러 ≤15 ∧ 리뷰 중앙값 ≥30 ∧ 최근 30일 리뷰 ≥20% ∧ 로켓 ≤40%.
- 후보 점수: 수요 0.35 + 최근성 0.25 + 가격대 적합 0.25 + 비로켓 0.15 → `data/scout/reports/*.md`

## 운영 메모
- scout-agent 모델: `SCOUT_AGENT_MODEL`(기본 opus), 폴링 `SCOUT_AGENT_POLL_MS`(기본 5000).
- 데이터 파일: `data/scout/<세션8자>/<ts>-<키워드>/products.{json,csv,xlsx}` (git 미추적).
- MV3 수명: 유휴 폴링은 alarms 30초 — 명령 반응이 느리면 사이드패널을 열어두면 3초 폴링이 SW 를 촉진한다.
- 확장 업데이트: `extension/` 수정 후 chrome://extensions 에서 새로고침(♻) — 원격 PC 는 폴더 재복사.
