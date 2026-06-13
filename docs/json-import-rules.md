# JSON → DB 정규화 규칙

> `C:\Web\jimscanner\json\` 38개 배대지 JSON 파일을 `shipping_rates` / `forwarder_additional_services` 테이블에 적재하기 위한 규칙 문서.

## 1. 공통 원칙

| 원칙 | 설명 |
|------|------|
| **원본 보존** | 무게 단위·통화·가격 표기는 JSON 원본 그대로 저장. 환산은 **표시 시점에만** 수행. |
| **전체 등급 저장** | 5·10·13단계 등급도 전부 `shipping_rates`에 저장. UI에서만 상·중·하 3단계로 추려 노출. |
| **UPSERT 키** | `(forwarder_id, country, center_name, weight_min, weight_max, grade_level, shipping_type)` — 재실행해도 중복 발생 X. |
| **Dry-run 우선** | 변환 스크립트는 먼저 `.sql` 파일을 출력. psql 수동 실행은 리뷰 후 별도 단계. |

---

## 2. `shipping_rates` 테이블 보완 (선행 ALTER)

현재 스키마에 없는 컬럼을 추가한다.

```sql
ALTER TABLE shipping_rates
  ADD COLUMN IF NOT EXISTS weight_unit VARCHAR(4) DEFAULT 'kg',   -- 'kg' | 'lb' | 'lbs'
  ADD COLUMN IF NOT EXISTS source VARCHAR(20) DEFAULT 'manual';    -- 'json_import' | 'manual' | 'ai_extract'

CREATE INDEX IF NOT EXISTS idx_shipping_rates_source ON shipping_rates(source);
```

- `weight_unit` — 원본 JSON의 무게 단위. 엔드유저 비교 랭킹 시 kg로 환산(`1 lb = 0.453592 kg`)하되 **DB에는 원본값 유지**.
- `source` — `json_import`로 적재한 행만 재적재 시 DELETE 후 INSERT 할 수 있도록 구분.

---

## 3. 필드 매핑 규칙

### 3.1 forwarder_id 해석

- JSON 파일명에서 확장자 제거 → `forwarders.slug` 로 매칭.
  - 예외: `ehanex.json` → slug `ehanex` (훗타운), `postteam.json` & `joypost.json` 는 별개 slug로 분리 유지.
- `forwarders`에 없는 slug는 **import 스킵** (신규 배대지는 `new_forwarders.sql` 적용 선행 필수).

### 3.2 country 코드

| JSON 표기 (예) | DB `country` |
|---|---|
| `"미국"`, `"usa"`, `"미국_뉴저지"`, `"usa_or"` | `US` |
| `"일본"`, `"항공"`(일본항공 컨텍스트) | `JP` |
| `"중국"`, `"중국(항공)"`, `"위해"`, `"상하이"` | `CN` |
| `"영국"`, `"독일"`, `"스페인"` 등 | `EU` (집약) 또는 개별 추후 논의 |
| 기타 (호주, 홍콩, 대만) | 현 단계 스킵 |

**주의:** 현재 코드 `COUNTRIES` 상수는 US/JP/CN 만 정의됨 (`src/types/index.ts:72-76`). EU/기타는 Phase 2 스크립트에서 우선 스킵하고 Phase 8에서 별도 처리.

### 3.3 center_name

- JSON에서 센터명이 명시된 경우 한글 표준명으로 정규화:
  - `"OR"`, `"오리건"`, `"미국(OR)"` → `"오리건 센터"`
  - `"NJ"`, `"뉴저지"` → `"뉴저지 센터"`
  - `"CA"`, `"LA"`, `"캘리포니아"` → `"캘리포니아 센터"`
  - `"DE"`, `"델라웨어"` → `"델라웨어 센터"`
  - `"도쿄"`, `"TOKYO"` → `"도쿄 센터"`
  - `"오사카"`, `"OSAKA"` → `"오사카 센터"`
  - `"위해"`, `"웨이하이"` → `"웨이하이 센터"`
  - `"상하이"`, `"shanghai"` → `"상하이 센터"`
  - 구분 없음 (단일 센터) → `"{국가명} 센터"` (예: `"중국 센터"`)

### 3.4 weight_min / weight_max / weight_unit

JSON 포맷에 따라 3가지 변환 패턴:

**패턴 A — 포인트(점) 요금표 (대부분):**
```
[{weight: "0.5 KG", price: "$14.63"}, {weight: "1.0 KG", price: "$17.07"}, ...]
→ weight_min=0.0, weight_max=0.5 (첫 행)
→ weight_min=0.5, weight_max=1.0 (둘째 행)
→ ... 이전 행의 weight가 다음 행의 weight_min이 됨
```

**패턴 B — 이미 구간(range)인 경우 (드뭄):** 그대로 사용.

**패턴 C — 무게 단위 추출:**
- `"0.5 KG"`, `"0.5kg"` → `weight_unit='kg'`, 숫자 `0.5`
- `"1LB"`, `"1.00"`(미국 컨텍스트) → `weight_unit='lb'`, 숫자 `1.0`
- 애매한 숫자만 있을 때 JSON 상위의 `unit`/`weight_unit` 필드 참조

**엔드유저 비교 시 kg 환산:**
```typescript
const kgWeight = weight_unit === 'lb' || weight_unit === 'lbs'
  ? weight * 0.453592
  : weight
