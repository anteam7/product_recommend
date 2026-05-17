/**
 * Listing Studio rule_engine_v1 — 결정론적 템플릿 기반 SEO 상세 초안 생성.
 *
 * 후속 PR 에서 ANTHROPIC_API_KEY 등록 후 LLM 호출로 스왑할 수 있도록
 * 입력 컨텍스트를 명시적 인자로 묶어 export.
 *
 * 입력:
 *  - product (canonical_name, brand, category_top/mid, intent_label, description)
 *  - aliases (검색 키워드 N-gram 풀)
 *  - latestScore (final/trend/commerce/supplier/competition)
 *  - suppliers (도매 정보 — 가격/MOQ/리드타임/이미지)
 *
 * 출력:
 *  - drafts: { kind, content_md }[] (5종)
 *      title_short:  ≤40자 SEO 제목 후보 5개 (줄바꿈)
 *      title_long:   ≤100자 상세 제목 후보 5개 (줄바꿈)
 *      tags:         태그/카테고리 매핑 (줄바꿈)
 *      detail_md:    상세 마크다운 초안 (페르소나·차별점·FAQ 포함)
 *      thumb_hook:   썸네일 카피 후크 3개 (줄바꿈)
 *  - snapshot: jsonb 로 저장될 컨텍스트 스냅샷
 */

type Alias = { alias: string; alias_type: string; source: string | null; confidence: number }
type Score = {
  trend_score: number
  commerce_score: number
  supplier_score: number
  competition_score: number
  final_score: number
  score_components: any
  computed_at: string
}
type Supplier = {
  supplier_source: string
  title: string | null
  price_krw: number | null
  moq: number | null
  lead_time_days: number | null
  url_image: string | null
  supplier_url: string | null
}
type Product = {
  id: string
  canonical_name: string
  brand: string | null
  category_top: string
  category_mid: string | null
  intent_label: string | null
  description: string | null
}

export interface ListingStudioInput {
  product: Product
  aliases: Alias[]
  latestScore: Score | null
  suppliers: Supplier[]
}

export interface ListingDraft {
  kind: 'title_short' | 'title_long' | 'tags' | 'detail_md' | 'thumb_hook'
  content_md: string
}

export interface ListingStudioResult {
  drafts: ListingDraft[]
  snapshot: Record<string, unknown>
}

const PERSONA_BY_INTENT: Record<string, string> = {
  예방건강: '평소 컨디션 관리에 신경 쓰는 30-50대 직장인·주부',
  문제해결: '특정 불편함(피로·수면·관절 등)을 해결하고 싶은 30-60대',
  소모품: '주기적으로 재구매하는 1-2인 가구·자취생',
  편의: '시간 절약·간편함을 우선시하는 1인 가구',
  취미: '관심사에 적극 투자하는 20-40대',
}

const PERSONA_BY_CATEGORY: Record<string, string> = {
  health: '건강·예방·자기관리를 우선하는 30대 이상',
  living: '실용성과 가성비를 중시하는 1-2인 가구',
  digital: '얼리어답터·기기 활용도가 높은 20-30대',
  other: '취향 기반 합리적 소비층',
}

function clampLen(s: string, n: number): string {
  if (s.length <= n) return s
  return s.slice(0, Math.max(0, n - 1)).trimEnd() + '…'
}

function extractKeywordPool(aliases: Alias[], canonical: string, brand: string | null): string[] {
  const pool = new Set<string>()
  pool.add(canonical)
  if (brand) pool.add(brand)
  for (const a of aliases) {
    if (!a.alias) continue
    const t = a.alias.trim()
    if (t.length < 2 || t.length > 30) continue
    pool.add(t)
  }
  return Array.from(pool)
}

function ngramTokens(strings: string[]): string[] {
  const counts = new Map<string, number>()
  for (const s of strings) {
    const tokens = s
      .split(/[\s\-_/·&,()]+/)
      .map((t) => t.trim())
      .filter((t) => t.length >= 2 && t.length <= 14)
    for (const tk of tokens) {
      counts.set(tk, (counts.get(tk) ?? 0) + 1)
    }
  }
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([k]) => k)
}

function categoryLabel(top: string, mid: string | null): string {
  const map: Record<string, string> = { health: '건강기능식품', living: '생활/잡화', digital: '디지털/가전', other: '기타' }
  const t = map[top] ?? top
  return mid ? `${t} > ${mid}` : t
}

function median(nums: number[]): number | null {
  const xs = nums.filter((n) => Number.isFinite(n)).sort((a, b) => a - b)
  if (xs.length === 0) return null
  const mid = Math.floor(xs.length / 2)
  return xs.length % 2 ? xs[mid] : Math.round((xs[mid - 1] + xs[mid]) / 2)
}

