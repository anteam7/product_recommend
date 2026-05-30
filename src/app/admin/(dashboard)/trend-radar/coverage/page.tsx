import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

// supabase/catalog_coverage_rpc.sql 의 반환 row
interface CoverageRow {
  cluster_id: string
  canonical: string
  category_hint: string | null
  total_frequency: number
  member_count: number
  owned_count: number
  selling_count: number
  owned_titles: string[]
  order_qty: number
  order_revenue: number
  max_sim: number
}

const SIM_OPTIONS = [
  { v: 0.15, label: '0.15 (느슨)' },
  { v: 0.2, label: '0.20 (기본)' },
  { v: 0.3, label: '0.30 (엄격)' },
] as const

type Tag = 'gap' | 'cannibal' | 'roi'

function classify(r: CoverageRow): Tag {
  if (r.owned_count === 0) return 'gap'
  if (r.order_qty > 0) return 'roi'
  return 'cannibal'
}

const TAG_META: Record<Tag, { label: string; cls: string; badge: string }> = {
  gap: {
    label: '🟢 확장 1순위',
    cls: 'border-emerald-200 bg-emerald-50/40 hover:bg-emerald-50',
    badge: 'bg-emerald-100 text-emerald-800',
  },
  cannibal: {
    label: '🔴 자기잠식 경보',
    cls: 'border-red-200 bg-red-50/40 hover:bg-red-50',
    badge: 'bg-red-100 text-red-800',
  },
  roi: {
    label: '🔵 검증된 인접 확장',
    cls: 'border-blue-200 bg-blue-50/40 hover:bg-blue-50',
    badge: 'bg-blue-100 text-blue-800',
  },
}

async function fetchCoverage(minSim: number) {
  const sb = createAdminClient()
  // RPC 는 supabase/catalog_coverage_rpc.sql 에 존재하나 generated 타입 미반영 — gen:types 시 캐스팅 제거
  const { data, error } = await sb.rpc('jimscanner_catalog_coverage' as never, {
    min_sim: minSim,
    result_limit: 300,
  } as never)
  if (error) return { rows: [] as CoverageRow[], error: error.message }
  return { rows: (data ?? []) as CoverageRow[], error: null as string | null }
}

function buildHref(override: Record<string, string | null>): string {
  const params = new URLSearchParams()
  for (const [k, v] of Object.entries(override)) {
    if (v != null && v !== '') params.set(k, v)
  }
  const qs = params.toString()
  return '/admin/trend-radar/coverage' + (qs ? `?${qs}` : '')
}

