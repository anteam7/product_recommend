import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import OpportunityScatter from './OpportunityScatter'
import PenetrationPanel from './PenetrationPanel'

export const dynamic = 'force-dynamic'

type Tab = 'matrix' | 'penetration'

interface ScoreRow {
  product_id: string
  trend_score: number
  commerce_score: number
  supplier_score: number
  competition_score: number
  final_score: number
  computed_at: string
}

async function fetchMatrix() {
  const sb = createAdminClient()

  const { data: scores } = await sb
    .from('jimscanner_trends_scores')
    .select('product_id, trend_score, commerce_score, supplier_score, competition_score, final_score, computed_at')
    .order('computed_at', { ascending: false })
    .limit(2000)

  const seen = new Set<string>()
  const latest: ScoreRow[] = []
  for (const s of (scores ?? []) as ScoreRow[]) {
    if (seen.has(s.product_id)) continue
    seen.add(s.product_id)
    latest.push(s)
  }

  const ids = latest.map((s) => s.product_id)
  if (ids.length === 0) return { rows: [] }

  const { data: prods } = await sb
    .from('jimscanner_trends_products')
    .select('id, canonical_name, category_top')
    .in('id', ids)
  const byId = new Map((prods ?? []).map((p: any) => [p.id, p]))

  return {
    rows: latest.map((s) => {
      const p = byId.get(s.product_id) ?? {}
      return {
        id: s.product_id,
        name: (p as any).canonical_name ?? '?',
        category: (p as any).category_top ?? 'all',
        x: s.competition_score,
        y: s.trend_score,
        size: Math.max(50, s.commerce_score * 4),
        final: s.final_score,
        supplier: s.supplier_score,
      }
    }),
  }
}

async function fetchPenetration() {
  const sb = createAdminClient()
  // RPC 는 DB 마이그레이션 후 동작. 미적용 환경에선 빈 배열.
  const { data, error } = await (sb as any).rpc('jimscanner_serp_penetration_index', {
    weeks_window: 12,
  })
  if (error) {
    return { rows: [] as any[], error: error.message }
  }
  return { rows: (data ?? []) as any[], error: null }
}

export default async function OpportunityPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>
}) {
  const sp = await searchParams
  const tab: Tab = sp.tab === 'penetration' ? 'penetration' : 'matrix'

  const [{ rows: matrixRows }, penetration] = await Promise.all([
    tab === 'matrix' ? fetchMatrix() : Promise.resolve({ rows: [] }),
    tab === 'penetration' ? fetchPenetration() : Promise.resolve({ rows: [], error: null }),
  ])

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold">Opportunity</h1>
          <p className="text-sm text-gray-500 mt-1">
            {tab === 'matrix'
              ? 'X = competition (오른쪽 = 경쟁 약함) · Y = trend · 크기 = commerce · 핀 후보 = 우상단 큰 점'
              : '카테고리별 4주 생존율 — "내가 들어가면 자리잡을 수 있는가" 의 답'}
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      <nav className="flex gap-2 border-b border-gray-200">
        <TabLink href="/admin/trend-radar/opportunity" active={tab === 'matrix'} label="Matrix" />
        <TabLink
          href="/admin/trend-radar/opportunity?tab=penetration"
          active={tab === 'penetration'}
          label="Penetration Index"
        />
      </nav>

      {tab === 'matrix' ? (
        matrixRows.length === 0 ? (
          <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500">
            아직 데이터 없음. cron 누적 후 다시 방문.
          </div>
        ) : (
          <OpportunityScatter rows={matrixRows} />
        )
      ) : (
        <>
          {penetration.error && (
            <div className="rounded border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800">
              RPC 오류 (마이그레이션 미적용일 수 있음): {penetration.error}
            </div>
          )}
          <PenetrationPanel rows={penetration.rows as any} />
        </>
      )}
    </div>
  )
}

function TabLink({ href, active, label }: { href: string; active: boolean; label: string }) {
  return (
    <Link
      href={href}
      className={`px-3 py-2 text-sm ${
        active
          ? 'border-b-2 border-black font-semibold text-black'
          : 'text-gray-500 hover:text-black'
      }`}
    >
      {label}
    </Link>
  )
}