export function buildListingDrafts(input: ListingStudioInput): ListingStudioResult {
  const { product, aliases, latestScore, suppliers } = input
  const canonical = product.canonical_name
  const brand = product.brand
  const intent = product.intent_label ?? ''
  const persona =
    (intent && PERSONA_BY_INTENT[intent]) ||
    PERSONA_BY_CATEGORY[product.category_top] ||
    '실용적인 합리적 소비층'

  const pool = extractKeywordPool(aliases, canonical, brand)
  const topNgram = ngramTokens(pool).slice(0, 10)
  const supplierMedianKrw = median(
    suppliers.map((s) => s.price_krw ?? Number.NaN) as number[],
  )
  const minLead = suppliers
    .map((s) => s.lead_time_days)
    .filter((n): n is number => typeof n === 'number')
    .sort((a, b) => a - b)[0]
  const minMoq = suppliers
    .map((s) => s.moq)
    .filter((n): n is number => typeof n === 'number')
    .sort((a, b) => a - b)[0]

  // ── 제목 후보 (40자 / 100자)
  const headBrand = brand ? `${brand} ` : ''
  const tail40 = topNgram.filter((t) => t !== canonical && t !== brand).slice(0, 3)

  const shortTitles: string[] = [
    `${headBrand}${canonical} 정품 무료배송`,
    `${canonical} ${brand ? brand + ' ' : ''}당일발송 ${intent || '추천'}`,
    `${headBrand}${canonical} ${tail40[0] ?? '베스트'} 1+1`,
    `${canonical} ${tail40[1] ?? topNgram[0] ?? ''} 가성비 ${product.category_top === 'health' ? '건강' : '추천'}`,
    `${headBrand}${canonical} ${tail40[2] ?? '신상'} 리뷰 ${suppliers.length > 0 ? '검증' : '추천'}`,
  ].map((t) => clampLen(t.replace(/\s+/g, ' ').trim(), 40))

  const longTitles: string[] = [
    `${headBrand}${canonical} | ${persona}를 위한 ${intent || '엄선'} 추천 · 정품/당일발송/안심 A/S`,
    `[공식 정품] ${headBrand}${canonical} ${tail40[0] ?? ''} ${tail40[1] ?? ''} - ${categoryLabel(product.category_top, product.category_mid)} 베스트셀러`,
    `${canonical} ${brand ? '(' + brand + ')' : ''} 사용 후기 ${aliases.length}건 · ${topNgram.slice(0, 4).join(' ')} 한 번에 해결`,
    `${headBrand}${canonical} 최저가 도전 / ${supplierMedianKrw ? '시장가 대비 합리적' : '가성비 우수'} · 무료배송 · 빠른배송`,
    `${headBrand}${canonical} ${intent || '맞춤'} - ${persona} 후기 다수, ${product.description ?? '믿고 쓰는 베스트셀러'}`,
  ].map((t) => clampLen(t.replace(/\s+/g, ' ').trim(), 100))

  // ── 태그 / 카테고리
  const tagLines = [
    `# 카테고리 매핑`,
    `- 스마트스토어 1차: ${categoryLabel(product.category_top, product.category_mid)}`,
    `- 인텐트: ${intent || '미분류'}`,
    ``,
    `# 키워드 태그 (검색 N-gram 기반, 우선순위순)`,
    ...topNgram.slice(0, 15).map((t) => `- ${t}`),
    ``,
    `# 검색 의도 보조 키워드`,
    `- ${canonical} 추천`,
    `- ${canonical} 가격`,
    `- ${canonical} 후기`,
    brand ? `- ${brand} ${canonical}` : `- ${canonical} 정품`,
    `- ${canonical} ${intent || '베스트'}`,
  ].join('\n')

  // ── 상세 마크다운
  const supplierBlock = suppliers.length
    ? suppliers
        .slice(0, 5)
        .map(
          (s) =>
            `- **${s.supplier_source}** · ${s.title ?? '제목 미수집'} · ${s.price_krw ? '₩' + s.price_krw.toLocaleString() : '가격 미수집'}` +
            (s.moq ? ` · MOQ ${s.moq}` : '') +
            (s.lead_time_days ? ` · 리드타임 ${s.lead_time_days}일` : ''),
        )
        .join('\n')
    : '- (도매 수집 데이터 없음 — supplier collector 가동 필요)'

  const scoreLine = latestScore
    ? `최근 종합 점수 ${latestScore.final_score}점 (트렌드 ${latestScore.trend_score} · 커머스 ${latestScore.commerce_score} · 공급 ${latestScore.supplier_score} · 경쟁 ${latestScore.competition_score})`
    : '점수 데이터 없음'

  const detail = [
    `# ${headBrand}${canonical} — ${intent || '추천'} 상세`,
    ``,
    `> ${product.description ?? canonical + ' 관련 상세 설명을 여기에 작성.'}`,
    ``,
    `**타깃 페르소나**: ${persona}`,
    ``,
    `## 왜 이 상품인가`,
    `- ${canonical} 시장에서 ${aliases.length}개 alias 가 한 상품으로 수렴 — 인지도 검증 완료`,
    `- ${scoreLine}`,
    supplierMedianKrw ? `- 도매가 중앙값 ₩${supplierMedianKrw.toLocaleString()} 기준 합리적 마진 가능` : `- 다중 도매처 견적 비교 진행 중`,
    minLead ? `- 최단 리드타임 ${minLead}일 — 빠른 입고 가능` : `- 입고 리드타임 협의 가능`,
    minMoq ? `- 최소 발주수량 ${minMoq}개부터` : ``,
    ``,
    `## 핵심 차별점`,
    `1. **${intent || '검증된'} 카테고리** — ${categoryLabel(product.category_top, product.category_mid)} 내 핀 등록 상품으로 트렌드 신호 확인`,
    `2. **검색의도 정합** — ${topNgram.slice(0, 3).join(' / ')} 키워드 노출 최적화`,
    `3. **공급 안정성** — ${suppliers.length}개 도매 공급원 매칭${suppliers.length > 1 ? ' (이중화 가능)' : ''}`,
    ``,
    `## 이런 분께 추천`,
    `- ${persona}`,
    `- ${intent ? intent + ' 목적' : '구체적 사용 시나리오가 있는 분'}`,
    `- ${canonical} 를 처음 시도하거나 재구매 주기에 도달한 고객`,
    ``,
    `## 자주 묻는 질문 (FAQ)`,
    `**Q. ${canonical} 처음인데 어떻게 사용하나요?**  `,
    `A. 상세 페이지 사용법 섹션을 참고해주세요. (운영자가 보충)`,
    ``,
    `**Q. 정품 맞나요?**  `,
    `A. ${brand ? brand + ' 공식 유통' : '신뢰할 수 있는 도매처'}를 통해 입고된 정품입니다.`,
    ``,
    `**Q. 배송 얼마나 걸리나요?**  `,
    `A. ${minLead ? '평균 ' + minLead + '일 이내' : '영업일 기준 2-5일'} 발송됩니다.`,
    ``,
    `**Q. 교환·환불 가능한가요?**  `,
    `A. 단순 변심 7일, 상품 하자 30일 이내 가능합니다.`,
    ``,
    `## 도매 공급 메타 (운영자 전용 / 상세 미노출)`,
    supplierBlock,
  ]
    .filter(Boolean)
    .join('\n')

  // ── 썸네일 카피 후크 3개
  const thumbHooks = [
    `${intent || '확실한'} ${canonical}, 지금이 기회`,
    brand
      ? `${brand} 정품 ${canonical} 무료배송`
      : `${canonical} ${topNgram[0] ?? '인기'} 1+1`,
    `${persona.split(/[·,]/)[0].trim()}이 선택한 ${canonical}`,
  ]
    .map((t) => clampLen(t.replace(/\s+/g, ' ').trim(), 24))
    .join('\n')

  const drafts: ListingDraft[] = [
    { kind: 'title_short', content_md: shortTitles.join('\n') },
    { kind: 'title_long', content_md: longTitles.join('\n') },
    { kind: 'tags', content_md: tagLines },
    { kind: 'detail_md', content_md: detail },
    { kind: 'thumb_hook', content_md: thumbHooks },
  ]

  const snapshot: Record<string, unknown> = {
    final_score: latestScore?.final_score ?? null,
    trend_score: latestScore?.trend_score ?? null,
    commerce_score: latestScore?.commerce_score ?? null,
    supplier_score: latestScore?.supplier_score ?? null,
    competition_score: latestScore?.competition_score ?? null,
    score_computed_at: latestScore?.computed_at ?? null,
    alias_count: aliases.length,
    alias_sources: Array.from(new Set(aliases.map((a) => a.source).filter(Boolean))),
    supplier_count: suppliers.length,
    supplier_median_krw: supplierMedianKrw,
    min_lead_time_days: minLead ?? null,
    min_moq: minMoq ?? null,
    top_ngram: topNgram.slice(0, 15),
    intent_label: intent || null,
    category: categoryLabel(product.category_top, product.category_mid),
    persona,
    generated_by: 'rule_engine_v1',
  }

  return { drafts, snapshot }
}
