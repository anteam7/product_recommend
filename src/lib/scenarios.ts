// 오픈마켓 셀러 작업 시나리오 — 단일 소스(config).
// 페르소나(src/lib/personas.ts)들이 "어떻게 연결되어 일하는지"를 이커머스 프레임워크에 근거해 정의.
// 각 시나리오 = 목적 + 프레임워크 근거 + 페르소나 흐름(steps) + 주기(cadence) + 산출물/KPI.
// /admin/scenarios 화면이 이 데이터를 읽는다.
//
// 실제 파이프라인(① 발굴 → ② 소싱 → ③ 등록 → ④ 운영)과 .claude/skills 의 루프를 시나리오로 형식화한 것.

export type Cadence =
  | 'daily'
  | 'weekly'
  | 'biweekly'
  | 'monthly'
  | 'quarterly'
  | 'triggered'
  | 'project'

export const CADENCES: Record<Cadence, { label: string; sub: string; color: string }> = {
  daily: { label: '매일', sub: '상시 운영', color: '#0891B2' },
  weekly: { label: '매주', sub: '주간 루프', color: '#16A34A' },
  biweekly: { label: '격주', sub: '소싱·등록 사이클', color: '#DB2777' },
  monthly: { label: '매월', sub: '정기 점검', color: '#9333EA' },
  quarterly: { label: '분기', sub: '전략 사이클', color: '#4F46E5' },
  triggered: { label: '상시', sub: '이벤트 트리거', color: '#475569' },
  project: { label: '프로젝트', sub: '목표 달성까지', color: '#2563EB' },
}

// 화면 표시 순서 (운영 리듬: 자주 → 가끔 → 특수)
export const CADENCE_ORDER: Cadence[] = [
  'daily',
  'weekly',
  'biweekly',
  'monthly',
  'quarterly',
  'triggered',
  'project',
]

export type ScenarioStep = {
  /** personas.ts 의 persona id */
  personaId: string
  /** 이 단계에서 하는 일 */
  action: string
  /** maker-checker 게이트(승인·차단 권한) 단계인가 */
  gate?: boolean
}

export type Scenario = {
  id: string
  name: string
  emoji: string
  accent: string
  /** 비즈니스 목적 */
  objective: string
  /** AARRR 단계 / 사업 영역 */
  area: string
  /** 근거 프레임워크 (뇌피셜 아님) */
  frameworks: string[]
  cadence: Cadence
  /** 무엇이 이 시나리오를 시작시키나 */
  trigger: string
  /** 페르소나 협업 흐름 (순서대로) */
  steps: ScenarioStep[]
  /** 산출물 */
  output: string
  kpis: string[]
  priority: 1 | 2 | 3
  status: 'active' | 'planned'
  /** 연결된 하네스 스킬(.claude/skills) */
  harness?: string
}

