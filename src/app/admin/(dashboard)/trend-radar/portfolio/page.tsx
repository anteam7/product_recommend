import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import PortfolioBoard, { type Candidate } from './PortfolioBoard'

export const dynamic = 'force-dynamic'

interface ScoreRow {
  product_id: string
  trend_score: number
  commerce_score: number
  competition_score: number
  final_score: number
  computed_at: string
}

// 건기식·식품 = 인증/규제(식품유형·claim) 카테고리로 간주
const REGULATED_CLUSTERS = new Set(['health', 'food', 'supplements'])

async function fetchCandidates(): Promise<Candidate[]> {
  const sb = createAdminClient()

  // 최신 score (product_id 별 latest) — opportunity 페이지와 동일 패턴
  const { data: scores } = await sb
    .from('jimscanner_trends_scores')
    .select('product_id, trend_score, commerce_score, competition_score, final_score, computed_at')
    .order('computed_at', { ascending: false })
    .limit(2000)

  const seen = new Set<string>()
  const latest: ScoreRow[] = []
  for (const s of (scores ?? []) as ScoreRow[]) {
    if (seen.has(s.product_id)) continue
    seen.add(s.product_id)
    latest.push(s)
  }
  if (latest.length === 0) return []

  const ids = latest.map((s) => s.product_id)

  const { data: prods } = await sb
    .from('jimscanner_trends_products')
    .select('id, canonical_name, category_top, alias_count')
    .in('id', ids)
  const byId = new Map((prods ?? []).map((p: any) => [p.id, p]))

  // 대표 도매처 + 이미지 보유 여부 (도매처 의존 상관 페널티 입력)
  const { data: suppliers } = await sb
    .from('jimscanner_trends_supplier')
    .select('product_id, supplier_source, url_image')
    .in('product_id', ids)
  const supByProduct = new Map<string, { source: string; hasImage: boolean }>()
  for (const s of (suppliers ?? []) as any[]) {
    if (!supByProduct.has(s.product_id)) {
      supByProduct.set(s.product_id, {
        source: s.supplier_source ?? 'unknown',
        hasImage: Boolean(s.url_image),
      })
    }
  }

  return latest.map((s): Candidate => {
    const p = (byId.get(s.product_id) ?? {}) as any
    const sup = supByProduct.get(s.product_id)
    const cluster = p.category_top ?? 'all'
    // 실효마진 프록시: commerce_score(상업성) 를 0~1 로 환산 (카테고리수수료·반품 보정 자리)
    const marginScore = Math.min(1, Math.max(0, Number(s.commerce_score) / 100))
    return {
      id: s.product_id,
      name: p.canonical_name ?? '?',
      cluster,
      supplier: sup?.source ?? 'ggsan',
      finalScore: Number(s.final_score),
      competition: Number(s.competition_score),
      marginScore,
      aliasCount: Number(p.alias_count ?? 0),
      needsImageFix: sup ? !sup.hasImage : true,
      regulated: REGULATED_CLUSTERS.has(cluster),
    }
  })
}

export default async function PortfolioPage() {
  const candidates = await fetchCandidates()

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold">🎯 주간 출시 슬롯 포트폴리오</h1>
          <p className="text-sm text-gray-500 mt-1">
            게이트 통과 후보 위에 얹는 베팅 사이징 — 주당 슬롯 N·광고예산 제약 + 상관 페널티(테마·도매처 몰빵 감점) + 노력비용으로 &quot;이번 주 실제 착수할 묶음&quot; 추천
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      <div className="rounded border border-emerald-200 bg-emerald-50 px-4 py-3 text-xs text-emerald-900">
        <strong>왜 필요한가</strong> · 통과 후보는 주당 수백 개씩 쌓이지만 1인 운영자가 소화할 등록은 소수.
        한정된 시간·광고비를 어떤 후보 집합에 배분할지(포트폴리오 베팅)를 결정. 같은 도매처/테마 몰빵 리스크는 상관 페널티로 차단.
      </div>

      {candidates.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500">
          아직 score 데이터 없음. cron 누적 후 다시 방문.
        </div>
      ) : (
        <PortfolioBoard candidates={candidates} />
      )}
    </div>
  )
}
