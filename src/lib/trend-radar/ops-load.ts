// ─────────────────────────────────────────────────────────────
// 위탁 운영부하 게이트 (ops_load) — 공통 모듈
// ─────────────────────────────────────────────────────────────
// 판매 후 '인적 운영부하'(반품·교환·CS 문의)가 큰 상품을 1인 셀러가
// 시간 손실로 인지할 수 있게 게이트로 노출한다. final_score 를 차감하지
// 않고, 기존 게이트 보드들과 동일하게 '표시'만 한다.
//
// ops_load_score: 0~100 (높을수록 손많이감 = 나쁨)
//   = 카테고리 prior(반품률·문의률) 50% + 텍스트 신호 밀도 50%
//
// 저장 위치: jimscanner_trends_scores.score_components.ops_load
//   { score, return_prior, inquiry_prior, signal_density, signal_hits }
// ─────────────────────────────────────────────────────────────

export interface OpsLoadComponent {
  score: number // 0~100, 높을수록 운영부하 큼
  return_prior?: number // 카테고리 반품률 prior (0~1)
  inquiry_prior?: number // 카테고리 CS 문의률 prior (0~1)
  signal_density?: number // 텍스트 신호 밀도 (0~1)
  signal_hits?: number // 매칭된 불만/문의 패턴 건수
}

export type OpsLoadLevel = 'low' | 'medium' | 'high' | 'unknown'

export interface OpsLoadBadge {
  level: OpsLoadLevel
  label: string // '운영부하 낮음' 등
  short: string // '낮음'
  /** tailwind class 묶음 (배지 배경/텍스트) */
  className: string
  score: number | null
}

// 임계: 이 미만이면 게이트 통과(손 덜 감). 보드 토글 기본값.
export const OPS_LOAD_THRESHOLD = 45

// ── 카테고리 prior ─────────────────────────────────────────────
// DB(trends_ops_load_priors)가 1차 소스. 미적재/오프라인 fallback 으로
// 사용할 키워드 기반 기본 prior. category_mid 안의 키워드로 매칭.
interface CategoryPrior {
  match: RegExp
  return_rate_prior: number // 0~1
  inquiry_rate_prior: number // 0~1
  note: string
}

export const FALLBACK_CATEGORY_PRIORS: CategoryPrior[] = [
  { match: /의류|옷|패션|티셔츠|바지|원피스|이너|속옷|언더웨어|브라/, return_rate_prior: 0.35, inquiry_rate_prior: 0.15, note: '의류 사이즈 반품↑' },
  { match: /신발|운동화|구두|샌들|슬리퍼/, return_rate_prior: 0.4, inquiry_rate_prior: 0.15, note: '신발 사이즈 반품↑' },
  { match: /케이블|충전|어댑터|젠더|액세서리|호환|거치대|마운트/, return_rate_prior: 0.12, inquiry_rate_prior: 0.45, note: '전자 액세서리 호환성 문의↑' },
  { match: /조립|설치|가구|선반|책상|행거|diy|디아이와이/, return_rate_prior: 0.15, inquiry_rate_prior: 0.4, note: '조립·설치 사용법 문의↑' },
  { match: /전자|가전|디지털|이어폰|블루투스|스마트/, return_rate_prior: 0.12, inquiry_rate_prior: 0.3, note: '전자 사용법·초기불량 문의↑' },
]

// 건강기능식품·식품·소모품은 운영부하 낮음(반품·문의 적음).
export const LOW_LOAD_DEFAULT = { return_rate_prior: 0.05, inquiry_rate_prior: 0.08 }

export function lookupFallbackPrior(categoryMid: string | null | undefined): {
  return_rate_prior: number
  inquiry_rate_prior: number
  note: string | null
} {
  if (categoryMid) {
    for (const p of FALLBACK_CATEGORY_PRIORS) {
      if (p.match.test(categoryMid)) {
        return { return_rate_prior: p.return_rate_prior, inquiry_rate_prior: p.inquiry_rate_prior, note: p.note }
      }
    }
  }
  return { ...LOW_LOAD_DEFAULT, note: null }
}