export const SCENARIOS: Scenario[] = [
  // ───────────── 매일 ─────────────
  {
    id: 'daily-coupang-loop',
    name: '쿠팡 일일 운영 루프',
    emoji: '🅒',
    accent: '#0891B2',
    objective: '매일 주문·재고·승인 상태를 한 바퀴 돌려 판매 사고(품절·반려·미발주)를 0으로 유지한다.',
    area: '운영 · Order-to-Cash',
    frameworks: ['PDCA(Deming)', 'Order-to-Cash', '재고관리(품절 예방)'],
    cadence: 'daily',
    trigger: '매일(로컬 스케줄러) · 수동 ▶',
    steps: [
      { personaId: 'order-ops', action: '신규 주문 동기화·발주 트리아지 (Do)' },
      { personaId: 'inventory-ops', action: '도매↔쿠팡 재고 동기화·품절 자동중지 (Check)' },
      { personaId: 'listing-specialist', action: '승인대기·반려 상품 처리 (Act)' },
      { personaId: 'order-ops', action: '이상 주문·미발주 에스컬레이션' },
    ],
    output: '일일 운영 스윕 결과 · 이상 알림',
    kpis: ['소싱불가 주문(0)', '미발주(0)', '반려 잔여(↓)'],
    priority: 1,
    status: 'active',
    harness: 'coupang-daily-loop',
  },
  {
    id: 'daily-order-digest',
    name: '주문 ↔ 매입 다이제스트',
    emoji: '📦',
    accent: '#0E7490',
    objective: '들어온 주문이 도매 발주·송장까지 빠짐없이 이어졌는지 매일 점검하고 막힌 곳을 드러낸다.',
    area: '운영 · OTIF',
    frameworks: ['Order-to-Cash', 'OTIF(정시·완전 납품)'],
    cadence: 'daily',
    trigger: '매일 · 신규 주문 발생',
    steps: [
      { personaId: 'order-ops', action: '주문↔매입 매칭·송장 상태 집계' },
      { personaId: 'inventory-ops', action: '소싱불가(품절) 주문 플래그' },
      { personaId: 'seller-director', action: '처리 요약·우선 대응 지시' },
    ],
    output: '주문/매입 일일 다이제스트',
    kpis: ['매칭률', '송장 동기화율', '소싱불가 주문(0)'],
    priority: 1,
    status: 'active',
    harness: 'coupang-order-digest',
  },

  // ───────────── 매주 ─────────────
  {
    id: 'weekly-trend-digest',
    name: '주간 트렌드 위클리 다이제스트',
    emoji: '🔭',
    accent: '#7C3AED',
    objective: '매주 수요 신호를 스캔해 소싱·등록할 진입 후보 핀을 카테고리 전략에 맞춰 선별한다.',
    area: '발굴 · Acquisition',
    frameworks: ['Demand Sensing', 'Jobs-to-be-Done', 'Weak Signal 분석'],
    cadence: 'weekly',
    trigger: '매주 · 트렌드 수집 완료 후',
    steps: [
      { personaId: 'trend-scout', action: '트렌드 9종 + TV홈쇼핑 신호 스캔·정제' },
      { personaId: 'category-manager', action: '카테고리 적합성 필터(구색 정렬)' },
      { personaId: 'sourcing-buyer', action: '소싱가능·MSP 사전 점검' },
      { personaId: 'seller-director', action: '진입 후보 핀 채택', gate: true },
    ],
    output: '주간 트렌드 다이제스트 · 진입 후보 핀',
    kpis: ['후보 적중률', '핀→등록 전환', '발굴 리드타임'],
    priority: 1,
    status: 'active',
    harness: 'trend-weekly-digest',
  },
  {
    id: 'weekly-naver-seo-loop',
    name: '네이버 SEO 최적화 루프',
    emoji: '🔍',
    accent: '#16A34A',
    objective: '매주 검색 노출이 약한 SKU를 찾아 상품명·태그·카테고리를 규정 내에서 개정해 상위 노출을 만든다.',
    area: 'Acquisition · 검색',
    frameworks: ['마켓플레이스 SEO', 'Striking-distance', '4-eyes(maker-checker)'],
    cadence: 'weekly',
    trigger: '매주 · docs/naver-seo-plan.md 진행 상태 기준',
    steps: [
      { personaId: 'marketplace-seo', action: 'WIN/PAR/LOSE 진단·키워드 갭 분석' },
      { personaId: 'content-merchandiser', action: 'SEO 상품명·태그 개정안 작성' },
      { personaId: 'compliance-officer', action: '표시광고·금지문구 점검', gate: true },
      { personaId: 'marketplace-seo', action: '반영·표준카테고리 재배정·재측정' },
    ],
    output: '최적화된 상품명/태그 · 카테고리 재배정',
    kpis: ['검색 상위노출 수', 'WIN 비율', '유입 클릭(↑)'],
    priority: 1,
    status: 'active',
    harness: 'naver-seo-loop',
  },
  {
    id: 'weekly-price-competitiveness',
    name: '주간 가격경쟁력 진단',
    emoji: '💰',
    accent: '#0891B2',
    objective: '매주 경쟁가 대비 위치를 점검해 MSP 하한 안에서 전환을 살리는 리프라이싱을 한다.',
    area: 'Revenue · 가격',
    frameworks: ['경쟁 가격전략', '가격탄력성', 'MAP/MSP 하한'],
    cadence: 'weekly',
    trigger: '매주 · 경쟁가 변동 감지',
    steps: [
      { personaId: 'pricing-strategist', action: '경쟁가 스캔·WIN/PAR/LOSE 진단' },
      { personaId: 'margin-analyst', action: '리프라이싱 마진 영향 판독' },
      { personaId: 'pricing-strategist', action: 'MSP 하한 내 가격 조정(vendor-item)', gate: true },
    ],
    output: '가격경쟁력 리포트 · 가격 변경 기록',
    kpis: ['WIN 비율', 'MSP 위반(0)', '가격민감 SKU 전환율'],
    priority: 1,
    status: 'active',
    harness: 'naver-seo-ops(가격진단)',
  },

  // ───────────── 격주 ─────────────
  {
    id: 'sourcing-listing-cycle',
    name: '신규 소싱·등록 사이클',
    emoji: '🛒',
    accent: '#DB2777',
    objective: '채택 후보를 소싱→콘텐츠→컴플라이언스 게이트→등록→가격까지 한 사이클로 판매중 상태로 만든다.',
    area: '소싱·등록 · 4P',
    frameworks: ['전략적 소싱', '4P(Product/Price)', 'Maker-Checker(SoD)'],
    cadence: 'biweekly',
    trigger: '진입 후보 핀 누적 · 격주',
    steps: [
      { personaId: 'sourcing-buyer', action: '도매가·tiered MSP 확정·상세 이미지 확보' },
      { personaId: 'content-merchandiser', action: '상품명·썸네일·상세 제작' },
      { personaId: 'compliance-officer', action: '식품유형·고시·KC 게이트 판정', gate: true },
      { personaId: 'listing-specialist', action: '쿠팡/네이버 등록·승인요청' },
      { personaId: 'pricing-strategist', action: '초기가 책정(MSP 하한 준수)' },
    ],
    output: '판매중 신규 상품',
    kpis: ['후보→판매중 전환율', '등록 반려율(↓)', '사이클 리드타임'],
    priority: 1,
    status: 'active',
    harness: 'coupang-register-pipeline · upick-naver-register',
  },

  // ───────────── 매월 ─────────────
  {
    id: 'monthly-margin-audit',
    name: '월간 수익성·마진 감사',
    emoji: '📊',
    accent: '#9333EA',
    objective: '품목별 진짜 마진과 재고 효율을 감사해 밀 품목과 끊을 품목을 가른다.',
    area: 'Revenue · 재무',
    frameworks: ['GMROI(재고총이익률)', '기여이익', 'Unit Economics'],
    cadence: 'monthly',
    trigger: '매월 1회',
    steps: [
      { personaId: 'margin-analyst', action: 'SKU별 기여이익·GMROI·재고회전 감사' },
      { personaId: 'pricing-strategist', action: '저마진 리프라이싱 후보(MSP 검증)' },
      { personaId: 'seller-director', action: '단종/유지/강화 결정', gate: true },
    ],
    output: '마진 감사 리포트 · 단종/강화 리스트',
    kpis: ['평균 기여이익률', '적자 SKU 수(↓)', 'GMROI'],
    priority: 1,
    status: 'active',
    harness: 'audit-rates.mjs(참고)',
  },
  {
    id: 'monthly-category-review',
    name: '월간 카테고리 구색 리뷰',
    emoji: '🗂️',
    accent: '#A21CAF',
    objective: '카테고리별 역할·구색 갭을 점검해 진입/확장/축소를 결정한다.',
    area: '머천다이징',
    frameworks: ['카테고리 매니지먼트(ECR 8-step)', 'Assortment Planning'],
    cadence: 'monthly',
    trigger: '매월 1회',
    steps: [
      { personaId: 'category-manager', action: '카테고리 역할·구색 갭 진단(ECR)' },
      { personaId: 'trend-scout', action: '신규 수요 인풋' },
      { personaId: 'sourcing-buyer', action: '소싱 가능성·원가 확인' },
      { personaId: 'seller-director', action: '구색 추가/제거 결정', gate: true },
    ],
    output: '카테고리 구색 맵 · 진입/축소 결정',
    kpis: ['카테고리별 매출 기여', '구색 충실도', '카니발라이제이션(↓)'],
    priority: 2,
    status: 'active',
  },
  {
    id: 'monthly-seller-health',
    name: '셀러 헬스 종합 점검',
    emoji: '🩺',
    accent: '#7E22CE',
    objective: '운영·검색·마진·재고를 한 스코어카드로 종합해 사업 건강을 진단하고 다음 달 초점을 정한다.',
    area: '전사 · 운영 KPI',
    frameworks: ['Balanced Scorecard', '운영 KPI 대시보드'],
    cadence: 'monthly',
    trigger: '매월 1회 · 헬스 감사',
    steps: [
      { personaId: 'order-ops', action: '주문·이행 지표 점검' },
      { personaId: 'inventory-ops', action: '재고 정합성·동기화 커버리지 점검' },
      { personaId: 'marketplace-seo', action: '검색 노출·WIN 비율 점검' },
      { personaId: 'margin-analyst', action: '수익성 종합' },
      { personaId: 'seller-director', action: '스코어카드 종합·초점 결정', gate: true },
    ],
    output: '셀러 헬스 스코어카드 · 다음 달 초점',
    kpis: ['종합 헬스 점수', '지표 추세', '초점 달성률'],
    priority: 1,
    status: 'active',
    harness: 'seller-health-audit',
  },

  // ───────────── 분기 ─────────────
  {
    id: 'quarterly-seller-okr',
    name: '셀러 전략·OKR 정렬',
    emoji: '🧭',
    accent: '#4F46E5',
    objective: '직전 성과와 시장 기회를 근거로 집중 마켓·카테고리와 분기 OKR을 정하고 전 직무를 정렬한다.',
    area: '전사 · 경영',
    frameworks: ['OKR(Doerr)', '리테일 전략', '포터 가치사슬'],
    cadence: 'quarterly',
    trigger: '분기 시작 · 디렉터 소집',
    steps: [
      { personaId: 'margin-analyst', action: '직전 분기 손익·GMROI 베이스라인' },
      { personaId: 'trend-scout', action: '시장·수요 기회 인풋' },
      { personaId: 'category-manager', action: '카테고리 포트폴리오 제안' },
      { personaId: 'seller-director', action: '집중 마켓·카테고리·OKR 확정', gate: true },
    ],
    output: '분기 OKR · 우선순위 큐 · 소싱 로드맵',
    kpis: ['OKR 달성률', '순이익', '집중도'],
    priority: 1,
    status: 'active',
  },

  // ───────────── 상시(트리거) ─────────────
  {
    id: 'stockout-autostop',
    name: '품절 자동중지 관제',
    emoji: '🛑',
    accent: '#475569',
    objective: '도매 품절을 감지하는 즉시 판매중지로 소싱불가 주문 유입을 차단한다.',
    area: '운영 · 가용성',
    frameworks: ['품절 예방', 'Safety Stock', 'Andon(이상 즉시 정지)'],
    cadence: 'triggered',
    trigger: 'ggsan/도매처 품절 감지(매시간 sync)',
    steps: [
      { personaId: 'inventory-ops', action: '품절 감지·매칭행 확인' },
      { personaId: 'listing-specialist', action: '쿠팡/네이버 판매중지' },
      { personaId: 'sourcing-buyer', action: '대체 소싱 검토', gate: true },
    ],
    output: '판매중지 처리 · 대체 소싱안',
    kpis: ['품절 반영 지연(↓)', '소싱불가 주문(0)', '대체 소싱 리드타임'],
    priority: 1,
    status: 'active',
    harness: 'ops-sweep',
  },
  {
    id: 'trend-entry-validation',
    name: '신규 트렌드 진입 검증',
    emoji: '🎯',
    accent: '#64748B',
    objective: '점화된 트렌드 시드가 우리 구조에서 마진이 나는지 검증하고 진입을 결정한다.',
    area: '발굴 · Unit Economics 게이트',
    frameworks: ['Jobs-to-be-Done', 'Unit Economics', 'Go/No-Go 게이트'],
    cadence: 'triggered',
    trigger: '트렌드 시드 시그널 / 핀 도착',
    steps: [
      { personaId: 'trend-scout', action: '시그널 정리·수요 근거' },
      { personaId: 'sourcing-buyer', action: '도매가 확보' },
      { personaId: 'margin-analyst', action: '마진 성립 검증', gate: true },
      { personaId: 'seller-director', action: '진입/보류 결정' },
    ],
    output: '진입 검증 리포트 · Go/No-Go',
    kpis: ['검증 정확도', '진입→흑자 비율', '검증 리드타임'],
    priority: 2,
    status: 'active',
  },
  {
    id: 'invoice-sync',
    name: '송장 동기화 관제',
    emoji: '🚚',
    accent: '#334155',
    objective: '매시간 도매 송장을 감지해 쿠팡에 등록하고 배송 이슈를 조기에 잡는다.',
    area: '운영 · Order-to-Cash 후속',
    frameworks: ['Order-to-Cash', 'OTIF'],
    cadence: 'triggered',
    trigger: '매시간 ggsan 송장 감지',
    steps: [
      { personaId: 'order-ops', action: '송장 감지·쿠팡 등록' },
      { personaId: 'cs-manager', action: '배송 이슈 모니터' },
    ],
    output: '송장 동기화 결과',
    kpis: ['송장 동기화율', '배송 지연 감지', '클레임(↓)'],
    priority: 2,
    status: 'active',
    harness: 'ggsan-coupang-invoice-sync(Phase2 예정)',
  },

  // ───────────── 프로젝트 ─────────────
  {
    id: 'naver-market-expansion',
    name: '네이버 마켓 진출',
    emoji: '🟢',
    accent: '#2563EB',
    objective: '유픽 소싱 라인을 네이버 스마트스토어(몸에조은가게)로 확장해 멀티마켓 매출을 만든다.',
    area: '채널 확장 · 4P-Place',
    frameworks: ['Market Entry', '4P(Place)', '멀티마켓 운영'],
    cadence: 'project',
    trigger: '진출 목표 설정(진행 중)',
    steps: [
      { personaId: 'seller-director', action: '진출 목표·범위 설정' },
      { personaId: 'category-manager', action: '진출 구색 선정' },
      { personaId: 'listing-specialist', action: '유픽→네이버 등록' },
      { personaId: 'marketplace-seo', action: 'SEO·배너·카테고리 셋업' },
    ],
    output: '네이버 스토어 라인업 · SEO 셋업',
    kpis: ['네이버 등록 수', '검색 노출', '네이버 매출 비중'],
    priority: 2,
    status: 'active',
    harness: 'upick-naver-register · naver-seo-ops',
  },
  {
    id: 'health-supplement-entry',
    name: '건기식 카테고리 진입',
    emoji: '💊',
    accent: '#1D4ED8',
    objective: '판매업신고·고시13항목 게이트를 통과해 마진 여지가 있는 건기식 카테고리에 진입한다.',
    area: '카테고리 확장 · Compliance 게이트',
    frameworks: ['Make-or-Buy', 'GRC(컴플라이언스 게이트)', 'Unit Economics'],
    cadence: 'project',
    trigger: '건기식 진입 검토',
    steps: [
      { personaId: 'compliance-officer', action: 'Wing 판매업신고·고시13항목 게이트', gate: true },
      { personaId: 'sourcing-buyer', action: '건기식 도매 소싱·MSP 확보' },
      { personaId: 'margin-analyst', action: '마진 성립 검증', gate: true },
      { personaId: 'listing-specialist', action: '카테고리 73137 등록' },
    ],
    output: '건기식 라인업(컴플라이언스 통과)',
    kpis: ['게이트 통과', '건기식 흑자 SKU', '제재(0)'],
    priority: 3,
    status: 'planned',
    harness: 'coupang_food_type_pattern(참고)',
  },
]

export function scenarioById(id: string): Scenario | undefined {
  return SCENARIOS.find((s) => s.id === id)
}

export function scenariosByCadence(cadence: Cadence): Scenario[] {
  return SCENARIOS.filter((s) => s.cadence === cadence)
}
