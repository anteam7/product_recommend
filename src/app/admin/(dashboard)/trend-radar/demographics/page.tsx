import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import DemographicsBoard from './DemographicsBoard'

export const dynamic = 'force-dynamic'

interface FingerprintRow {
  product_id: string
  gender_share: Record<string, number>
  age_share: Record<string, number>
  dominant_segment: string | null
  concentration_hhi: number | null
  source_label: string | null
  computed_at: string
}

interface ProductRow {
  id: string
  canonical_name: string
  category_top: string
  category_mid: string | null
  brand: string | null
  alias_count: number
}

interface ScoreRow {
  product_id: string
  final_score: number
  trend_score: number
  commerce_score: number
  supplier_score: number
  competition_score: number
  computed_at: string
}

async function fetchData() {
  const sb = createAdminClient()

  // 최신 fingerprint (product_id 별 latest) — view 가 있으면 그것 사용, 없으면 raw select 후 dedupe
  const { data: fpData } = await (sb as any)
    .from('jimscanner_trends_demo_fingerprint')
    .select(
      'product_id, gender_share, age_share, dominant_segment, concentration_hhi, source_label, computed_at',
    )
    .order('computed_at', { ascending: false })
    .limit(3000)

  const seen = new Set<string>()
  const fingerprints: FingerprintRow[] = []
  for (const f of (fpData ?? []) as FingerprintRow[]) {
    if (seen.has(f.product_id)) continue
    seen.add(f.product_id)
    fingerprints.push(f)
  }

  const productIds = fingerprints.map((f) => f.product_id)
  let products: ProductRow[] = []
  let scores: ScoreRow[] = []

  if (productIds.length > 0) {
    const [prodRes, scoreRes] = await Promise.all([
      sb
        .from('jimscanner_trends_products')
        .select('id, canonical_name, category_top, category_mid, brand, alias_count')
        .in('id', productIds),
      sb
        .from('jimscanner_trends_scores')
        .select(
          'product_id, final_score, trend_score, commerce_score, supplier_score, competition_score, computed_at',
        )
        .in('product_id', productIds)
        .order('computed_at', { ascending: false })
        .limit(3000),
    ])
    products = (prodRes.data ?? []) as ProductRow[]

    const sSeen = new Set<string>()
    for (const s of (scoreRes.data ?? []) as ScoreRow[]) {
      if (sSeen.has(s.product_id)) continue
      sSeen.add(s.product_id)
      scores.push(s)
    }
  }

  // 핀(pinned) 후보 — Opportunity 우상단 우선
  // jimscanner_trends_pins 가 있을 수도 있으나 안전하게 옵션 처리
  let pinnedIds: string[] = []
  try {
    const { data: pinData } = await (sb as any)
      .from('jimscanner_trends_pins')
      .select('product_id')
      .eq('is_active', true)
      .limit(500)
    pinnedIds = (pinData ?? []).map((p: { product_id: string }) => p.product_id)
  } catch {
    // 테이블 없으면 무시
  }

  return { fingerprints, products, scores, pinnedIds }
}

export default async function DemographicsPage() {
  const { fingerprints, products, scores, pinnedIds } = await fetchData()

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold">Demographic Fingerprint</h1>
          <p className="text-sm text-gray-500 mt-1">
            성별·연령 share 와 HHI(인구통계 집중도) 기반 카탈로그 쏠림 진단 · 화이트스페이스 추천.
          </p>
        </div>
        <Link
          href="/admin/trend-radar"
          className="text-sm text-gray-700 hover:text-black underline"
        >
          ← 대시보드
        </Link>
      </header>

      {fingerprints.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500 space-y-2">
          <div>
            아직 fingerprint 데이터가 없음.{' '}
            <code className="bg-gray-100 px-1 rounded">
              node scripts/naver-insight-demo-extract.mjs
            </code>{' '}
            로 적재 후 다시 방문.
          </div>
          <div className="text-xs text-gray-400">
            (마이그레이션:{' '}
            <code className="bg-gray-100 px-1 rounded">
              supabase/trends_v4_demo_fingerprint.sql
            </code>{' '}
            먼저 적용)
          </div>
        </div>
      ) : (
        <DemographicsBoard
          fingerprints={fingerprints}
          products={products}
          scores={scores}
          pinnedIds={pinnedIds}
        />
      )}
    </div>
  )
}
