/**
 * 검색 수식어 인텐트 트리 — Query Modifier Intent Map
 *
 * google_suggest 자동완성 완성어(title)에서 시드(query)를 차감해
 * 앞/뒤 수식어 토큰을 추출하고, 규칙 렉시콘으로 인텐트 단계를 분류한다.
 *
 * 인텐트 단계:
 *  - info        정보탐색 (효능·원리·방법·후기)
 *  - compare     비교 (추천·순위·vs·브랜드·차이)
 *  - transaction 거래 (최저가·정품·구매·할인·직구)
 *  - spec        사양/옵션 (무선·소형·대용량 등)
 *  - risk        우려/리스크 (가짜·논란·리콜·부작용)
 *  - other       미분류
 *
 * 추가 수집 없이 이미 적재된 jimscanner_market_raw(source='google_suggest')를 가치화.
 */

export type IntentStage =
  | 'info'
  | 'compare'
  | 'transaction'
  | 'spec'
  | 'risk'
  | 'other'

export const INTENT_META: Record<
  IntentStage,
  { label: string; emoji: string; color: string }
> = {
  info: { label: '정보탐색', emoji: '📖', color: 'bg-sky-100 text-sky-700' },
  compare: { label: '비교', emoji: '⚖️', color: 'bg-violet-100 text-violet-700' },
  transaction: { label: '거래', emoji: '🛒', color: 'bg-emerald-100 text-emerald-700' },
  spec: { label: '사양', emoji: '🔧', color: 'bg-amber-100 text-amber-700' },
  risk: { label: '우려', emoji: '⚠️', color: 'bg-rose-100 text-rose-700' },
  other: { label: '기타', emoji: '·', color: 'bg-gray-100 text-gray-500' },
}

/**
 * 규칙 렉시콘. 위에서부터 먼저 매칭되는 단계로 분류.
 * (risk 를 가장 먼저 둬서 '부작용·가짜' 가 info 로 새지 않게 한다.)
 */
const LEXICON: { stage: IntentStage; terms: string[] }[] = [
  {
    stage: 'risk',
    terms: [
      '가짜', '짝퉁', '논란', '리콜', '부작용', '사기', '불량', '위험',
      '위해', '환불', '반품', '하자', '고장', '품절', '단종', '주의',
      '경고', '독성', '발암', '오염', '클레임',
    ],
  },
  {
    stage: 'transaction',
    terms: [
      '최저가', '정품', '구매', '할인', '직구', '가격', '쿠폰', '특가',
      '세일', '할인코드', '무료배송', '배송', '구입', '사는곳', '판매처',
      '주문', '예약', '재입고', '득템', '핫딜', '면세', '도매', '병행수입',
    ],
  },
  {
    stage: 'compare',
    terms: [
      '추천', '순위', '비교', '차이', '베스트', 'best', 'top', 'vs',
      '브랜드', '대안', '대체', '인기', '랭킹', '뭐가', '어떤', '종류',
    ],
  },
  {
    stage: 'spec',
    terms: [
      '무선', '유선', '소형', '대형', '미니', '대용량', '고용량', '소용량',
      '휴대용', '충전식', '방수', '경량', '초경량', '접이식', '인용', '구',
      '리터', '인치', 'ml', 'l', 'kg', 'g', '사이즈', '용량', '색상',
      '컬러', '세트', '리필', '대형견', '소형견', '남성용', '여성용', '키즈',
    ],
  },
  {
    stage: 'info',
    terms: [
      '효능', '효과', '원리', '방법', '뜻', '후기', '사용법', '성분',
      '복용법', '복용', '먹는법', '효과있나', '리뷰', '느낌', '경험',
      '정보', '스펙', '설명', '특징', '장점', '단점', '비교후기', '사용기',
    ],
  },
]

/** 토큰 하나를 인텐트 단계로 분류 (substring 매칭). */
export function classifyModifierToken(token: string): IntentStage {
  const t = token.toLowerCase().trim()
  if (!t) return 'other'
  for (const { stage, terms } of LEXICON) {
    for (const term of terms) {
      if (t.includes(term.toLowerCase())) return stage
    }
  }
  return 'other'
}

/**
 * 완성어(title)에서 시드(query)를 차감해 앞/뒤 수식어 토큰을 추출.
 * 시드가 완성어에 정확히 포함되지 않으면, 시드의 각 어절을 제거하는 방식으로 폴백.
 */