```

### 3.5 price_krw / price_usd / price_jpy

- JSON의 통화를 그대로 해당 컬럼에 저장, 나머지 통화 컬럼은 `NULL`.
- 통화 추출:
  - `"$14.63"`, `"USD"`, `"10.98"` (미국 컨텍스트) → `price_usd`
  - `"¥590"`, `"JPY"` → `price_jpy`
  - `"6,600원"`, `"KRW"`, 숫자만 (한국 컨텍스트) → `price_krw`
- 콤마·통화기호 제거 후 NUMERIC으로.

### 3.6 member_grade / grade_level

**규칙:** 모든 등급을 각각 별도 행으로 저장한다.

| JSON 등급 스타일 | grade_level 할당 |
|---|---|
| 단일 (균일) | `1` |
| 일반 → 플래티넘 (2단계) | `1`, `2` |
| 브론즈·실버·골드·다이아·플래티넘 (5단계) | `1`~`5` |
| G0~G10 (11단계) | `1`~`11` |
| WHITE~PLATINUM (10단계) | `1`~`10` |

- `member_grade` 컬럼에는 JSON 원본 등급명 저장 (예: `"다이아몬드"`, `"G10"`, `"YELLOW"`).
- `member_grade_definitions` 테이블에 해당 배대지의 등급 정의가 없으면 함께 INSERT (중복 방지 UPSERT).

**UI 상·중·하 3단계 축소 규칙 (표시 시점):**
```typescript
const levels = allLevelsForForwarder.sort()
const displayLevels = [
  levels[0],                                    // 하 (최저)
  levels[Math.floor(levels.length / 2)],        // 중
  levels[levels.length - 1],                    // 상 (최고)
]
```
→ `forwarders/[slug]/page.tsx` 에서 이 로직을 적용. DB 쿼리엔 영향 없음.

### 3.7 shipping_type

- `"항공"`, `"air"`, 미명시 → `'air'`
- `"해운"`, `"sea"`, `"선박"`, `"LCL"` → `'sea'`

### 3.8 무게 단위 절상/반올림

일부 배대지는 "0.5kg 단위 절상" 규칙 적용 (tabae, easytao 등). 이는 **데이터가 아니라 비즈니스 룰** → `forwarders.shipping_note` 필드나 `ForwarderContent.pricing_notes`에 텍스트로만 보존. DB 요금표는 원본 포인트 그대로.

---

## 4. 부가서비스 매핑 규칙

### 4.1 테이블 → `forwarder_additional_services`

(DDL: `supabase/additional_services.sql` 참조)

### 4.2 JSON 구조 패턴 (3가지)

**패턴 ① — 카테고리 객체형 (jimpass, jikgu):**
```json
"additional_services": {
  "검수": [{"service": "실물검수", "price": "무료"}],
  "포장": [{"service": "재포장(박스포장)", "price": "3,500원/박스"}]
}
```
→ `category` = `"검수"` / `"포장"`, `service_name` = `service` 필드.

**패턴 ② — 평평한 배열형 (ehanex):**
```json
"additional_services": [
  {"name": "합배송비", "price": "..."},
  {"name": "보험 서비스 수수료", "options": [...]}
]
```
→ `category`는 서비스명에서 자동 추론 (키워드 맵핑표 사용, 아래 4.4).

**패턴 ③ — options 중첩형 (ehanex 보험):**
```json
{"name": "보험", "options": [{"보상한도": "500만원", "price": "$25"}]}
```
→ 각 option을 별도 row로 분리. `service_name` = `"보험 (500만원까지)"`.

### 4.3 가격 파싱 (옵션 B)

모든 행에 `price_text` = 원본 그대로 저장. 추가로 단순 케이스만 `price_numeric` + `price_currency` 파싱:

| 원문 | price_numeric | price_currency | 비고 |
|---|---|---|---|
| `"무료"`, `"Free"`, `"0원"` | `0` | `KRW` | |
| `"3,500원"`, `"3500원"` | `3500` | `KRW` | |
| `"$3"`, `"$25.00"` | `3` / `25` | `USD` | |
| `"¥500"`, `"500엔"` | `500` | `JPY` | |
| `"3,500원/박스"` | `3500` | `KRW` | 단가. 단위는 `price_text`로 확인. |
| `"신청서 당 $25"` | `25` | `USD` | |
| `"1일 $1"` | `1` | `USD` | |
| `"실비"`, `"Case별"` | `NULL` | `NULL` | |
| `"3% 또는 ..."`, `"$400 이상 ..."` | `NULL` | `NULL` | 조건부 |
| `"무료 또는 $5"` | `NULL` | `NULL` | 분기형 |
| `"10개까지 무료, 11개째부터 $1"` | `NULL` | `NULL` | 구간형 |

**파싱 정규식 (참고):**
```js
const PRICE_PATTERNS = [
  { re: /^\s*(무료|free|0원)\s*$/i, amount: 0, currency: 'KRW' },
  { re: /\$\s*([\d,]+(?:\.\d+)?)/,  currencyIdx: null, currency: 'USD' },
  { re: /¥\s*([\d,]+)/,             currency: 'JPY' },
  { re: /([\d,]+)\s*엔/,            currency: 'JPY' },
  { re: /([\d,]+)\s*원/,            currency: 'KRW' },
]
// 조건·분기 키워드 감지 시 바로 NULL 반환
const AMBIGUOUS = /(실비|case|또는|이상|초과|미만|\+|\/[가-힣])/i
```

### 4.4 category 자동 분류 키워드

`additional_services`가 패턴 ② (평평한 배열)일 때:

| 키워드 | category |
|---|---|
| 검수, 검품 | 검수 |
| 포장, 박스, 리패킹, 재포장, 멀티박스 | 포장 |
| 합배송, 묶음배송 | 합배송 |
| 보관, 창고료 | 보관 |
| 통관, 관세, 관부가세, 세관 | 통관 |
| 반송, 리턴, 반품 | 반송 |
| 보험 | 보험 |
| 검역, 방역 | 검역 |
| 수출신고, 인보이스 | 수출신고 |
| 기타 매칭 실패 | 기타 |

---

## 5. 공지사항 / FAQ — **Phase 8로 보류**

이번 단계(요금 + 부가서비스)에선 수집하지 않음. JSON의 `notices`/`faq` 필드는 무시.

단, `forwarder_content.faq` JSONB에 편집된 FAQ가 있으면 `/forwarders/[slug]` 페이지가 이미 그걸 우선 표시하므로 (`page.tsx:337-341`), Phase 8에서 이 구조와의 통합을 재검토한다.

---

## 6. Phase 2 스크립트 산출물

`scripts/import-from-json.mjs`의 동작:

1. `json/*.json` 전부 파싱 → forwarder slug 매칭 → 스킵 대상 로그
2. `shipping_rates` 레코드 생성 → `supabase/rates_from_json.sql` (DELETE + INSERT, `source='json_import'`)
3. `member_grade_definitions` 신규 등급 → 같은 파일에 UPSERT
4. `forwarder_additional_services` 레코드 생성 → `supabase/additional_services_from_json.sql`
5. `scripts/out/import-report.md` — 파일별 행 수, 스킵 이유, 파싱 실패 건 수 리포트

## 7. 롤백 전략

`source='json_import'`로 태깅했으므로, 잘못 들어간 경우:

```sql
-- 전체 롤백
DELETE FROM shipping_rates WHERE source = 'json_import';
DELETE FROM forwarder_additional_services WHERE source = 'json_import';
```

수동 편집분(`source='manual'`)과 격리되어 보존됨.
