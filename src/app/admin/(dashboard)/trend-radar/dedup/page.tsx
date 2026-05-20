import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import DedupRowActions from './DedupRowActions'

export const dynamic = 'force-dynamic'

interface DedupCandidate {
  product_a_id: string
  product_b_id: string
  product_a_name: string
  product_b_name: string
  product_a_category: string
  product_b_category: string
  product_a_image: string | null
  product_b_image: string | null
  product_a_score: number
  product_b_score: number
  product_a_alias_count: number
  product_b_alias_count: number
  max_similarity: number
  same_category: boolean
  score_diff: number
}

async function fetchCandidates(minSim: number, limit: number) {
  const sb = createAdminClient()
  const { data, error } = await sb.rpc('jimscanner_dedup_candidates' as never, {
    min_sim: minSim,
    result_limit: limit,
  } as never)
  if (error) return { rows: [] as DedupCandidate[], error: error.message, hasFn: false }
  return { rows: (data ?? []) as DedupCandidate[], error: null, hasFn: true }
}

async function fetchImageStats() {
  const sb = createAdminClient()
  // 이미지 인프라 진척 KPI
  const totalRes = await sb
    .from('jimscanner_trends_product_images' as never)
    .select('*', { count: 'exact', head: true })
  const embeddedRes = await sb
    .from('jimscanner_trends_product_images' as never)
    .select('*', { count: 'exact', head: true })
    .not('embedding', 'is', null)
  return {
    total: totalRes.count ?? 0,
    embedded: embeddedRes.count ?? 0,
    available: !totalRes.error,
  }
}

export default async function DedupPage({
  searchParams,
}: {
  searchParams: Promise<{ sim?: string; limit?: string }>
}) {
  const sp = await searchParams
  const minSim = Math.min(0.99, Math.max(0.5, parseFloat(sp.sim ?? '0.85') || 0.85))
  const limit = Math.min(200, Math.max(10, parseInt(sp.limit ?? '50', 10) || 50))

  const [{ rows, error, hasFn }, stats] = await Promise.all([
    fetchCandidates(minSim, limit),
    fetchImageStats(),
  ])

  const SIM_TABS = [0.95, 0.9, 0.85, 0.8, 0.75]

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between flex-wrap gap-2">
        <div>
          <Link href="/admin/trend-radar" className="text-sm text-gray-500 hover:text-black">
            ← 대시보드
          </Link>
          <h1 className="text-2xl font-bold mt-1">🪞 이미지 dedup 보드</h1>
          <p className="text-sm text-gray-500 mt-1">
            텍스트 alias 가 못 잡는 시각적 중복 product. cosine ≥ {minSim.toFixed(2)} 인 쌍을
            머지하면 final_score Top 리스트의 발굴 폭이 넓어진다.
          </p>
        </div>
        <div className="text-xs text-gray-500 text-right">
          <div>이미지 적재: <span className="font-mono text-gray-800">{stats.total.toLocaleString()}</span></div>
          <div>임베딩 완료: <span className="font-mono text-gray-800">{stats.embedded.toLocaleString()}</span></div>
        </div>
      </header>

      {/* sim threshold 탭 */}
      <nav className="flex gap-2 border-b border-gray-200">
        {SIM_TABS.map((s) => (
          <Link
            key={s}
            href={`/admin/trend-radar/dedup?sim=${s}`}
            className={`px-3 py-2 text-sm ${
              Math.abs(s - minSim) < 0.001
                ? 'border-b-2 border-black font-semibold text-black'
                : 'text-gray-500 hover:text-black'
            }`}
          >
            ≥ {s.toFixed(2)}
          </Link>
        ))}
      </nav>

      {!hasFn || error ? (
        <div className="rounded border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
          <p className="font-semibold">dedup RPC 미적용</p>
          <p className="mt-1">
            <code className="px-1 bg-amber-100 rounded">supabase/trends_v5_dedup_images.sql</code>{' '}
            를 적용한 뒤 다시 진입해 주세요.
          </p>
          {error && <p className="mt-2 text-xs font-mono text-amber-800">err: {error}</p>}
        </div>
      ) : rows.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500">
          <p className="text-base font-medium">cosine ≥ {minSim.toFixed(2)} 인 후보가 없습니다</p>
          <p className="text-sm mt-2">
            아직 이미지가 충분히 임베딩되지 않았거나, 시각적 중복이 정말 없을 수 있습니다.
          </p>
          <p className="text-xs mt-4 text-gray-400">
            임베딩 재실행:{' '}
            <code className="px-1 bg-gray-100 rounded">
              node --env-file=.env.local scripts/embed-product-images.mjs --limit 500
            </code>
          </p>
        </div>
      ) : (
        <section className="space-y-3">
          <p className="text-xs text-gray-500">
            {rows.length}개 후보 · 유사도 높은 순 정렬 · 카테고리 불일치 쌍은 빨간 라벨
          </p>
          {rows.map((r) => (
            <DedupCard key={`${r.product_a_id}-${r.product_b_id}`} row={r} />
          ))}
        </section>
      )}
    </div>
  )
}

function DedupCard({ row }: { row: DedupCandidate }) {
  const simPct = (row.max_similarity * 100).toFixed(1)
  return (
    <div className="rounded border border-gray-200 p-4 hover:border-gray-300 transition-colors">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <span className="text-xs px-2 py-0.5 rounded bg-blue-100 text-blue-700 font-mono">
            sim {simPct}%
          </span>
          {row.same_category ? (
            <span className="text-xs px-2 py-0.5 rounded bg-gray-100 text-gray-600">
              같은 카테고리
            </span>
          ) : (
            <span className="text-xs px-2 py-0.5 rounded bg-red-100 text-red-700">
              ⚠ 카테고리 불일치
            </span>
          )}
          <span className="text-xs text-gray-500">Δscore {row.score_diff.toFixed(1)}</span>
        </div>
        <DedupRowActions
          productAId={row.product_a_id}
          productBId={row.product_b_id}
          productAName={row.product_a_name}
          productBName={row.product_b_name}
        />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <ProductSide
          id={row.product_a_id}
          name={row.product_a_name}
          category={row.product_a_category}
          image={row.product_a_image}
          score={row.product_a_score}
          aliasCount={row.product_a_alias_count}
        />
        <ProductSide
          id={row.product_b_id}
          name={row.product_b_name}
          category={row.product_b_category}
          image={row.product_b_image}
          score={row.product_b_score}
          aliasCount={row.product_b_alias_count}
        />
      </div>
    </div>
  )
}

function ProductSide({
  id,
  name,
  category,
  image,
  score,
  aliasCount,
}: {
  id: string
  name: string
  category: string
  image: string | null
  score: number
  aliasCount: number
}) {
  return (
    <Link
      href={`/admin/trend-radar/products/${id}`}
      className="flex gap-3 items-start rounded border border-gray-100 p-2 hover:bg-gray-50"
    >
      <div className="w-20 h-20 rounded bg-gray-100 overflow-hidden flex items-center justify-center shrink-0">
        {image ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={image} alt={name} className="w-full h-full object-cover" />
        ) : (
          <span className="text-xs text-gray-400">no img</span>
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="font-medium text-sm truncate">{name}</div>
        <div className="text-xs text-gray-500 mt-0.5">{category}</div>
        <div className="text-xs text-gray-500 mt-1">
          score <span className="font-mono font-bold text-gray-800">{score.toFixed(1)}</span>
          {' · '}alias <span className="font-mono">{aliasCount}</span>
        </div>
      </div>
    </Link>
  )
}
