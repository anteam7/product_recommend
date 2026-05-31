import { NextResponse, type NextRequest } from 'next/server'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import { isAuthorizedCron } from '@/lib/market-signals'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

// ─────────────────────────────────────────────────────────────
// 규제·리콜 리스크 추출 cron
// KCA 보도자료(kca_press)·gov_notice·naver_news 에서 위해 키워드를 뽑아
// 발굴 상품(jimscanner_trends_products)에 risk_flag(green/yellow/red)를 매핑한다.
//
//  ① 방어: recall/hazard/cert_required 키워드 → red 격리
//  ② 공격: 브랜드 리콜인데 우리 후보 브랜드는 다름 → '리콜 공백' opportunity 승격
//
// 매핑 근거: jimscanner_trends_aliases (alias ↔ product_id) 의 표면형 포함 검사.
// ─────────────────────────────────────────────────────────────

type RiskType = 'recall' | 'penalty' | 'cert_required' | 'hazard'

// 위해 유형별 키워드 (red = 강한 격리, yellow = 주의)
const RISK_RULES: { type: RiskType; level: 'red' | 'yellow'; keywords: string[] }[] = [
  { type: 'recall', level: 'red', keywords: ['리콜', '회수', '판매중지', '판매 중지', '시정조치', '교환·환급', '자발적 회수'] },
  { type: 'hazard', level: 'red', keywords: ['위해', '위해성', '안전기준 부적합', '유해물질', '발암', '중금속', '세균 검출', '화상', '질식'] },
  { type: 'cert_required', level: 'red', keywords: ['KC인증', 'KC 인증', '안전인증', '전안법', '인증 없이', '미인증', '식약처', '의약외품', '인증 의무'] },
  { type: 'penalty', level: 'yellow', keywords: ['과징금', '시정명령', '과태료', '행정처분', '적발', '고발'] },
]

// 위험 우선순위 (red 들 사이 대표 risk_type 선택용)
const RISK_PRIORITY: Record<RiskType, number> = {
  recall: 4,
  hazard: 3,
  cert_required: 2,
  penalty: 1,
}

function classify(title: string): { type: RiskType; level: 'red' | 'yellow'; matched: string[] } | null {
  for (const rule of RISK_RULES) {
    const matched = rule.keywords.filter((k) => title.includes(k))
    if (matched.length > 0) return { type: rule.type, level: rule.level, matched }
  }
  return null
}

// 제목에서 따옴표/괄호 안 브랜드 후보를 거칠게 추출 (없으면 null)
function extractBrand(title: string): string | null {
  const m = title.match(/[‘'"“]([^’'"”]{2,20})[’'"”]/) || title.match(/\(([^)]{2,20})\)/)
  return m ? m[1].trim() : null
}

type AliasRow = { product_id: string; alias: string }
type ProductRow = { id: string; canonical_name: string; brand: string | null; category_top: string | null }

interface Evidence {
  signal_id: string
  title: string
  url: string | null
  risk_type: RiskType
  matched_keywords: string[]
}

