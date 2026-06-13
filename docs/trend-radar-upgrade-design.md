# 트렌드 레이더 고도화 설계서

> 작성일: 2026-05-07
> 대상: jimscanner.co.kr 트렌드 레이더 (Phase B 고도화)
> 적용 프레임워크: DIKW Pyramid + Weak Signal Detection + Topic Cluster Model

---

## 1. 적용 프레임워크 요약

### 1.1 DIKW Pyramid (데이터 → 정보 → 지식 → 지혜)

| 계층 | 트렌드 레이더 적용 | 예시 |
|------|-------------------|------|
| **Data** | 원천 수집 (API 응답 그대로) | 네이버 "나이키 덩크" ratio=78 |
| **Information** | 정규화 + 분류 (카테고리, 의도, 관련도) | "나이키 덩크" → 신발/패션, commercial, 직구관련도 0.8 |
| **Knowledge** | 패턴 발견 (급상승, 시즌성, 연관 키워드) | "나이키 덩크 7주 연속 상승 + 미국 직구 연관" |
| **Wisdom** | 의사결정 (글감 선정, 상품 추천) | "나이키 덩크 직구 가이드 블로그 작성 권장" |

### 1.2 Weak Signal Detection (약한 신호 감지)

트렌드 라이프사이클 5단계:

| 단계 | 정의 | 판별 기준 | 콘텐츠 전략 |
|------|------|----------|------------|
| **Emerging** | 첫 출현, 소수 언급 | 최초 수집 후 2주 이내, 절대량 낮음 | 모니터링만 |
| **Growing** | 가속 성장 | 7일 velocity > +20%, 3주 연속 상승 | ★ 블로그 글감 최적 타이밍 |
| **Peak** | 최고점 도달 | ratio > 80 또는 velocity 0% 근접 | SEO 선점 글 발행 |
| **Declining** | 하락세 | velocity < -10%, 2주 연속 하락 | 기존 글 업데이트 |
| **Dormant** | 비활성 | ratio < 10 또는 4주간 무변동 | 아카이브 |

### 1.3 HubSpot Topic Cluster Model (콘텐츠 기획)

```
Pillar Page (배대지 비교)
├── Cluster: "미국 직구 트렌드"
│   ├── [Growing] 나이키 덩크 직구 가이드
│   ├── [Growing] 미국 블프 2026 예상 품목
│   └── [Peak] 아이폰17 직구 vs 국내
├── Cluster: "일본 직구 트렌드"
│   ├── [Growing] 치이카와 굿즈 배대지 비교
│   └── [Peak] 일본 한정판 피규어 관세
└── Cluster: "관세/규정 변경"
    ├── [Emerging] 2026 하반기 관세 개정안
    └── [Peak] 중국 부가세 폐지 영향
```

---

## 2. 데이터 수집 소스 & 주기

### 2.1 수집 소스 매트릭스

| # | 소스 | API/방법 | 수집 데이터 | 주기 | 비용 | 직구 관련도 |
|---|------|----------|------------|------|------|-----------|
| 1 | **네이버 DataLab 검색어** | REST API (현재 구현) | 키워드 그룹 상대 검색량 (ratio 0-100) | 1일 1회 | 무료 | ★★★★★ |
| 2 | **네이버 DataLab 쇼핑** | REST API (현재 구현) | 쇼핑 카테고리별 상대 클릭량 | 1일 1회 | 무료 | ★★★★★ |
| 3 | **네이버 쇼핑 인기검색어** | 웹 스크래핑 (datalab.naver.com) | 실시간 인기 쇼핑 검색어 TOP 20 | 6시간 | 무료 | ★★★★☆ |
| 4 | **Google Trends KR** | pytrends / SerpAPI | 한국 구글 검색 트렌드 | 1일 1회 | 무료/저렴 | ★★★☆☆ |
| 5 | **관세청 수출입 무역통계** | OPEN API (unipass) | 품목별 수입 건수/금액 변동 | 1주 1회 | 무료 | ★★★★★ |
| 6 | **네이버 카페/블로그** | 네이버 검색 API | 직구 커뮤니티 언급량 | 1일 1회 | 무료 | ★★★★☆ |
| 7 | **Reddit (r/fashionreps 등)** | Reddit API | 해외 직구 관련 서브레딧 인기 글 | 1일 1회 | 무료 | ★★★☆☆ |
| 8 | **GSC (Google Search Console)** | REST API (현재 구현) | jimscanner 유입 검색어 | 1일 1회 | 무료 | ★★★★★ |
| 9 | **쿠팡/무신사 인기상품** | 웹 스크래핑 | 국내 인기 상품 → 직구 대체 수요 발견 | 1일 1회 | 무료 | ★★★☆☆ |
| 10 | **X (Twitter) 한국** | API v2 | 직구/해외배송 관련 버즈 | 6시간 | 유료(Basic $200/월) | ★★☆☆☆ |

