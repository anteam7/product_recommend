import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

// 협찬·체험단 노이즈 필터 보드.
// 단일 소스(특히 naver_blog) 내부의 광고성 비중을 분해해, 빈도가 '실수요'가 아닌
// '셀러 마케팅 강도'로 부풀려진 키워드를 발굴 큐에서 강등하고,
// organic 비율 높은 자연발생 수요를 위탁 발굴 우선으로 노출한다.

interface AuthRow {
  id: string
  canonical_label: string
  category_hint: string | null
  member_count: number
  source_count: number
  total_frequency: number
  organic_frequency: number
  sponsored_frequency: number
  organic_ratio: number
  authenticity_tier: 'organic' | 'mixed' | 'sponsored' | 'thin'
  refreshed_at: string
}

const CATEGORIES = ['all', 'health', 'living', 'digital', 'other'] as const
type Category = (typeof CATEGORIES)[number]

const CATEGORY_LABEL: Record<Category, string> = {
  all: '전체',
  health: '건강식품',
  living: '생활/리빙',
  digital: '디지털/가전',
  other: '기타',
}

const TIER_META: Record<
  AuthRow['authenticity_tier'],
  { label: string; color: string; badge: string }
> = {
  organic: { label: '자연발생 — 발굴 우선', color: 'text-green-700', badge: 'bg-green-100 text-green-700' },
  mixed: { label: '혼재', color: 'text-yellow-700', badge: 'bg-yellow-100 text-yellow-700' },
  sponsored: { label: '광고 과열 — 강등', color: 'text-red-700', badge: 'bg-red-100 text-red-700' },
  thin: { label: '신호 빈약', color: 'text-gray-400', badge: 'bg-gray-100 text-gray-500' },
}

async function fetchData(category: Category) {
  const sb = createAdminClient()
  const q = sb
    .from('jimscanner_cluster_authenticity' as never)
    .select(
      'id, canonical_label, category_hint, member_count, source_count, total_frequency, organic_frequency, sponsored_frequency, organic_ratio, authenticity_tier, refreshed_at',
    )
    .gte('total_frequency', 1)
    .order('organic_frequency', { ascending: false })
    .limit(200)
  if (category !== 'all') q.eq('category_hint', category)
  const { data } = (await q) as { data: AuthRow[] | null }
  const rows = (data ?? []) as AuthRow[]

  const organicCount = rows.filter((r) => r.authenticity_tier === 'organic').length
  const sponsoredCount = rows.filter((r) => r.authenticity_tier === 'sponsored').length
  const totalFreq = rows.reduce((s, r) => s + r.total_frequency, 0)
  const organicFreq = rows.reduce((s, r) => s + r.organic_frequency, 0)
  const blendedRatio = totalFreq > 0 ? organicFreq / totalFreq : 1

  return { rows, kpis: { organicCount, sponsoredCount, blendedRatio } }
}