// ── 텍스트 신호 패턴 ───────────────────────────────────────────
// 커뮤니티 raw 본문(82cook/natepan/dcinside/ppomppu)에서 반품·교환·문의·
// 불만 밀도를 추출할 때 쓰는 패턴. enrich 스크립트와 공유.
export const OPS_LOAD_TEXT_PATTERNS: { re: RegExp; weight: number; kind: 'return' | 'inquiry' }[] = [
  { re: /반품/g, weight: 2, kind: 'return' },
  { re: /교환/g, weight: 1.5, kind: 'return' },
  { re: /환불/g, weight: 1.5, kind: 'return' },
  { re: /불량/g, weight: 2, kind: 'return' },
  { re: /파손|깨졌|찢어/g, weight: 1.5, kind: 'return' },
  { re: /사이즈\s*안\s*맞|사이즈가\s*안|작아요|커요|크게\s*나/g, weight: 2, kind: 'return' },
  { re: /호환\s*되나요|호환되|맞나요|연결\s*되나요/g, weight: 1.5, kind: 'inquiry' },
  { re: /어떻게\s*쓰|사용법|사용\s*방법|설명서|작동\s*안/g, weight: 1.5, kind: 'inquiry' },
  { re: /설치\s*어떻게|조립\s*어떻|설치가\s*안/g, weight: 1.5, kind: 'inquiry' },
  { re: /문의|cs|고객센터|배송\s*언제/gi, weight: 1, kind: 'inquiry' },
]

/**
 * 텍스트 묶음에서 운영부하 신호 밀도를 계산한다. (enrich 스크립트와 동일 로직)
 * 반환: signal_hits(가중 합), signal_density(0~1, 100자당 가중치 1.0 기준 saturate)
 */
export function computeTextSignalDensity(text: string): { signal_hits: number; signal_density: number } {
  if (!text) return { signal_hits: 0, signal_density: 0 }
  let weighted = 0
  for (const p of OPS_LOAD_TEXT_PATTERNS) {
    const m = text.match(p.re)
    if (m) weighted += m.length * p.weight
  }
  // 글자수 대비 정규화 — 1000자당 가중 10 이면 density≈1.0
  const per1000 = (weighted / Math.max(text.length, 1)) * 1000
  const density = Math.max(0, Math.min(1, per1000 / 10))
  return { signal_hits: Math.round(weighted), signal_density: Number(density.toFixed(3)) }
}

/**
 * prior + 텍스트 신호를 0~100 ops_load_score 로 합성.
 * 카테고리 prior 50%(반품·문의 평균을 0~100 스케일) + 텍스트 밀도 50%.
 */
export function synthesizeOpsLoad(opts: {
  return_prior: number
  inquiry_prior: number
  signal_density: number
  signal_hits?: number
}): OpsLoadComponent {
  const priorAvg = (opts.return_prior + opts.inquiry_prior) / 2 // 0~1
  const priorPart = priorAvg * 100
  const textPart = opts.signal_density * 100
  const score = Math.round(priorPart * 0.5 + textPart * 0.5)
  return {
    score: Math.max(0, Math.min(100, score)),
    return_prior: opts.return_prior,
    inquiry_prior: opts.inquiry_prior,
    signal_density: opts.signal_density,
    signal_hits: opts.signal_hits,
  }
}

// ── 배지 ───────────────────────────────────────────────────────
export function opsLoadLevel(score: number | null | undefined): OpsLoadLevel {
  if (score == null || Number.isNaN(score)) return 'unknown'
  if (score < OPS_LOAD_THRESHOLD) return 'low'
  if (score < 65) return 'medium'
  return 'high'
}

const BADGE_STYLE: Record<OpsLoadLevel, { short: string; className: string }> = {
  low: { short: '낮음', className: 'bg-emerald-100 text-emerald-800' },
  medium: { short: '보통', className: 'bg-amber-100 text-amber-800' },
  high: { short: '높음', className: 'bg-red-100 text-red-700' },
  unknown: { short: '미산출', className: 'bg-gray-100 text-gray-500' },
}

export function opsLoadBadge(score: number | null | undefined): OpsLoadBadge {
  const level = opsLoadLevel(score)
  const s = BADGE_STYLE[level]
  return {
    level,
    short: s.short,
    label: `운영부하 ${s.short}`,
    className: s.className,
    score: score == null || Number.isNaN(score as number) ? null : (score as number),
  }
}

/**
 * score_components(jsonb) 에서 ops_load 컴포넌트를 안전하게 꺼낸다.
 * 마이그레이션 전/미적재 row 는 null.
 */
export function readOpsLoad(scoreComponents: unknown): OpsLoadComponent | null {
  if (!scoreComponents || typeof scoreComponents !== 'object') return null
  const c = (scoreComponents as Record<string, unknown>).ops_load
  if (!c || typeof c !== 'object') return null
  const score = (c as Record<string, unknown>).score
  if (typeof score !== 'number') return null
  return c as OpsLoadComponent
}