### 2.2 우선순위 (Phase B 구현 대상)

**즉시 (1-2주):**
- [1][2] 네이버 DataLab — 현재 구현 완료, 시드 확장만 필요
- [8] GSC — 현재 구현 완료, 자동 연동만 필요
- [3] 네이버 쇼핑 인기검색어 — 신규, 높은 ROI

**단기 (3-4주):**
- [4] Google Trends KR — pytrends 또는 SerpAPI
- [6] 네이버 카페/블로그 — 네이버 검색 API
- [5] 관세청 무역통계 — 주간 배치

**중기 (5-8주):**
- [7] Reddit
- [9] 쿠팡/무신사 인기상품

**보류:**
- [10] X/Twitter — 비용 대비 효과 낮음

---

## 3. 데이터 분류 체계 (Taxonomy)

### 3.1 5축 분류 시스템

모든 수집된 키워드는 5개 축으로 분류됩니다:

```
┌─────────────────────────────────────────────────┐
│              키워드 분류 5축                       │
├─────────────────────────────────────────────────┤
│ ① 상품 카테고리 (계층형)                          │
│ ② 사용자 의도 (4분류)                            │
│ ③ 직구 도메인 관련도 (-1 ~ +1)                    │
│ ④ 트렌드 라이프사이클 (5단계)                     │
│ ⑤ 콘텐츠 액션 (3분류)                            │
└─────────────────────────────────────────────────┘
```

### 3.2 ① 상품 카테고리 (3단계 계층)

```
패션/의류
├── 신발 (스니커즈, 부츠, 슬리퍼)
├── 상의 (티셔츠, 후드, 자켓)
├── 하의 (청바지, 반바지, 치마)
├── 가방 (백팩, 크로스백, 토트)
└── 액세서리 (시계, 모자, 벨트)

뷰티/건강
├── 영양제 (비타민, 프로바이오틱스, 오메가3)
├── 화장품 (스킨케어, 메이크업)
└── 헤어케어

디지털/가전
├── 스마트폰 (iPhone, Galaxy, Pixel)
├── 노트북/태블릿 (MacBook, iPad, Surface)
├── 오디오 (에어팟, 헤드폰, 스피커)
├── 게임 (Switch, PS5, Steam Deck)
└── 카메라 (미러리스, 액션캠)

덕질/취미
├── 피규어/인형 (넨도로이드, 스태추)
├── TCG (포켓몬, 유희왕, 원피스)
├── 굿즈 (아이돌, 애니, 게임)
└── 레고/프라모델

생활/가구
├── 가구 (의자, 책상, 수납)
├── 주방 (조리도구, 식기)
└── 인테리어 (조명, 패브릭)

식품
├── 건강식품 (프로틴, 슈퍼푸드)
├── 간식/음료
└── 조미료/소스

유아/키즈
├── 완구 (레고, 보드게임)
├── 의류 (아동복)
└── 유모차/카시트
```

### 3.3 ② 사용자 의도 (4분류)

| 의도 | 정의 | 키워드 패턴 예시 |
|------|------|-----------------|
| **Informational** | 정보 탐색 | "~란", "~차이", "~후기", "~비교" |
| **Commercial** | 구매 전 비교 | "~추천", "~가격", "~최저가", "~할인" |
| **Transactional** | 즉시 구매 의도 | "~구매", "~직구 방법", "~배대지" |
| **Navigational** | 특정 사이트/브랜드 | "아마존", "라쿠텐", "짐패스" |

### 3.4 ③ 직구 도메인 관련도 스코어 (-1 ~ +1)

