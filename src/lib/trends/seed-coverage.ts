// 시드 커버리지 갭 감사 — Seed Blindspot 분석 엔진
//
// 수집 입력단(jimscanner_trends_seeds)이 실제 발굴 수요를 얼마나 커버하는지 역추적한다.
//  ① coverage      : 발굴 상품(trends_products) + 시장 시그널(market_signals)을
//                     활성 시드 어휘와 매칭해 '시드가 잡았어야 할' 비율 계산
//  ② blindspot     : 시그널은 상승 중인데 대응 시드가 0인 카테고리·키워드 클러스터
//  ③ dead seed     : 귀속 발굴이 거의 없는 저수율 시드(수집예산 낭비)
//
// 카테고리 표기가 소스마다 다르므로(products=영문/자유, signals=한글, seeds=Naver cid)
// 토큰 교집합 기반의 보수적 매칭을 쓴다 — 갭을 과소평가하지 않고 정직하게 드러내는 것이 목적.
//
// 분석 전용 (읽기). draft 시드 insert 는 actions.ts / cron 이 담당.

import { createAdminClient } from '@/lib/auth/admin-supabase'

// jimscanner_trends_* 일부는 generated Database 타입에 없거나 느슨하므로 as any 우회.
// (rpc_type_workaround 패턴 — types/supabase.ts 재생성 시 제거 가능)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function sbLoose(): any {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return createAdminClient() as any
}

export interface SeedRow {
  id: string
  source: string
  kind: string
  label: string
  config: { cid?: string; name?: string; groupName?: string; keywords?: string[] } | null
  is_active: boolean
}

export interface SeedCoverage {
  seed: SeedRow
  matchedProducts: number
  matchedSignals: number
  attributedScore: number // 귀속 상품 final_score 합 (수율 프록시)
  dead: boolean
}

export interface BlindspotCluster {
  category: string | null
  keywords: string[]
  frequency: number // 시그널 빈도 합 (기대 발굴수율 프록시)
  signalCount: number
  sampleDescription: string | null
}

export interface AuditResult {
  windowDays: number
  generatedAt: string
  activeSeedCount: number
  totalProducts: number
  totalSignals: number
  coveredProducts: number
  coveredSignals: number
  productCoverageRate: number // 0~1
  signalCoverageRate: number // 0~1
  seedCoverages: SeedCoverage[]
  deadSeeds: SeedCoverage[]
  blindspots: BlindspotCluster[]
}

const DEAD_SCORE_THRESHOLD = 1 // 귀속 상품 0 이면 dead 후보
const STOPWORDS = new Set([
  '직구',
  '추천',
  '인기',
  '일반',
  '기타',
  '제품',
  '상품',
  'best',
  'top',
  'new',
])

export function tokenize(s: string | null | undefined): string[] {
  if (!s) return []
  return s
    .toLowerCase()
    .split(/[^0-9a-z가-힣]+/)
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t))
}

function seedVocabulary(seed: SeedRow): Set<string> {
  const tokens: string[] = []
  tokens.push(...tokenize(seed.label))
  const c = seed.config ?? {}
  tokens.push(...tokenize(c.name))
  tokens.push(...tokenize(c.groupName))
  for (const k of c.keywords ?? []) tokens.push(...tokenize(k))
  return new Set(tokens)
}

function overlaps(vocab: Set<string>, tokens: string[]): boolean {
  for (const t of tokens) if (vocab.has(t)) return true
  return false
}

/**
 * 시드 커버리지 갭 감사 실행. 페이지(SSR)와 cron 이 공유.
 */
