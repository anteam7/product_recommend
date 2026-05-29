/**
 * 등록 준비도(readiness) 산출 로직 — cron 과 페이지가 공유.
 *
 * readiness_score 는 "솔로 셀러가 발굴 candidate 를 실제 쿠팡에 등록하기까지의
 * 운영 마찰"을 0~100 으로 환산한다 (높을수록 등록 즉시 가능).
 *
 *   ① 규제 인증(건강기능식품/식품/화장품/KC전파) → '고장벽' 큰 감점
 *   ② 카테고리 필수속성(고시정보+옵션속성) 개수 → 비례 감점
 *   ③ ggsan 소싱 콘텐츠 자산(이미지·상세) 충분도 → 부족할수록 감점
 */

export interface CategoryMeta {
  display_category_code: number
  name: string | null
  notice_mandatory_count: number
  attr_mandatory_count: number
  cert_required: boolean
  cert_names: string[]
}

export type CertType = '건강기능식품' | '식품' | '화장품' | 'KC전파' | '의료기기'

// 규제 인증이 필요한 '고장벽' 키워드 → 인증 유형. 카테고리명/상품명/category_mid 에서 탐지.
const CERT_KEYWORD_MAP: Array<{ type: CertType; keywords: string[] }> = [
  {
    type: '건강기능식품',
    keywords: [
      '멜라토닌', '유산균', '프로바이오틱', '비타민', '오메가', '루테인', '쏘팔메토',
      '밀크시슬', '글루코사민', '콜라겐', '홍삼', '영양제', '멀티비타민', '초유',
      '건강기능', '눈영양', '관절', '면역',
    ],
  },
  {
    type: '식품',
    keywords: ['배즙', '도라지즙', '마늘즙', '즙', '다이어트식품', '식품', '환', '분말', '차'],
  },
  {
    type: '화장품',
    keywords: ['앰플', '세럼', '크림', '토너', '에센스', '화장품', '선크림', '쿠션', '마스크팩'],
  },
  {
    type: 'KC전파',
    keywords: ['블루투스', '무선', '충전기', '이어폰', '스피커', '공유기', '전파', '리모컨', '키보드', '마우스'],
  },
  {
    type: '의료기기',
    keywords: ['마사지기', '온열', '체온계', '혈압계', '의료기기', '저주파', '안마'],
  },
]

export function detectCertType(text: string): CertType | null {
  const t = (text || '').toLowerCase()
  for (const { type, keywords } of CERT_KEYWORD_MAP) {
    if (keywords.some((k) => t.includes(k.toLowerCase()))) return type
  }
  return null
}

/**
 * category_mid / canonical_name 을 카테고리 메타 캐시의 name 과 느슨하게 매칭.
 * 정확한 displayCategoryCode 매핑 테이블이 없으므로 이름 포함 기반 휴리스틱.
 */
export function matchCategoryMeta(
  text: string,
  metas: CategoryMeta[],
): CategoryMeta | null {
  const t = (text || '').toLowerCase()
  let best: CategoryMeta | null = null
  let bestLen = 0
  for (const m of metas) {
    const name = (m.name || '').toLowerCase()
    if (!name) continue
    if (t.includes(name) && name.length > bestLen) {
      best = m
      bestLen = name.length
    }
  }
  return best
}

export interface ReadinessInput {
  categoryTop: string | null
  categoryMid: string | null
  canonicalName: string
  /** 매칭된 카테고리 메타 (있으면) */
  meta: CategoryMeta | null
  /** ggsan 등 supplier row 들의 이미지 보유 수 */
  supplierWithImage: number
  /** supplier row 총 개수 */
  supplierCount: number
  /** supplier 중 상세(title/description) 보유 수 */
  supplierWithDetail: number
}

export interface ReadinessResult {
  matched_category_code: number | null
  mandatory_attr_count: number
  cert_required: boolean
  cert_type: CertType | null
  content_asset_score: number
  readiness_score: number
  breakdown: Record<string, unknown>
}

export function computeReadiness(input: ReadinessInput): ReadinessResult {
  const haystack = `${input.canonicalName} ${input.categoryMid ?? ''} ${input.meta?.name ?? ''}`
  const certType = detectCertType(haystack)
  // 카테고리 메타에 MANDATORY 인증서류가 있으면 그 자체로 인증요구 확정
  const certRequired = !!certType || !!input.meta?.cert_required

  // 필수속성 합산 (고시정보 MANDATORY + 옵션속성 MANDATORY)
  const mandatoryAttrCount = input.meta
    ? input.meta.notice_mandatory_count + input.meta.attr_mandatory_count
    : 0

  // ── 콘텐츠 자산 점수 (0~100) ──
  // 이미지 보유 supplier 가 핵심. 1건만 있어도 등록 가능, 많을수록 풍부.
  let contentAsset = 0
  if (input.supplierCount > 0) contentAsset += 30 // 소싱처 존재
  contentAsset += Math.min(40, input.supplierWithImage * 20) // 이미지(최대 2건분)
  contentAsset += Math.min(30, input.supplierWithDetail * 15) // 상세(최대 2건분)
  contentAsset = Math.min(100, contentAsset)

  // ── 준비도 점수 (0~100, 높을수록 등록 즉시 가능) ──
  let readiness = 100

  // 규제 인증 = 솔로 셀러 최대 장벽 (서류·심사·표시기준)
  if (certRequired) {
    readiness -= certType === '건강기능식품' || certType === '의료기기' ? 55 : 40
  }

  // 필수속성 개수 비례 감점 (속성 채우기 = coupang-fix-mandatory/bulk-fill-attrs 마찰)
  readiness -= Math.min(25, mandatoryAttrCount * 2.5)

  // 콘텐츠 자산 부족 감점 (자산 0 이면 -25, 만점이면 0)
  readiness -= ((100 - contentAsset) / 100) * 25

  // 카테고리 메타 자체를 모르면(매핑 실패) 불확실성 소폭 감점
  if (!input.meta) readiness -= 5

  readiness = Math.max(0, Math.min(100, Math.round(readiness)))

  return {
    matched_category_code: input.meta?.display_category_code ?? null,
    mandatory_attr_count: mandatoryAttrCount,
    cert_required: certRequired,
    cert_type: certType,
    content_asset_score: Math.round(contentAsset),
    readiness_score: readiness,
    breakdown: {
      certType,
      certRequired,
      mandatoryAttrCount,
      noticeMandatory: input.meta?.notice_mandatory_count ?? null,
      attrMandatory: input.meta?.attr_mandatory_count ?? null,
      supplierCount: input.supplierCount,
      supplierWithImage: input.supplierWithImage,
      supplierWithDetail: input.supplierWithDetail,
      matchedMetaName: input.meta?.name ?? null,
    },
  }
}