| 점수 범위 | 의미 | 예시 |
|-----------|------|------|
| 0.8 ~ 1.0 | 직구 핵심 | "미국 배대지 비교", "관세 계산기" |
| 0.5 ~ 0.8 | 직구 높은 연관 | "나이키 덩크 직구", "아이허브 영양제" |
| 0.2 ~ 0.5 | 간접 연관 | "나이키 덩크 신상", "영양제 추천" |
| -0.2 ~ 0.2 | 무관 | "날씨", "정치 뉴스" |
| -1.0 ~ -0.2 | 역관련 (국내 구매 유도) | "쿠팡 로켓배송", "국산 추천" |

**산출 방법:** LLM 배치 분류 (초기) → 패턴 학습 후 규칙 기반 자동화

### 3.5 ④ 트렌드 라이프사이클 (자동 산출)

```python
def classify_lifecycle(sparkline_7d, sparkline_30d, first_seen_days_ago):
    velocity_7d = (sparkline_7d[-1] - sparkline_7d[0]) / max(sparkline_7d[0], 1)
    avg_30d = sum(sparkline_30d) / len(sparkline_30d)
    latest = sparkline_30d[-1]
    
    if first_seen_days_ago < 14 and latest < 30:
        return "emerging"
    elif velocity_7d > 0.2 and latest < avg_30d * 1.3:
        return "growing"      # ★ 블로그 글감 최적
    elif latest > 70 or (velocity_7d < 0.05 and latest > avg_30d):
        return "peak"
    elif velocity_7d < -0.1:
        return "declining"
    else:
        return "dormant"
```

### 3.6 ⑤ 콘텐츠 액션 (의사결정 매트릭스)

| 라이프사이클 × 의도 | Informational | Commercial | Transactional |
|--------------------|---------------|------------|---------------|
| **Emerging** | 모니터링 | 모니터링 | 모니터링 |
| **Growing** | ★ 블로그 글감 | ★★ 블로그 글감 | ★ 상품페이지 연결 |
| **Peak** | 블로그 글감 | ★★ 블로그 글감 | ★★ 상품페이지 연결 |
| **Declining** | 기존 글 업데이트 | 기존 글 업데이트 | 무시 |
| **Dormant** | 아카이브 | 아카이브 | 아카이브 |

---

## 4. DB 스키마 확장안

### 4.1 현재 → 확장

```sql
-- 기존 jimscanner_trends_keywords 에 컬럼 추가/활용
-- (이미 classified_intent, classified_category, domain_score 컬럼 존재 — Phase B용으로 예약됨)

-- 새 테이블: 트렌드 분류 결과 (LLM 배치 분류 결과 저장)
CREATE TABLE IF NOT EXISTS jimscanner_trends_classifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  keyword text NOT NULL,
  
  -- 5축 분류
  product_category_top text,       -- '패션/의류'
  product_category_mid text,       -- '신발'
  product_category_leaf text,      -- '스니커즈'
  user_intent text,                -- 'commercial'
  domain_relevance numeric,        -- -1.0 ~ 1.0
  lifecycle_stage text,            -- 'growing'
  content_action text,             -- 'blog_topic' / 'product_link' / 'monitor' / 'archive'
  
  -- 메타
  confidence numeric,              -- 분류 신뢰도 0~1
  classified_by text,              -- 'llm_batch' / 'rule_engine' / 'manual'
  classified_at timestamptz NOT NULL DEFAULT now(),
  
  UNIQUE(keyword)  -- 키워드당 최신 분류 1건
);

-- 새 테이블: 글감 후보 큐 (액션 가능 아이템)
CREATE TABLE IF NOT EXISTS jimscanner_trends_content_queue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  keyword text NOT NULL,
  suggested_title text,            -- LLM 제안 제목
  suggested_angle text,            -- '가격 비교', '직구 방법', '관세 주의사항'
  cluster_pillar text,             -- Topic Cluster 소속
  priority_score numeric,          -- 종합 우선순위 (velocity × domain_relevance × intent_weight)
  status text DEFAULT 'pending',   -- 'pending' / 'writing' / 'published' / 'rejected'
  created_at timestamptz NOT NULL DEFAULT now()
);

-- 새 테이블: 수집 소스 설정
CREATE TABLE IF NOT EXISTS jimscanner_trends_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_key text NOT NULL UNIQUE, -- 'naver_search', 'naver_shopping_hot', 'google_trends', ...
  label text NOT NULL,
  collect_interval_minutes int NOT NULL DEFAULT 1440,  -- 수집 주기 (기본 24시간)
  is_active boolean NOT NULL DEFAULT true,
  last_collected_at timestamptz,
  config jsonb,                    -- 소스별 설정 (API key 이름, endpoint 등)
  created_at timestamptz NOT NULL DEFAULT now()
);
```