export function extractModifiers(seed: string, title: string): {
  prefix: string[]
  suffix: string[]
  all: string[]
} {
  const cleanTitle = title.trim().replace(/\s+/g, ' ')
  const cleanSeed = seed.trim().replace(/\s+/g, ' ')

  let prefixRaw = ''
  let suffixRaw = ''

  const idx = cleanTitle.indexOf(cleanSeed)
  if (idx >= 0) {
    prefixRaw = cleanTitle.slice(0, idx)
    suffixRaw = cleanTitle.slice(idx + cleanSeed.length)
  } else {
    // 폴백: 시드의 각 어절을 제거하고 남은 것을 suffix 로 취급
    let remain = cleanTitle
    for (const w of cleanSeed.split(' ')) {
      if (!w) continue
      remain = remain.split(w).join(' ')
    }
    suffixRaw = remain
  }

  const tokenize = (s: string) =>
    s
      .split(/[\s,/·]+/)
      .map((x) => x.trim())
      .filter((x) => x.length > 0)

  const prefix = tokenize(prefixRaw)
  const suffix = tokenize(suffixRaw)
  return { prefix, suffix, all: [...prefix, ...suffix] }
}

export interface ModifierStat {
  modifier: string
  stage: IntentStage
  count: number
  position: 'prefix' | 'suffix'
}

export interface SeedIntentSummary {
  seed: string
  total: number // 분석에 사용한 완성어 수
  modifierCount: number // 추출된 수식어 토큰 총수
  byStage: Record<IntentStage, number> // 단계별 토큰 수
  transactionRatio: number // 거래 인텐트 비중 (0~1)
  riskModifiers: string[] // 우려 수식어 (중복 제거)
  specModifiers: string[] // 핵심 사양 수식어 (상위)
  topModifiers: ModifierStat[] // 상위 수식어 (선버스트/트리맵용)
}

const EMPTY_STAGES: Record<IntentStage, number> = {
  info: 0,
  compare: 0,
  transaction: 0,
  spec: 0,
  risk: 0,
  other: 0,
}

/** google_suggest raw row 들을 시드별 인텐트 요약으로 집계. */
export function summarizeSeeds(
  rows: { query: string | null; title: string | null }[],
): SeedIntentSummary[] {
  const bySeed = new Map<
    string,
    { titles: Set<string>; mods: Map<string, ModifierStat> }
  >()

  for (const r of rows) {
    const seed = (r.query ?? '').trim()
    const title = (r.title ?? '').trim()
    if (!seed || !title) continue
    if (!bySeed.has(seed)) bySeed.set(seed, { titles: new Set(), mods: new Map() })
    const bucket = bySeed.get(seed)!
    bucket.titles.add(title)

    const { prefix, suffix } = extractModifiers(seed, title)
    const record = (token: string, position: 'prefix' | 'suffix') => {
      const key = `${token}::${position}`
      const stage = classifyModifierToken(token)
      const existing = bucket.mods.get(key)
      if (existing) existing.count += 1
      else bucket.mods.set(key, { modifier: token, stage, count: 1, position })
    }
    prefix.forEach((t) => record(t, 'prefix'))
    suffix.forEach((t) => record(t, 'suffix'))
  }

  const out: SeedIntentSummary[] = []
  for (const [seed, { titles, mods }] of bySeed) {
    const stats = [...mods.values()].sort((a, b) => b.count - a.count)
    const byStage = { ...EMPTY_STAGES }
    let modifierCount = 0
    for (const s of stats) {
      byStage[s.stage] += s.count
      modifierCount += s.count
    }
    const transactionRatio = modifierCount > 0 ? byStage.transaction / modifierCount : 0
    const riskModifiers = [
      ...new Set(stats.filter((s) => s.stage === 'risk').map((s) => s.modifier)),
    ]
    const specModifiers = [
      ...new Set(stats.filter((s) => s.stage === 'spec').map((s) => s.modifier)),
    ].slice(0, 8)

    out.push({
      seed,
      total: titles.size,
      modifierCount,
      byStage,
      transactionRatio,
      riskModifiers,
      specModifiers,
      topModifiers: stats.slice(0, 12),
    })
  }

  // 거래 비중 높은 시드 우선, 동률이면 수식어 많은 순
  out.sort((a, b) => b.transactionRatio - a.transactionRatio || b.modifierCount - a.modifierCount)
  return out
}

/**
 * 임의의 키워드 묶음(예: 상품 alias)을 인텐트 단계로 분류한 칩 데이터.
 * products/[id] · ggsan recommend 에서 '인텐트 구성' 칩으로 재사용.
 */
export function classifyKeywords(keywords: string[]): {
  byStage: Record<IntentStage, number>
  chips: { modifier: string; stage: IntentStage }[]
} {
  const byStage = { ...EMPTY_STAGES }
  const seen = new Set<string>()
  const chips: { modifier: string; stage: IntentStage }[] = []
  for (const kw of keywords) {
    for (const token of kw.split(/[\s,/·]+/)) {
      const t = token.trim()
      if (!t || seen.has(t)) continue
      seen.add(t)
      const stage = classifyModifierToken(t)
      if (stage === 'other') continue
      byStage[stage] += 1
      chips.push({ modifier: t, stage })
    }
  }
  return { byStage, chips }
}
