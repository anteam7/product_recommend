// ────────────────────────────────────────────────────────────
// 상표권 게이트용 브랜드 토큰 화이트리스트 (룰 기반 1차 탐지)
// ────────────────────────────────────────────────────────────
// classify-trends-llm 의 'generic | brand_mention | likely_counterfeit' 라벨이
// 아직 부여되지 않았거나, alias/title 칩에서 위험 토큰을 시각적으로 강조할 때 쓰는
// 보수적 화이트리스트. LLM 라벨이 최종 판정이고, 이건 근거 하이라이트용.
//
// 카테고리: 글로벌 유명 브랜드 + 캐릭터/IP + 한국 셀러가 자주 침해하는 키워드.
// 소문자/한글 그대로 비교 (대소문자 무시 매칭은 detectBrandTokens 에서 처리).

export const BRAND_TOKENS: { token: string; kind: 'brand' | 'character' | 'design' }[] = [
  // 글로벌 가전·디지털 브랜드
  { token: 'apple', kind: 'brand' },
  { token: '애플', kind: 'brand' },
  { token: 'airpods', kind: 'brand' },
  { token: '에어팟', kind: 'brand' },
  { token: 'iphone', kind: 'brand' },
  { token: '아이폰', kind: 'brand' },
  { token: 'samsung', kind: 'brand' },
  { token: '삼성', kind: 'brand' },
  { token: 'galaxy', kind: 'brand' },
  { token: '갤럭시', kind: 'brand' },
  { token: 'xiaomi', kind: 'brand' },
  { token: '샤오미', kind: 'brand' },
  { token: 'sony', kind: 'brand' },
  { token: '소니', kind: 'brand' },
  { token: 'dyson', kind: 'brand' },
  { token: '다이슨', kind: 'brand' },
  { token: 'anker', kind: 'brand' },
  { token: '앵커', kind: 'brand' },
  { token: 'bose', kind: 'brand' },
  { token: 'jbl', kind: 'brand' },
  { token: 'logitech', kind: 'brand' },
  { token: '로지텍', kind: 'brand' },

  // 패션·잡화 럭셔리
  { token: 'nike', kind: 'brand' },
  { token: '나이키', kind: 'brand' },
  { token: 'adidas', kind: 'brand' },
  { token: '아디다스', kind: 'brand' },
  { token: 'gucci', kind: 'brand' },
  { token: '구찌', kind: 'brand' },
  { token: 'chanel', kind: 'brand' },
  { token: '샤넬', kind: 'brand' },
  { token: 'louis vuitton', kind: 'brand' },
  { token: '루이비통', kind: 'brand' },
  { token: 'prada', kind: 'brand' },
  { token: '프라다', kind: 'brand' },
  { token: 'crocs', kind: 'brand' },
  { token: '크록스', kind: 'brand' },
  { token: 'lululemon', kind: 'brand' },
  { token: '룰루레몬', kind: 'brand' },
  { token: 'stanley', kind: 'brand' },
  { token: '스탠리', kind: 'brand' },

  // 캐릭터 / IP
  { token: 'disney', kind: 'character' },
  { token: '디즈니', kind: 'character' },
  { token: 'pokemon', kind: 'character' },
  { token: '포켓몬', kind: 'character' },
  { token: 'sanrio', kind: 'character' },
  { token: '산리오', kind: 'character' },
  { token: 'hello kitty', kind: 'character' },
  { token: '헬로키티', kind: 'character' },
  { token: '짱구', kind: 'character' },
  { token: '카카오프렌즈', kind: 'character' },
  { token: '라이언', kind: 'character' },
  { token: 'lego', kind: 'brand' },
  { token: '레고', kind: 'brand' },
  { token: 'marvel', kind: 'character' },
  { token: '마블', kind: 'character' },

  // 침해 위험 시그널 키워드 (정품 사칭류)
  { token: '정품', kind: 'design' },
  { token: '레플리카', kind: 'design' },
  { token: 'replica', kind: 'design' },
  { token: '미러급', kind: 'design' },
  { token: 's급', kind: 'design' },
  { token: '호환', kind: 'design' },
]

export interface DetectedToken {
  token: string
  kind: 'brand' | 'character' | 'design'
}

/** 문자열에서 화이트리스트 브랜드 토큰을 (대소문자 무시) 탐지 */
export function detectBrandTokens(text: string | null | undefined): DetectedToken[] {
  if (!text) return []
  const hay = text.toLowerCase()
  const hits: DetectedToken[] = []
  for (const b of BRAND_TOKENS) {
    if (hay.includes(b.token.toLowerCase())) {
      hits.push({ token: b.token, kind: b.kind })
    }
  }
  return hits
}
