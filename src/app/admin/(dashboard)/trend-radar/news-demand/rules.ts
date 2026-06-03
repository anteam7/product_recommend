// 뉴스 → 돌발 수요 토픽 매핑 룰.
// 돌발 뉴스(한파·폭염·미세먼지·감염병·리콜·품귀·정책변경)를 소비 카테고리와
// ggsan 소싱 카테고리 코드로 번역한다. LLM 추출(후속 Phase)의 seed/검증 기준이기도 함.
//
// ggsan 카테고리 코드는 recommend 페이지(CATEGORIES)와 동일 — 매핑 후보를
// /admin/trend-radar/recommend?cate=<code> 로 바로 점프시킨다.

export type NewsTopic = {
  key: string
  label: string
  signalType: 'topic' | 'gov_notice'
  // 뉴스 원문(title/metadata.description)에서 이 토픽으로 판정하는 키워드(부분일치, 소문자 비교)
  newsKeywords: string[]
  // search/community 반응 교차판정에 쓰는 수요측 키워드(소비자가 칠 법한 검색어)
  demandKeywords: string[]
  impactedCategories: string[]   // 사람이 읽는 소비 카테고리
  ggsanCateCodes: string[]       // recommend 점프용 ggsan 코드 (비면 일반 소싱)
  baseUrgency: 'critical' | 'high' | 'watch'
  note?: string
}

export const NEWS_TOPICS: NewsTopic[] = [
  {
    key: 'cold_wave',
    label: '한파·강추위',
    signalType: 'topic',
    newsKeywords: ['한파', '강추위', '영하', '폭설', '대설', '결빙', '한랭', '체감온도'],
    demandKeywords: ['방한', '핫팩', '손난로', '내복', '히터', '난방', '온수매트', '기모'],
    impactedCategories: ['방한용품', '난방가전', '핫팩/손난로', '보온의류'],
    ggsanCateCodes: [],
    baseUrgency: 'high',
    note: '한파 보도→방한/난방 수요. 위탁 선점 골든타임은 검색 급증 직전.',
  },
  {
    key: 'heat_wave',
    label: '폭염·열대야',
    signalType: 'topic',
    newsKeywords: ['폭염', '열대야', '불볕', '온열질환', '폭염특보', '역대급 더위', '찜통'],
    demandKeywords: ['선풍기', '서큘레이터', '쿨매트', '아이스', '냉감', '제습', '에어컨'],
    impactedCategories: ['냉방가전', '쿨링용품', '제습용품', '냉감의류'],
    ggsanCateCodes: [],
    baseUrgency: 'high',
  },
  {
    key: 'fine_dust',
    label: '미세먼지·황사',
    signalType: 'topic',
    newsKeywords: ['미세먼지', '초미세먼지', '황사', '대기질', '미세먼지 비상', '나쁨', 'pm2.5', 'pm10'],
    demandKeywords: ['마스크', '공기청정기', '필터', 'kf94', '환기', '청정기 필터'],
    impactedCategories: ['마스크', '공기청정기/필터', '호흡기 보호'],
    ggsanCateCodes: [],
    baseUrgency: 'critical',
    note: '미세먼지→마스크/청정기 필터. 당일 폭발, lead 잡으면 위탁 즉시.',
  },
  {
    key: 'infectious',
    label: '감염병·독감·식중독',
    signalType: 'topic',
    newsKeywords: ['독감', '인플루엔자', '감염병', '노로바이러스', '식중독', '집단감염', '유행', '확진', '코로나'],
    demandKeywords: ['손소독제', '위생', '마스크', '체온계', '소독', '비타민', '면역', '유산균'],
    impactedCategories: ['위생용품', '손소독/소독', '면역 건기식'],
    ggsanCateCodes: ['007', '001'], // 면역건강, 장건강
    baseUrgency: 'high',
    note: '식중독/감염병 보도→위생용품 + 면역·유산균 건기식(ggsan 소싱가능).',
  },
  {
    key: 'recall',
    label: '리콜·회수·품질이슈',
    signalType: 'gov_notice',
    newsKeywords: ['리콜', '회수', '판매중지', '부적합', '검출', '회수명령', '안전성', '결함'],
    demandKeywords: ['대체', '안전', '인증', '국산', '믿을만한'],
    impactedCategories: ['대체 수요(리콜 반사이익)'],
    ggsanCateCodes: [],
    baseUrgency: 'high',
    note: '특정 제품 리콜→경쟁/대체 상품 반사 수요. 카테고리 식별 필요.',
  },
  {
    key: 'shortage',
    label: '품귀·공급차질 보도',
    signalType: 'topic',
    newsKeywords: ['품귀', '품절대란', '공급차질', '사재기', '대란', '구하기 어려운', '물량 부족', '가격 급등'],
    demandKeywords: ['대체', '재고', '구매', '예약', '입고'],
    impactedCategories: ['품귀 반사 수요'],
    ggsanCateCodes: [],
    baseUrgency: 'critical',
    note: '품귀 보도 자체가 추가 사재기를 유발 — 재고 확보 즉시성 최상.',
  },
  {
    key: 'gov_policy',
    label: '정책변경·고시·지원',
    signalType: 'gov_notice',
    newsKeywords: ['고시', '시행', '의무화', '지원금', '보조금', '규제', '인증 의무', '법 개정', '바우처'],
    demandKeywords: ['신청', '대상', '의무', '인증', '구매'],
    impactedCategories: ['정책 연동 수요(의무화/지원)'],
    ggsanCateCodes: [],
    baseUrgency: 'watch',
    note: '정책 시행일이 D-day. 의무화/지원금→관련 상품 수요 단계적 발생.',
  },
]

export const URGENCY_RANK: Record<string, number> = { critical: 0, high: 1, watch: 2 }
