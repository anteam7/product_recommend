import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import { PromoteButtons } from './PromoteButtons'

export const dynamic = 'force-dynamic'

interface NeedRow {
  id: string
  source: string
  source_post_ref: string | null
  raw_excerpt: string
  need_text: string
  need_type: 'request' | 'complaint' | 'gap'
  category_guess: string | null
  intensity: number
  extracted_at: string
  promoted_seed_id: string | null
}

const CATEGORIES = ['all', 'health', 'living', 'digital', 'fashion', 'food', 'service', 'other'] as const
type Category = (typeof CATEGORIES)[number]

const CATEGORY_LABEL: Record<Category, string> = {
  all: '전체',
  health: '건강',
  living: '생활',
  digital: '디지털',
  fashion: '패션',
  food: '식품',
  service: '서비스',
  other: '기타',
}

const TYPE_BADGE: Record<NeedRow['need_type'], { label: string; cls: string }> = {
  request: { label: '요청', cls: 'bg-blue-50 text-blue-700 border-blue-200' },
  complaint: { label: '불만', cls: 'bg-red-50 text-red-700 border-red-200' },
  gap: { label: '갭', cls: 'bg-amber-50 text-amber-700 border-amber-200' },
}

async function fetchData(category: Category) {
  // generated 타입에 jimscanner_unmet_needs 미반영 → as any 우회
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sb = createAdminClient() as any
  const since = new Date(Date.now() - 7 * 86400_000).toISOString()

  let q = sb
    .from('jimscanner_unmet_needs')
    .select(
      'id, source, source_post_ref, raw_excerpt, need_text, need_type, category_guess, intensity, extracted_at, promoted_seed_id',
    )
    .gte('extracted_at', since)
    .order('extracted_at', { ascending: false })
    .limit(2000)
  if (category !== 'all') q = q.eq('category_guess', category)

  const { data, error } = await q

  if (error) {
    return { rows: [] as NeedRow[], error: error.message as string, kpis: emptyKpis() }
  }
  const rows = (data ?? []) as NeedRow[]

  const kpis = {
    total: rows.length,
    pending: rows.filter((r) => !r.promoted_seed_id).length,
    promoted: rows.filter((r) => r.promoted_seed_id).length,
    highIntensity: rows.filter((r) => r.intensity >= 0.7).length,
  }
  return { rows, error: null as string | null, kpis }
}

function emptyKpis() {
  return { total: 0, pending: 0, promoted: 0, highIntensity: 0 }
}

interface Cluster {
  need_text: string
  category: string | null
  type: NeedRow['need_type']
  count: number
  intensityAvg: number
  intensityMax: number
  lastAt: string
  promoted: boolean
  examples: NeedRow[]
}

function clusterByNeed(rows: NeedRow[]): Cluster[] {
  const map = new Map<string, Cluster>()
  for (const r of rows) {
    const key = r.need_text
    let c = map.get(key)
    if (!c) {
      c = {
        need_text: r.need_text,
        category: r.category_guess,
        type: r.need_type,
        count: 0,
        intensityAvg: 0,
        intensityMax: 0,
        lastAt: r.extracted_at,
        promoted: !!r.promoted_seed_id,
        examples: [],
      }
      map.set(key, c)
    }
    c.count++
    c.intensityAvg += Number(r.intensity) || 0
    c.intensityMax = Math.max(c.intensityMax, Number(r.intensity) || 0)
    if (r.extracted_at > c.lastAt) c.lastAt = r.extracted_at
    if (r.promoted_seed_id) c.promoted = true
    if (c.examples.length < 3) c.examples.push(r)
  }
  const list = [...map.values()].map((c) => ({
    ...c,
    intensityAvg: c.count > 0 ? c.intensityAvg / c.count : 0,
  }))
  // score = count * (0.5 + intensityMax) — 반복 + 강도 가중
  list.sort(
    (a, b) =>
      b.count * (0.5 + b.intensityMax) - a.count * (0.5 + a.intensityMax) ||
      b.intensityMax - a.intensityMax,
  )
  return list
}