export async function runSeedCoverageAudit(windowDays = 30): Promise<AuditResult> {
  const sb = sbLoose()
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString()

  const [seedsRes, productsRes, scoresRes, signalsRes] = await Promise.all([
    sb
      .from('jimscanner_trends_seeds')
      .select('id, source, kind, label, config, is_active')
      .eq('is_active', true),
    sb
      .from('jimscanner_trends_products')
      .select('id, canonical_name, category_top, category_mid, last_seen_at')
      .gte('last_seen_at', since)
      .limit(2000),
    sb
      .from('jimscanner_trends_scores')
      .select('product_id, final_score, computed_at')
      .gte('computed_at', since)
      .order('computed_at', { ascending: false })
      .limit(5000),
    sb
      .from('jimscanner_market_signals')
      .select('category, keywords, frequency, description, last_seen')
      .gte('last_seen', since)
      .limit(3000),
  ])

  const seeds = (seedsRes.data ?? []) as SeedRow[]
  const products = (productsRes.data ?? []) as {
    id: string
    canonical_name: string
    category_top: string
    category_mid: string | null
  }[]
  const scores = (scoresRes.data ?? []) as { product_id: string; final_score: number }[]
  const signals = (signalsRes.data ?? []) as {
    category: string | null
    keywords: string[] | null
    frequency: number | null
    description: string | null
  }[]

  // product_id → 최신 final_score (scores 는 computed_at desc 정렬됨)
  const latestScore = new Map<string, number>()
  for (const s of scores) {
    if (!latestScore.has(s.product_id)) latestScore.set(s.product_id, Number(s.final_score) || 0)
  }

  const vocabs = seeds.map((seed) => ({ seed, vocab: seedVocabulary(seed) }))

  // ── 상품 커버리지 ──
  const cov: SeedCoverage[] = vocabs.map((v) => ({
    seed: v.seed,
    matchedProducts: 0,
    matchedSignals: 0,
    attributedScore: 0,
    dead: false,
  }))
  const covBySeedId = new Map(cov.map((c) => [c.seed.id, c]))

  let coveredProducts = 0
  for (const p of products) {
    const tokens = [
      ...tokenize(p.canonical_name),
      ...tokenize(p.category_top),
      ...tokenize(p.category_mid),
    ]
    let covered = false
    for (const { seed, vocab } of vocabs) {
      if (overlaps(vocab, tokens)) {
        covered = true
        const c = covBySeedId.get(seed.id)!
        c.matchedProducts++
        c.attributedScore += latestScore.get(p.id) ?? 0
      }
    }
    if (covered) coveredProducts++
  }

  // ── 시그널 커버리지 + 블라인드스팟 ──
  let coveredSignals = 0
  const blindspotMap = new Map<string, BlindspotCluster>()
  for (const sig of signals) {
    const tokens = [...tokenize(sig.category), ...(sig.keywords ?? []).flatMap((k) => tokenize(k))]
    const freq = Number(sig.frequency) || 1
    let covered = false
    for (const { seed, vocab } of vocabs) {
      if (overlaps(vocab, tokens)) {
        covered = true
        covBySeedId.get(seed.id)!.matchedSignals++
      }
    }
    if (covered) {
      coveredSignals++
    } else if (tokens.length > 0) {
      // 대응 시드 0 → 블라인드스팟 클러스터에 누적 (category 기준, 없으면 첫 키워드)
      const key = sig.category ?? (sig.keywords?.[0] ?? 'uncategorized')
      const cluster = blindspotMap.get(key) ?? {
        category: sig.category,
        keywords: [],
        frequency: 0,
        signalCount: 0,
        sampleDescription: sig.description ?? null,
      }
      cluster.frequency += freq
      cluster.signalCount++
      for (const k of sig.keywords ?? []) {
        if (k && !cluster.keywords.includes(k) && cluster.keywords.length < 8) cluster.keywords.push(k)
      }
      if (!cluster.sampleDescription && sig.description) cluster.sampleDescription = sig.description
      blindspotMap.set(key, cluster)
    }
  }

  // dead seed 판정
  for (const c of cov) {
    c.dead = c.matchedProducts === 0 && c.attributedScore < DEAD_SCORE_THRESHOLD
  }

  const blindspots = [...blindspotMap.values()]
    .filter((b) => b.keywords.length > 0 || b.category)
    .sort((a, b) => b.frequency - a.frequency)

  const seedCoverages = [...cov].sort(
    (a, b) => b.matchedProducts + b.matchedSignals - (a.matchedProducts + a.matchedSignals),
  )
  const deadSeeds = seedCoverages
    .filter((c) => c.dead)
    .sort((a, b) => a.attributedScore - b.attributedScore)

  return {
    windowDays,
    generatedAt: new Date().toISOString(),
    activeSeedCount: seeds.length,
    totalProducts: products.length,
    totalSignals: signals.length,
    coveredProducts,
    coveredSignals,
    productCoverageRate: products.length ? coveredProducts / products.length : 0,
    signalCoverageRate: signals.length ? coveredSignals / signals.length : 0,
    seedCoverages,
    deadSeeds,
    blindspots,
  }
}