---

## 5. 수집 → 분류 → 액션 파이프라인

```
┌──────────────────────────────────────────────────────────────────┐
│                        수집 레이어 (ETL)                          │
│                                                                  │
│  [Naver DataLab] [Naver 인기검색어] [Google Trends] [GSC] [관세청] │
│         ↓              ↓               ↓          ↓       ↓     │
│                   trends_raw (원천 페이로드)                       │
│                           ↓                                      │
│                   trends_keywords (정규화)                        │
├──────────────────────────────────────────────────────────────────┤
│                       분류 레이어 (Transform)                     │
│                                                                  │
│  ┌─ 규칙 엔진 (키워드 패턴 매칭) ─── 빠르고 저렴                  │
│  │  "~직구" → transactional, domain=0.9                          │
│  │  "~추천" → commercial                                        │
│  │                                                              │
│  └─ LLM 배치 (미분류 키워드) ─── 주 1회 또는 신규 100건 누적 시    │
│     → product_category, intent, domain_relevance 일괄 분류        │
│                           ↓                                      │
│              trends_classifications (5축 분류 결과)               │
├──────────────────────────────────────────────────────────────────┤
│                       액션 레이어 (Load → Action)                 │
│                                                                  │
│  [라이프사이클 자동 산출] + [5축 분류] → 의사결정 매트릭스          │
│                           ↓                                      │
│  ┌─ content_queue (글감 후보) ← growing + commercial + domain>0.5│
│  ├─ 어드민 알림 (급상승 키워드) ← velocity > +50%                 │
│  └─ 상품 페이지 연결 제안 ← transactional + peak                  │
└──────────────────────────────────────────────────────────────────┘
```

---

## 6. 구현 로드맵

### Phase B-1 (1-2주): 수집 확장

- [ ] 네이버 쇼핑 인기검색어 스크래퍼 추가 (6시간 주기)
- [ ] 시드 키워드 확장 (직구 관련 카테고리 2depth까지)
- [ ] GSC 데이터 자동 연동 (일 1회 cron)
- [ ] 수집 소스 관리 테이블 + 어드민 UI

### Phase B-2 (3-4주): 분류 엔진

- [ ] 규칙 기반 분류 엔진 (키워드 패턴 → 의도/카테고리)
- [ ] LLM 배치 분류 (신규 미분류 키워드 100건 단위)
- [ ] 라이프사이클 자동 산출 (velocity + sparkline 기반)
- [ ] domain_relevance 스코어 자동 산출

### Phase B-3 (5-6주): 액션 자동화

- [ ] 글감 후보 큐 자동 생성 (매일)
- [ ] 어드민 대시보드 고도화 (카테고리별 트렌드 맵, 글감 큐)
- [ ] 급상승 키워드 텔레그램 알림
- [ ] Google Trends KR 수집 추가

### Phase B-4 (7-8주): 인텔리전스

- [ ] 카테고리별 "지금 뜨는 상품" 자동 요약
- [ ] 블로그 초안 자동 제안 (제목 + 앵글 + 추천 키워드)
- [ ] 관세청 데이터 연동 (주간 수입 품목 변동)
- [ ] 콘텐츠 성과 피드백 루프 (발행 후 GSC 성과 추적)

---

## 7. 핵심 설계 원칙

1. **Data → Wisdom 흐름을 항상 유지**: raw 저장 → 정규화 → 분류 → 액션. 중간 단계 생략 금지.
2. **규칙 먼저, LLM은 보완**: 비용 효율. 패턴 매칭으로 80% 커버, LLM은 나머지 20%만.
3. **Growing 단계가 금맥**: Peak이 아닌 Growing에서 글을 써야 SEO 선점 가능.
4. **도메인 관련도 필터링 필수**: 아무리 급상승해도 직구와 무관하면 무시.
5. **시계열 = 자산**: 매일 수집 → 자연스럽게 시계열 축적. 삭제하지 말고 누적.

---

## 8. 다음 즉시 액션

이 설계서 확인 후 Phase B-1부터 시작:
1. `jimscanner_trends_sources` 테이블 생성
2. 네이버 쇼핑 인기검색어 스크래퍼 구현
3. 시드 키워드 확장 (직구 핵심 카테고리 20개+)
4. Vercel cron 스케줄 추가