export async function GET(request: NextRequest) {
  if (!isAuthorizedCron(request))
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const sb = createAdminClient()

  // 1) 원천 신호 수집 — kca_press / naver_news raw + gov_notice signals
  const { data: rawRows } = await sb
    .from('jimscanner_market_raw')
    .select('id, source, title, source_url')
    .in('source', ['kca_press', 'naver_news'])
    .order('captured_at', { ascending: false })
    .limit(1000)

  const { data: govSignals } = await (sb as any)
    .from('jimscanner_market_signals')
    .select('id, description, keywords')
    .eq('signal_type', 'gov_notice')
    .order('last_seen', { ascending: false })
    .limit(500)

  type Origin = { kind: 'market_raw' | 'market_signal'; id: string; source: string; title: string; url: string | null }
  const origins: Origin[] = []
  for (const r of (rawRows ?? []) as any[]) {
    if (!r.title) continue
    origins.push({ kind: 'market_raw', id: String(r.id), source: r.source, title: r.title, url: r.source_url ?? null })
  }
  for (const s of (govSignals ?? []) as any[]) {
    const title = s.description || (Array.isArray(s.keywords) ? s.keywords.join(' ') : '')
    if (!title) continue
    origins.push({ kind: 'market_signal', id: String(s.id), source: 'gov_notice', title, url: null })
  }

  // 2) 분류 → compliance_signals upsert
  const signalRows: any[] = []
  type ClassifiedSignal = Origin & { risk_type: RiskType; level: 'red' | 'yellow'; matched: string[]; brand: string | null }
  const classified: ClassifiedSignal[] = []
  for (const o of origins) {
    const c = classify(o.title)
    if (!c) continue
    const brand = extractBrand(o.title)
    classified.push({ ...o, risk_type: c.type, level: c.level, matched: c.matched, brand })
    signalRows.push({
      origin_kind: o.kind,
      origin_id: o.id,
      source: o.source,
      title: o.title.slice(0, 500),
      source_url: o.url,
      risk_type: c.type,
      risk_level: c.level,
      matched_keywords: c.matched,
      brand,
    })
  }

  if (signalRows.length > 0) {
    await (sb as any)
      .from('jimscanner_compliance_signals')
      .upsert(signalRows, { onConflict: 'origin_kind,origin_id', ignoreDuplicates: false })
  }

  // 3) 상품 alias 로드 → 신호 제목에 alias 표면형이 포함되면 매핑
  const { data: aliases } = await sb
    .from('jimscanner_trends_aliases')
    .select('product_id, alias')
    .limit(20000)
  const { data: products } = await sb
    .from('jimscanner_trends_products')
    .select('id, canonical_name, brand, category_top')
    .limit(20000)

  const productById = new Map<string, ProductRow>(
    ((products ?? []) as any[]).map((p) => [p.id, p as ProductRow]),
  )
  // 너무 짧은 alias 는 오탐 → 길이 2 이상만
  const aliasRows = ((aliases ?? []) as AliasRow[]).filter((a) => a.alias && a.alias.length >= 2)

  // product_id → 매칭된 신호 모음
  const byProduct = new Map<string, ClassifiedSignal[]>()
  for (const sig of classified) {
    const hay = sig.title
    const hit = new Set<string>()
    for (const a of aliasRows) {
      if (hay.includes(a.alias)) hit.add(a.product_id)
    }
    for (const pid of hit) {
      const arr = byProduct.get(pid) ?? []
      arr.push(sig)
      byProduct.set(pid, arr)
    }
  }

  // 4) 상품별 risk_flag / opportunity 산정 → compliance_flags upsert
  const flagRows: any[] = []
  const nowIso = new Date().toISOString()
  for (const [pid, sigs] of byProduct) {
    const prod = productById.get(pid)
    const hasRed = sigs.some((s) => s.level === 'red')
    const risk_flag = hasRed ? 'red' : 'yellow'

    // 대표 risk_type = 우선순위 최댓값
    let topRisk: RiskType = sigs[0].risk_type
    for (const s of sigs) {
      if (RISK_PRIORITY[s.risk_type] > RISK_PRIORITY[topRisk]) topRisk = s.risk_type
    }

    // 리콜 공백 기회: recall 신호의 브랜드가 있고, 우리 후보 브랜드와 다르면
    // (incumbent 리콜 + 카테고리 수요 유지 → 선점 가능)
    const opportunity = sigs.some(
      (s) =>
        s.risk_type === 'recall' &&
        !!s.brand &&
        !!prod?.brand &&
        s.brand.toLowerCase() !== (prod.brand as string).toLowerCase(),
    )

    const evidence: Evidence[] = sigs.slice(0, 10).map((s) => ({
      signal_id: s.id,
      title: s.title.slice(0, 300),
      url: s.url,
      risk_type: s.risk_type,
      matched_keywords: s.matched,
    }))

    flagRows.push({
      product_id: pid,
      risk_flag,
      opportunity,
      signal_count: sigs.length,
      top_risk_type: topRisk,
      evidence,
      computed_at: nowIso,
    })
  }

  if (flagRows.length > 0) {
    await (sb as any)
      .from('jimscanner_compliance_flags')
      .upsert(flagRows, { onConflict: 'product_id', ignoreDuplicates: false })
  }

  return NextResponse.json({
    ok: true,
    origins: origins.length,
    classified_signals: signalRows.length,
    flagged_products: flagRows.length,
    red: flagRows.filter((f) => f.risk_flag === 'red').length,
    opportunities: flagRows.filter((f) => f.opportunity).length,
    executed_at: nowIso,
  })
}