export default async function UnmetNeedsPage({
  searchParams,
}: {
  searchParams: Promise<{ cat?: string }>
}) {
  const sp = await searchParams
  const category = (CATEGORIES.includes(sp.cat as Category) ? sp.cat : 'all') as Category

  const { rows, error, kpis } = await fetchData(category)
  const clusters = clusterByNeed(rows)

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-2xl font-bold">Unmet-Needs 보드</h1>
          <p className="text-sm text-gray-500 mt-1">
            커뮤니티 게시글(82cook · natepan · ppomppu · dcinside · aliex_best · clien · quasarzone)에서
            추출한 미충족 수요. 같은 need 가 ≥3 게시글에서 반복되면 seed 후보로 자동 승격.
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      {error && (
        <div className="rounded border border-red-300 bg-red-50 p-4 text-sm text-red-700">
          데이터 로드 실패: {error}
          <div className="text-xs text-red-500 mt-1">
            DB 마이그레이션 (<code>supabase/trends_unmet_needs.sql</code>) 적용 여부 확인.
          </div>
        </div>
      )}

      <section className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <KpiCard label="추출 (7d)" value={kpis.total} hint="윈도우 누적" />
        <KpiCard label="검토 대기" value={kpis.pending} hint="seed 미승격" />
        <KpiCard label="seed 승격" value={kpis.promoted} hint="자동 + 수동" />
        <KpiCard label="고강도 (≥0.7)" value={kpis.highIntensity} hint="감정·반복 강함" />
      </section>

      <nav className="flex gap-2 border-b border-gray-200 flex-wrap">
        {CATEGORIES.map((c) => (
          <Link
            key={c}
            href={`/admin/trend-radar/unmet-needs?cat=${c}`}
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

      {clusters.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500">
          <p className="text-base font-medium">아직 추출된 need 가 없습니다</p>
          <p className="text-sm mt-2">
            로컬에서 추출 실행:
            <br />
            <code className="inline-block mt-2 px-2 py-1 bg-gray-100 rounded text-xs">
              node --env-file=.env.local scripts/extract-unmet-needs.mjs
            </code>
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {clusters.slice(0, 100).map((c) => (
            <ClusterCard key={c.need_text} cluster={c} />
          ))}
        </div>
      )}
    </div>
  )
}

function ClusterCard({ cluster }: { cluster: Cluster }) {
  const badge = TYPE_BADGE[cluster.type]
  const intensityPct = Math.round(cluster.intensityMax * 100)
  return (
    <div className="rounded border border-gray-200 p-4 hover:border-gray-300 transition-colors">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className={`px-2 py-0.5 text-[10px] font-semibold rounded border ${badge.cls}`}>
              {badge.label}
            </span>
            <span className="px-2 py-0.5 text-[10px] font-mono rounded bg-gray-100 text-gray-600">
              {cluster.category ?? 'other'}
            </span>
            <span className="text-xs text-gray-500">
              {cluster.count}건 · 최근 {cluster.lastAt.slice(5, 10)}
            </span>
          </div>
          <div className="font-medium text-base mt-2">{cluster.need_text}</div>
          <div className="mt-2 h-1.5 w-full bg-gray-100 rounded overflow-hidden">
            <div
              className={`h-full ${intensityPct >= 70 ? 'bg-red-500' : intensityPct >= 40 ? 'bg-amber-500' : 'bg-gray-400'}`}
              style={{ width: `${intensityPct}%` }}
            />
          </div>
          <div className="text-[10px] text-gray-400 mt-0.5 font-mono">
            intensity max {intensityPct}% · avg {Math.round(cluster.intensityAvg * 100)}%
          </div>
        </div>
        <PromoteButtons
          needText={cluster.need_text}
          category={cluster.category}
          alreadyPromoted={cluster.promoted}
        />
      </div>

      {cluster.examples.length > 0 && (
        <details className="mt-3">
          <summary className="text-xs text-gray-500 cursor-pointer hover:text-black">
            인용 게시글 {cluster.examples.length}건 보기
          </summary>
          <div className="mt-2 space-y-2">
            {cluster.examples.map((ex) => (
              <div key={ex.id} className="text-xs bg-gray-50 rounded px-3 py-2 border border-gray-100">
                <div className="flex items-center gap-2 text-gray-500 mb-1">
                  <span className="font-mono">{ex.source}</span>
                  <span>·</span>
                  <span>{ex.extracted_at.slice(0, 16)}</span>
                  {ex.source_post_ref && ex.source_post_ref.startsWith('http') && (
                    <a
                      href={ex.source_post_ref}
                      target="_blank"
                      rel="noreferrer"
                      className="ml-auto underline hover:text-black"
                    >
                      원본 ↗
                    </a>
                  )}
                </div>
                <div className="text-gray-700 whitespace-pre-wrap line-clamp-3">{ex.raw_excerpt}</div>
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  )
}

function KpiCard({ label, value, hint }: { label: string; value: number; hint: string }) {
  return (
    <div className="rounded border border-gray-200 p-4">
      <div className="text-xs text-gray-500">{label}</div>
      <div className="text-3xl font-bold mt-1">{value.toLocaleString()}</div>
      <div className="text-xs text-gray-400 mt-1">{hint}</div>
    </div>
  )
}