export default async function AuthenticityPage({
  searchParams,
}: {
  searchParams: Promise<{ cat?: string }>
}) {
  const sp = await searchParams
  const category = (CATEGORIES.includes(sp.cat as Category) ? sp.cat : 'all') as Category
  const { rows, kpis } = await fetchData(category)

  // 발굴 우선 큐: organic_frequency 기준 정렬은 이미 fetch 에서. thin 은 하단으로.
  const sorted = [...rows].sort((a, b) => {
    const aThin = a.authenticity_tier === 'thin' ? 1 : 0
    const bThin = b.authenticity_tier === 'thin' ? 1 : 0
    if (aThin !== bThin) return aThin - bThin
    return b.organic_frequency - a.organic_frequency
  })

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold">신호 진정성 (협찬 필터)</h1>
          <p className="text-sm text-gray-500 mt-1">
            blog·news 협찬/체험단 노이즈를 분해 → organic 수요만 가중. 광고 과열 키워드는 발굴 큐 강등.
          </p>
        </div>
        <div className="flex gap-3 text-sm">
          <Link href="/admin/trend-radar/synonyms" className="text-gray-700 hover:text-black underline">
            의미군 통합 수요
          </Link>
          <Link href="/admin/trend-radar" className="text-gray-700 hover:text-black underline">
            ← 대시보드
          </Link>
        </div>
      </header>

      <section className="grid grid-cols-2 md:grid-cols-3 gap-4">
        <KpiCard
          label="organic 키워드"
          value={kpis.organicCount}
          hint="organic_ratio ≥ 0.7 — 위탁 발굴 우선"
        />
        <KpiCard
          label="광고 과열 키워드"
          value={kpis.sponsoredCount}
          hint="organic_ratio < 0.4 — 큐 강등"
        />
        <KpiCard
          label="전체 organic 비율"
          value={`${Math.round(kpis.blendedRatio * 100)}%`}
          hint={`category=${category}`}
        />
      </section>

      <nav className="flex gap-2 border-b border-gray-200">
        {CATEGORIES.map((c) => (
          <Link
            key={c}
            href={`/admin/trend-radar/authenticity?cat=${c}`}
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

      {sorted.length === 0 ? (
        <EmptyState />
      ) : (
        <section className="space-y-2">
          <div className="grid grid-cols-12 text-xs text-gray-500 px-3 py-1">
            <div className="col-span-1">#</div>
            <div className="col-span-3">대표 라벨</div>
            <div className="col-span-3">organic vs sponsored</div>
            <div className="col-span-1 text-right">organic</div>
            <div className="col-span-1 text-right">합산</div>
            <div className="col-span-1 text-right">비율</div>
            <div className="col-span-2 text-right">판정</div>
          </div>
          {sorted.map((r, i) => {
            const tier = TIER_META[r.authenticity_tier]
            const organicPct = r.total_frequency > 0 ? (r.organic_frequency / r.total_frequency) * 100 : 100
            return (
              <div
                key={r.id}
                className="grid grid-cols-12 px-3 py-2 rounded border border-gray-200 hover:bg-gray-50 transition-colors text-sm items-center"
              >
                <div className="col-span-1 font-mono text-gray-400">{i + 1}</div>
                <div className="col-span-3">
                  <div className="font-medium">{r.canonical_label}</div>
                  <div className="text-xs text-gray-500">
                    {r.category_hint ?? '—'} · 멤버 {r.member_count} · 소스 {r.source_count}
                  </div>
                </div>
                <div className="col-span-3 pr-3">
                  <StackBar organicPct={organicPct} />
                </div>
                <div className="col-span-1 text-right font-mono font-bold text-green-700">
                  {r.organic_frequency.toFixed(1)}
                </div>
                <div className="col-span-1 text-right font-mono text-gray-500">{r.total_frequency}</div>
                <div className={`col-span-1 text-right font-mono font-semibold ${tier.color}`}>
                  {Math.round(r.organic_ratio * 100)}%
                </div>
                <div className="col-span-2 text-right">
                  <span className={`text-xs px-2 py-0.5 rounded ${tier.badge}`}>{tier.label}</span>
                </div>
              </div>
            )
          })}
        </section>
      )}
    </div>
  )
}

function StackBar({ organicPct }: { organicPct: number }) {
  const org = Math.max(0, Math.min(100, organicPct))
  return (
    <div className="flex h-4 w-full overflow-hidden rounded bg-gray-100" title={`organic ${org.toFixed(0)}% / sponsored ${(100 - org).toFixed(0)}%`}>
      <div className="bg-green-500" style={{ width: `${org}%` }} />
      <div className="bg-red-400" style={{ width: `${100 - org}%` }} />
    </div>
  )
}

function KpiCard({ label, value, hint }: { label: string; value: number | string; hint: string }) {
  return (
    <div className="rounded border border-gray-200 p-4">
      <div className="text-xs text-gray-500">{label}</div>
      <div className="text-3xl font-bold mt-1">
        {typeof value === 'number' ? value.toLocaleString() : value}
      </div>
      <div className="text-xs text-gray-400 mt-1">{hint}</div>
    </div>
  )
}

function EmptyState() {
  return (
    <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500">
      <p className="text-base font-medium">아직 분해할 클러스터가 없습니다</p>
      <p className="text-sm mt-2">
        야간 cron <code className="px-1 bg-gray-100 rounded">scripts/synonym-cluster.mjs</code> 가
        시그널별 <code className="px-1 bg-gray-100 rounded">ad_probability</code> 를 매기고
        organic 디스카운트를 적재합니다.
      </p>
      <p className="text-xs mt-4 text-gray-400">
        마이그레이션: <code className="px-1 bg-gray-100 rounded">supabase/synonym_clusters_authenticity.sql</code>
      </p>
    </div>
  )
}
