import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import ThemeBubbleMap from './ThemeBubbleMap'

export const dynamic = 'force-dynamic'

interface ThemeRow {
  id: string
  theme_id: string
  label: string | null
  constituent_product_ids: string[]
  aggregate_momentum: number
  breadth: number
  cohesion: number
  member_count: number
  category_spread: number
  computed_at: string
}

interface MemberInfo {
  id: string
  name: string
  category: string
  final: number
  supplier: number
}

export interface ThemeView extends ThemeRow {
  members: MemberInfo[]
}

async function fetchData(): Promise<{ themes: ThemeView[] }> {
  const sb = createAdminClient()

  // 최신 배치만 (computed_at 최대값 기준)
  // jimscanner_trends_themes 는 trends_v4_themes.sql 마이그레이션 후 생성 — 타입 미생성이라 as any
  const { data: themesRaw } = await (sb as any)
    .from('jimscanner_trends_themes')
    .select(
      'id, theme_id, label, constituent_product_ids, aggregate_momentum, breadth, cohesion, member_count, category_spread, computed_at',
    )
    .order('computed_at', { ascending: false })
    .limit(200)

  const all = ((themesRaw ?? []) as any) as ThemeRow[]
  if (all.length === 0) return { themes: [] }

  // 가장 최근 배치(computed_at) 만 노출
  const latestStamp = all[0].computed_at
  const latest = all.filter((t) => t.computed_at === latestStamp)

  // 구성 product 메타 + 최신 score 일괄 로드
  const memberIds = [...new Set(latest.flatMap((t) => t.constituent_product_ids ?? []))]
  const prodById = new Map<string, any>()
  const scoreById = new Map<string, { final: number; supplier: number }>()

  if (memberIds.length > 0) {
    const { data: prods } = await sb
      .from('jimscanner_trends_products')
      .select('id, canonical_name, category_top')
      .in('id', memberIds)
    for (const p of (prods ?? []) as any[]) prodById.set(p.id, p)

    const { data: scores } = await sb
      .from('jimscanner_trends_scores')
      .select('product_id, final_score, supplier_score, computed_at')
      .in('product_id', memberIds)
      .order('computed_at', { ascending: false })
      .limit(8000)
    for (const s of (scores ?? []) as any[]) {
      if (scoreById.has(s.product_id)) continue
      scoreById.set(s.product_id, {
        final: Number(s.final_score),
        supplier: Number(s.supplier_score),
      })
    }
  }

  const themes: ThemeView[] = latest.map((t) => ({
    ...t,
    members: (t.constituent_product_ids ?? []).map((pid) => {
      const p = prodById.get(pid) ?? {}
      const sc = scoreById.get(pid) ?? { final: 0, supplier: 0 }
      return {
        id: pid,
        name: p.canonical_name ?? '?',
        category: p.category_top ?? 'all',
        final: sc.final,
        supplier: sc.supplier,
      }
    }),
  }))

  themes.sort((a, b) => b.aggregate_momentum - a.aggregate_momentum)
  return { themes }
}

export default async function ThemesPage() {
  const { themes } = await fetchData()

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold">동조 상승 테마 바스켓</h1>
          <p className="text-sm text-gray-500 mt-1">
            카테고리를 가로질러 <b>함께 상승하는</b> 키워드 군집(emergent 테마). X = breadth(폭) · Y = momentum(상승
            추진력) · 크기 = cohesion(동조도). 버블 클릭 시 구성 SKU 드릴다운.
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      {themes.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500">
          아직 테마 없음. <code className="text-xs">node scripts/recompute-themes.mjs --apply</code> 로 군집화 후 방문.
        </div>
      ) : (
        <ThemeBubbleMap themes={themes} />
      )}
    </div>
  )
}
