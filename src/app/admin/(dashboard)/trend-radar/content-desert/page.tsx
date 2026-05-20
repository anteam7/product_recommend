import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import ContentDesertScatter from './ContentDesertScatter'

export const dynamic = 'force-dynamic'

const CATEGORIES = ['all', 'health', 'living', 'digital'] as const
type Category = (typeof CATEGORIES)[number]

const CATEGORY_LABEL: Record<Category, string> = {
  all: '전체',
  health: '건강식품',
  living: '생활/리빙',
  digital: '디지털/가전',
}

export interface GapRow {
  product_id: string
  canonical_name: string | null
  category_top: string | null
  category_mid: string | null
  intent_label: string | null
  keyword: string
  volume_relative_max: number | null
  volume_relative_avg: number | null
  vol_14d: number | null
  vol_30d: number | null
  last_seen_at: string | null
  blog_count: number
  news_count: number
  suggest_count: number
  content_count: number
  own_blog_count: number
  demand_z: number | null
  gap_score: number | null
  has_ggsan_match: boolean
  is_pinned: boolean
}

async function fetchGap(category: Category): Promise<GapRow[]> {
  const sb = createAdminClient()

  let query = (sb.from as any)('jimscanner_content_gap_v')
    .select(
      'product_id, canonical_name, category_top, category_mid, intent_label, keyword, volume_relative_max, volume_relative_avg, vol_14d, vol_30d, last_seen_at, blog_count, news_count, suggest_count, content_count, own_blog_count, demand_z, gap_score, has_ggsan_match, is_pinned'
    )
    .order('gap_score', { ascending: false })
    .limit(500)

  if (category !== 'all') query = query.eq('category_top', category)

  const { data, error } = await query
  if (error) {
    console.error('[content-desert] fetch error', error)
    return []
  }
  return (data ?? []) as GapRow[]
}

export default async function ContentDesertPage({
  searchParams,
}: {
  searchParams: Promise<{ cat?: string }>
}) {
  const sp = await searchParams
  const category = (CATEGORIES.includes(sp.cat as Category) ? sp.cat : 'all') as Category

  const rows = await fetchGap(category)

  const top30 = rows.slice(0, 30)
  const sweetSpot = rows.filter(
    (r) => (r.demand_z ?? 0) >= 0.5 && (r.content_count ?? 0) <= 3
  )

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold">콘텐츠 사막 발굴</h1>
          <p className="text-sm text-gray-500 mt-1">
            수요(volume_relative z-score) ↑ 한국어 콘텐츠 ↓ — SEO 사각지대 키워드 발굴.
            <br />
            gap_score = demand_z − ln(1+content_count). LLM 분류 완료 키워드만 표시.
          </p>
        </div>
        <Link
          href="/admin/trend-radar"
          className="text-sm text-gray-700 hover:text-black underline"
        >
          ← 대시보드
        </Link>
      </header>

      {/* KPI */}
      <section className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <KpiCard label="후보 키워드" value={rows.length} hint="LLM 분류 완료 + 수요 ≥ 0" />
        <KpiCard
          label="스위트 스팟"
          value={sweetSpot.length}
          hint="demand_z ≥ 0.5 & content ≤ 3"
        />
        <KpiCard
          label="ggsan 매칭"
          value={rows.filter((r) => r.has_ggsan_match).length}
          hint="vendor 후보 존재"
        />
        <KpiCard
          label="핀 상태"
          value={rows.filter((r) => r.is_pinned).length}
          hint="기존 핀 누적"
        />
      </section>

      {/* 카테고리 탭 */}
      <nav className="flex gap-2 border-b border-gray-200">
        {CATEGORIES.map((c) => (
          <Link
            key={c}
            href={`/admin/trend-radar/content-desert?cat=${c}`}
            className={`px-3 py-2 text-sm ${
              category === c
                ? 'border-b-2 border-black font-semibold text-black'
                : 'text-gray-500 hover:text-black'
            }`}
          >
            {CATEGORY_LABEL[c]}
          </Link>
        ))}
      </nav>

      {rows.length === 0 ? (
        <EmptyState />
      ) : (
        <div className="grid gap-6 lg:grid-cols-2">
          <ContentDesertScatter rows={rows} />
          <Top30Table rows={top30} />
        </div>
      )}
    </div>
  )
}

function Top30Table({ rows }: { rows: GapRow[] }) {
  return (
    <div className="rounded border border-gray-200 p-4">
      <h3 className="text-sm font-semibold mb-3">
        Top 30 (gap_score 내림차순)
      </h3>
      <div className="space-y-1">
        <div className="grid grid-cols-12 text-xs text-gray-500 px-2 py-1">
          <div className="col-span-4">키워드</div>
          <div className="col-span-2">카테고리</div>
          <div className="col-span-1 text-right">수요z</div>
          <div className="col-span-1 text-right">콘텐츠</div>
          <div className="col-span-2 text-right">gap</div>
          <div className="col-span-1 text-center">ggsan</div>
          <div className="col-span-1 text-center">핀</div>
        </div>
        {rows.map((r) => (
          <Link
            key={r.keyword}
            href={`/admin/trend-radar/products/${r.product_id}`}
            className="grid grid-cols-12 px-2 py-1.5 text-sm rounded hover:bg-gray-50"
          >
            <div className="col-span-4 truncate">
              <div className="font-medium truncate">{r.keyword}</div>
              {r.canonical_name && r.canonical_name !== r.keyword && (
                <div className="text-xs text-gray-400 truncate">
                  → {r.canonical_name}
                </div>
              )}
            </div>
            <div className="col-span-2 text-xs text-gray-500">
              {r.category_top ?? '-'}
            </div>
            <div className="col-span-1 text-right font-mono text-xs">
              {fmt(r.demand_z)}
            </div>
            <div className="col-span-1 text-right font-mono text-xs">
              {r.content_count}
            </div>
            <div className="col-span-2 text-right font-mono font-bold">
              {fmt(r.gap_score)}
            </div>
            <div className="col-span-1 text-center text-xs">
              {r.has_ggsan_match ? '✓' : '·'}
            </div>
            <div className="col-span-1 text-center text-xs">
              {r.is_pinned ? '📌' : '·'}
            </div>
          </Link>
        ))}
      </div>
    </div>
  )
}

function KpiCard({
  label,
  value,
  hint,
}: {
  label: string
  value: number
  hint: string
}) {
  return (
    <div className="rounded border border-gray-200 p-4">
      <div className="text-xs text-gray-500">{label}</div>
      <div className="text-3xl font-bold mt-1">{value.toLocaleString()}</div>
      <div className="text-xs text-gray-400 mt-1">{hint}</div>
    </div>
  )
}

function EmptyState() {
  return (
    <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500">
      <p className="text-base font-medium">아직 데이터 없음</p>
      <p className="text-sm mt-2">
        MV jimscanner_content_gap_v 미생성 또는 LLM 분류 완료 키워드 0.
        <br />
        <code className="px-1 bg-gray-100 rounded text-xs">
          supabase/content_desert.sql
        </code>
        {' '}적용 후 1회/일 REFRESH 필요.
      </p>
    </div>
  )
}

function fmt(v: number | null | undefined) {
  if (v === null || v === undefined) return '-'
  return Number(v).toFixed(2)
}