export default async function CoveragePage({
  searchParams,
}: {
  searchParams: Promise<{ sim?: string; tag?: string }>
}) {
  const sp = await searchParams
  const sim = parseFloat(sp.sim ?? '0.2')
  const validSim = SIM_OPTIONS.some((s) => Math.abs(s.v - sim) < 0.001) ? sim : 0.2
  const tagFilter = (['gap', 'cannibal', 'roi'].includes(sp.tag ?? '') ? sp.tag : '') as Tag | ''

  const { rows, error } = await fetchCoverage(validSim)

  const tagged = rows.map((r) => ({ ...r, tag: classify(r) }))
  const visible = tagFilter ? tagged.filter((r) => r.tag === tagFilter) : tagged

  // KPI
  const gapCount = tagged.filter((r) => r.tag === 'gap').length
  const cannibalCount = tagged.filter((r) => r.tag === 'cannibal').length
  const roiCount = tagged.filter((r) => r.tag === 'roi').length
  const totalOwned = tagged.reduce((s, r) => s + r.owned_count, 0)

  // 카테고리 롤업 (수요 색 × 보유 SKU 배지)
  const byCat = new Map<
    string,
    { demand: number; owned: number; gap: number; clusters: number }
  >()
  for (const r of tagged) {
    const key = r.category_hint ?? '(미분류)'
    const cur = byCat.get(key) ?? { demand: 0, owned: 0, gap: 0, clusters: 0 }
    cur.demand += Number(r.total_frequency)
    cur.owned += r.owned_count
    cur.gap += r.tag === 'gap' ? 1 : 0
    cur.clusters += 1
    byCat.set(key, cur)
  }
  const cats = [...byCat.entries()].sort((a, b) => b[1].demand - a[1].demand)
  const maxCatDemand = Math.max(1, ...cats.map(([, c]) => c.demand))
  const maxFreq = Math.max(1, ...tagged.map((r) => Number(r.total_frequency)))

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold">🗺 카탈로그 커버리지 · 자기잠식 맵</h1>
          <p className="text-sm text-gray-500 mt-1">
            발굴 수요(동의어 클러스터) × 내 쿠팡 카탈로그(listings) × 실판매(orders) 오버레이 —
            확장 1순위 / 자기잠식 경보 / 검증된 인접 확장
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Link href="/admin/trend-radar/recommend" className="text-sm text-gray-700 hover:text-black underline">
            위탁 후보 추천 →
          </Link>
          <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
            ← 대시보드
          </Link>
        </div>
      </header>

      <div className="rounded border border-indigo-200 bg-indigo-50 px-4 py-3 text-xs text-indigo-900">
        <strong>왜 이 보드?</strong> 기존 60개 발굴 점수는 전부 외부 시그널만 본다. 이 보드는
        <strong> 내 포트폴리오 대비 상대적 가치</strong>를 더한다 — 아무도(=나도) 안 파는 검증된
        인접 카테고리가 최고 기회, 이미 파는 것과 겹치면 자기 매출을 깎는다.
      </div>

      {/* 필터 */}
      <div className="rounded border border-gray-200 px-4 py-3 space-y-3">
        <div className="flex flex-wrap items-center gap-4">
          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-500">매칭 유사도 ≥</span>
            {SIM_OPTIONS.map((s) => (
              <Link
                key={s.v}
                href={buildHref({ sim: String(s.v), tag: tagFilter || null })}
                className={`px-2 py-1 text-xs rounded ${Math.abs(validSim - s.v) < 0.001 ? 'bg-indigo-100 text-indigo-700 font-semibold' : 'text-gray-500 hover:text-black'}`}
              >
                {s.label}
              </Link>
            ))}
          </div>
          <div className="flex items-center gap-1 border-l border-gray-200 pl-4">
            <span className="text-xs text-gray-500">태그</span>
            <Link
              href={buildHref({ sim: String(validSim), tag: null })}
              className={`px-2 py-1 text-xs rounded ${tagFilter === '' ? 'bg-black text-white font-semibold' : 'text-gray-500 hover:text-black'}`}
            >
              전체
            </Link>
            {(['gap', 'roi', 'cannibal'] as Tag[]).map((t) => (
              <Link
                key={t}
                href={buildHref({ sim: String(validSim), tag: tagFilter === t ? null : t })}
                className={`px-2 py-1 text-xs rounded ${tagFilter === t ? `${TAG_META[t].badge} font-semibold` : 'text-gray-500 hover:text-black'}`}
              >
                {TAG_META[t].label}
              </Link>
            ))}
          </div>
        </div>
      </div>

      {/* KPI */}
      <section className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <Kpi label="수요 클러스터" value={tagged.length} />
        <Kpi label="🟢 커버리지 공백" value={gapCount} highlight={gapCount > 0} tone="emerald" />
        <Kpi label="🔴 자기잠식 경보" value={cannibalCount} tone="red" />
        <Kpi label="🔵 검증 ROI" value={roiCount} tone="blue" />
        <Kpi label="내 보유 SKU(매칭)" value={totalOwned} />
      </section>

      {/* 에러 */}
      {error && (
        <div className="rounded border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800">
          RPC 에러: <code className="font-mono text-xs">{error}</code>
          <p className="text-xs mt-2 text-red-700">
            RPC <code>jimscanner_catalog_coverage</code> 미적용 가능성 — supabase/catalog_coverage_rpc.sql 적용 필요.
          </p>
        </div>
      )}

      {/* 카테고리 트리맵 (수요 색 × 보유 SKU 배지) */}
      {cats.length > 0 && (
        <section className="space-y-2">
          <div className="text-xs font-semibold text-gray-700">카테고리 수요 × 내 보유 SKU</div>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
            {cats.map(([name, c]) => {
              const intensity = c.demand / maxCatDemand // 0~1
              const bg = `rgba(99, 102, 241, ${0.08 + intensity * 0.55})`
              return (
                <div
                  key={name}
                  className="rounded border border-indigo-100 p-3 flex flex-col justify-between min-h-[84px]"
                  style={{ backgroundColor: bg }}
                  title={`수요합(freq) ${c.demand} · 클러스터 ${c.clusters}`}
                >
                  <div className="text-sm font-semibold text-gray-900 truncate">{name}</div>
                  <div className="flex items-center justify-between mt-2">
                    <span className="text-[11px] text-gray-700">
                      보유 <strong>{c.owned}</strong> SKU
                    </span>
                    {c.gap > 0 && (
                      <span className="text-[10px] bg-emerald-600 text-white px-1.5 py-0.5 rounded">
                        공백 {c.gap}
                      </span>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </section>
      )}

      {/* 클러스터 리스트 */}
      {!error && visible.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500 space-y-2">
          <div className="text-base font-medium">표시할 클러스터 없음</div>
          <div className="text-xs text-gray-400">
            jimscanner_synonym_clusters 가 비었거나(야간 synonym-cluster cron 미실행), listings 동기화 미실행일 수 있음.
            min_sim 을 0.15 로 낮춰보기.
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          {visible.map((r) => {
            const meta = TAG_META[r.tag]
            const freqPct = Math.round((Number(r.total_frequency) / maxFreq) * 100)
            return (
              <div
                key={r.cluster_id}
                className={`block rounded border overflow-hidden transition-all ${meta.cls}`}
              >
                <div className="flex items-start gap-3 p-3">
                  {/* 수요 바 */}
                  <div className="w-28 flex-shrink-0 pt-1">
                    <div className="h-2 rounded bg-gray-200 overflow-hidden">
                      <div className="h-full bg-indigo-500" style={{ width: `${freqPct}%` }} />
                    </div>
                    <div className="text-[10px] text-gray-500 font-mono mt-1">
                      freq {r.total_frequency} · 멤버 {r.member_count}
                    </div>
                  </div>

                  {/* 본문 */}
                  <div className="flex-1 min-w-0 space-y-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-semibold">{r.canonical}</span>
                      {r.category_hint && (
                        <span className="text-[11px] text-gray-500">{r.category_hint}</span>
                      )}
                      <span className={`text-[11px] px-2 py-0.5 rounded ${meta.badge}`}>
                        {meta.label}
                      </span>
                    </div>
                    {r.owned_titles.length > 0 && (
                      <div className="text-xs text-gray-500 truncate" title={r.owned_titles.join(' · ')}>
                        보유: {r.owned_titles.join(' · ')}
                      </div>
                    )}
                    {r.tag === 'gap' && (
                      <div className="text-xs text-emerald-700">
                        수요 있는데 내 SKU 0개 — 검증 안 됐지만 미점유 인접 확장 후보.
                      </div>
                    )}
                    {r.tag === 'cannibal' && (
                      <div className="text-xs text-red-700">
                        이미 {r.owned_count}개 보유(실판매 0) — 신규 후보 등록 시 기존 노출·바이박스 잠식 위험.
                      </div>
                    )}
                    {r.tag === 'roi' && (
                      <div className="text-xs text-blue-700">
                        실판매 검증됨 — 같은 클러스터/인접 변형 확장 안전. 카탈로그 ROI 우선.
                      </div>
                    )}
                  </div>

                  {/* 보유 · 판매 지표 */}
                  <div className="text-right flex-shrink-0 space-y-1 w-32">
                    <div className="text-xs text-gray-500">
                      보유 <strong className="text-gray-900">{r.owned_count}</strong>
                      {r.selling_count > 0 && (
                        <span className="text-emerald-600"> (판매중 {r.selling_count})</span>
                      )}
                    </div>
                    {r.order_qty > 0 ? (
                      <>
                        <div className="text-base font-bold text-blue-700 font-mono">
                          {r.order_qty}건
                        </div>
                        <div className="text-[10px] text-gray-500 font-mono">
                          ₩{Math.round(Number(r.order_revenue)).toLocaleString()}
                        </div>
                      </>
                    ) : (
                      <div className="text-[11px] text-gray-400">실판매 없음</div>
                    )}
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* 설명 */}
      <section className="text-xs text-gray-500 border-t border-gray-200 pt-4 space-y-1">
        <div className="font-semibold text-gray-700">📐 분류 규칙</div>
        <code className="block bg-gray-50 px-3 py-2 rounded font-mono text-[11px] leading-relaxed">
          매칭 = listing.registered_title % cluster.canonical_label (또는 member_terms 최댓값) ≥ min_sim
          <br />
          🟢 공백(gap)      = owned_count == 0           → 미점유 확장 1순위
          <br />
          🔴 자기잠식        = owned_count {'>'} 0 AND orders == 0 → 신규 등록 시 기존 SKU 잠식 위험
          <br />
          🔵 검증 ROI       = orders {'>'} 0              → 실판매 검증된 인접 확장
        </code>
      </section>
    </div>
  )
}

function Kpi({
  label,
  value,
  highlight = false,
  tone,
}: {
  label: string
  value: number | string
  highlight?: boolean
  tone?: 'emerald' | 'red' | 'blue'
}) {
  const toneCls =
    tone === 'emerald'
      ? 'text-emerald-700'
      : tone === 'red'
        ? 'text-red-700'
        : tone === 'blue'
          ? 'text-blue-700'
          : ''
  return (
    <div className={`rounded border p-3 ${highlight ? 'border-emerald-300 bg-emerald-50' : 'border-gray-200'}`}>
      <div className="text-xs text-gray-500">{label}</div>
      <div className={`text-2xl font-bold mt-1 ${toneCls}`}>
        {typeof value === 'number' ? value.toLocaleString() : value}
      </div>
    </div>
  )
}
