import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

interface ClusterRow {
  cluster_id: number
  representative_image_url: string | null
  representative_title: string | null
  member_count: number
  source_count: number
  min_cosine: number | null
  has_ggsan: boolean
  has_aliex: boolean
  has_musinsa: boolean
  has_danawa: boolean
  has_domeggook: boolean
  min_price_krw: number | null
  max_price_krw: number | null
  updated_at: string
}

interface MemberRow {
  id: number
  cluster_id: number | null
  source: string
  source_sku_id: string
  image_url: string | null
  title: string | null
  price_krw: number | null
  review_count: number | null
  rank_in_src: number | null
}

const FILTERS = [
  { v: 'all', label: '전체' },
  { v: 'ggsan', label: '도매원 매칭 (ggsan)' },
  { v: 'cross', label: '2개 이상 소스' },
] as const

type FilterKey = (typeof FILTERS)[number]['v']

async function fetchClusters(filter: FilterKey) {
  const sb = createAdminClient()

  // 테이블 generated 타입 미반영 — `as any` 캐스팅 (clouster sql 적용 후 npm run gen:types 시 제거)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sbAny = sb as any
  let q = sbAny
    .from('jimscanner_visual_twin_clusters')
    .select(
      'cluster_id, representative_image_url, representative_title, member_count, source_count, min_cosine, has_ggsan, has_aliex, has_musinsa, has_danawa, has_domeggook, min_price_krw, max_price_krw, updated_at',
    )
    .order('source_count', { ascending: false })
    .order('member_count', { ascending: false })
    .limit(120)

  if (filter === 'ggsan') q = q.eq('has_ggsan', true)
  if (filter === 'cross') q = q.gte('source_count', 2)

  const { data, error } = await q
  if (error) return { clusters: [] as ClusterRow[], error: error.message }
  return { clusters: (data ?? []) as ClusterRow[], error: null as string | null }
}

async function fetchMembers(clusterIds: number[]) {
  if (clusterIds.length === 0) return new Map<number, MemberRow[]>()
  const sb = createAdminClient()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sbAny = sb as any
  const { data, error } = await sbAny
    .from('jimscanner_sku_image_embeddings')
    .select('id, cluster_id, source, source_sku_id, image_url, title, price_krw, review_count, rank_in_src')
    .in('cluster_id', clusterIds)
  if (error) return new Map<number, MemberRow[]>()
  const map = new Map<number, MemberRow[]>()
  for (const r of (data ?? []) as MemberRow[]) {
    if (r.cluster_id == null) continue
    if (!map.has(r.cluster_id)) map.set(r.cluster_id, [])
    map.get(r.cluster_id)!.push(r)
  }
  return map
}

function sourceBadge(source: string) {
  switch (source) {
    case 'ggsan':
      return { label: '🏬 ggsan 도매', cls: 'bg-amber-100 text-amber-800' }
    case 'aliex_best':
      return { label: '🅰 알리', cls: 'bg-orange-100 text-orange-800' }
    case 'musinsa_best':
      return { label: '🅼 무신사', cls: 'bg-indigo-100 text-indigo-800' }
    case 'danawa_main':
      return { label: '💻 다나와', cls: 'bg-blue-100 text-blue-800' }
    case 'domeggook_main':
      return { label: '🛒 도매꾹', cls: 'bg-emerald-100 text-emerald-800' }
    default:
      return { label: source, cls: 'bg-gray-100 text-gray-700' }
  }
}

export default async function VisualTwinsPage({
  searchParams,
}: {
  searchParams: Promise<{ filter?: string }>
}) {
  const sp = await searchParams
  const filter: FilterKey = (FILTERS.find((f) => f.v === sp.filter)?.v ?? 'all') as FilterKey

  const { clusters, error } = await fetchClusters(filter)
  const memberMap = await fetchMembers(clusters.map((c) => c.cluster_id))

  const total = clusters.length
  const ggsanCount = clusters.filter((c) => c.has_ggsan).length
  const crossCount = clusters.filter((c) => c.source_count >= 2).length

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold">🪞 비전 트윈 보드</h1>
          <p className="text-sm text-gray-500 mt-1">
            이미지 임베딩 cosine ≥ 0.88 로 묶은 cross-source 동일 SKU 클러스터.
            도매원(ggsan) 가 함께 묶이면 즉시 마진 판단 가능.
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      <div className="rounded border border-blue-200 bg-blue-50 px-4 py-3 text-xs text-blue-900">
        <strong>실행 의존:</strong>{' '}
        <code className="font-mono">supabase/visual_twin_embeddings.sql</code> 적용 →{' '}
        <code className="font-mono">scripts/embed-sku-images.mjs</code> →{' '}
        <code className="font-mono">scripts/cluster-visual-twins.mjs</code>. 데이터 누적 전까지 빈
        보드가 정상.
      </div>

      {/* 필터 */}
      <div className="rounded border border-gray-200 px-4 py-3">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs text-gray-500">필터</span>
          {FILTERS.map((f) => (
            <Link
              key={f.v}
              href={f.v === 'all' ? '/admin/trend-radar/visual-twins' : `/admin/trend-radar/visual-twins?filter=${f.v}`}
              className={`px-2 py-1 text-xs rounded ${
                filter === f.v ? 'bg-black text-white font-semibold' : 'text-gray-500 hover:text-black'
              }`}
            >
              {f.label}
            </Link>
          ))}
        </div>
      </div>

      {/* KPI */}
      <section className="grid grid-cols-2 md:grid-cols-3 gap-3">
        <Kpi label="클러스터" value={total} />
        <Kpi label="🏬 도매원 매칭" value={ggsanCount} highlight={ggsanCount > 0} />
        <Kpi label="🔀 크로스소스 (≥2)" value={crossCount} />
      </section>

      {error && (
        <div className="rounded border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800">
          쿼리 에러: <code className="font-mono text-xs">{error}</code>
          <p className="text-xs mt-2 text-red-700">
            테이블 미생성 가능성. <code>supabase/visual_twin_embeddings.sql</code> 을 먼저 적용하세요.
          </p>
        </div>
      )}

      {!error && clusters.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500 space-y-2">
          <div className="text-base font-medium">아직 클러스터 없음</div>
          <div className="text-xs text-gray-400">
            embed-sku-images → cluster-visual-twins 두 스크립트를 차례로 돌리면 채워집니다.
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {clusters.map((c) => {
            const members = memberMap.get(c.cluster_id) ?? []
            return (
              <div
                key={c.cluster_id}
                className={`rounded border overflow-hidden ${
                  c.has_ggsan ? 'border-amber-300 bg-amber-50/30' : 'border-gray-200'
                }`}
              >
                <div className="flex items-start gap-3 p-3 border-b border-gray-100">
                  <div className="w-24 h-24 bg-gray-100 rounded overflow-hidden flex-shrink-0">
                    {c.representative_image_url && (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={c.representative_image_url}
                        alt=""
                        loading="lazy"
                        className="w-full h-full object-cover"
                      />
                    )}
                  </div>
                  <div className="flex-1 min-w-0 space-y-1">
                    <div className="text-sm font-medium leading-snug" title={c.representative_title ?? ''}>
                      {c.representative_title ?? `cluster #${c.cluster_id}`}
                    </div>
                    <div className="text-xs text-gray-500">
                      cluster #{c.cluster_id} · {c.member_count}개 SKU · {c.source_count}개 소스 · cosine ≥{' '}
                      {c.min_cosine?.toFixed(3) ?? '—'}
                    </div>
                    {c.min_price_krw != null && c.max_price_krw != null && (
                      <div className="text-xs text-gray-700 font-mono">
                        가격대 {c.min_price_krw.toLocaleString()}원 ~ {c.max_price_krw.toLocaleString()}원
                      </div>
                    )}
                    <div className="flex flex-wrap gap-1 pt-1">
                      {c.has_ggsan && (
                        <span className="bg-amber-200 text-amber-900 text-[10px] px-1.5 py-0.5 rounded font-semibold">
                          🏬 도매원
                        </span>
                      )}
                      {c.has_aliex && (
                        <span className="bg-orange-100 text-orange-800 text-[10px] px-1.5 py-0.5 rounded">알리</span>
                      )}
                      {c.has_musinsa && (
                        <span className="bg-indigo-100 text-indigo-800 text-[10px] px-1.5 py-0.5 rounded">무신사</span>
                      )}
                      {c.has_danawa && (
                        <span className="bg-blue-100 text-blue-800 text-[10px] px-1.5 py-0.5 rounded">다나와</span>
                      )}
                      {c.has_domeggook && (
                        <span className="bg-emerald-100 text-emerald-800 text-[10px] px-1.5 py-0.5 rounded">
                          도매꾹
                        </span>
                      )}
                    </div>
                  </div>
                  <PinForm clusterId={c.cluster_id} title={c.representative_title ?? ''} />
                </div>

                {/* 채널별 매트릭스 */}
                <table className="w-full text-xs">
                  <thead className="bg-gray-50 text-gray-500">
                    <tr>
                      <th className="px-2 py-1 text-left font-medium">채널</th>
                      <th className="px-2 py-1 text-left font-medium">SKU / 상품명</th>
                      <th className="px-2 py-1 text-right font-medium">가격</th>
                      <th className="px-2 py-1 text-right font-medium">리뷰</th>
                      <th className="px-2 py-1 text-right font-medium">순위</th>
                    </tr>
                  </thead>
                  <tbody>
                    {members.map((m) => {
                      const b = sourceBadge(m.source)
                      return (
                        <tr key={m.id} className="border-t border-gray-100">
                          <td className="px-2 py-1">
                            <span className={`${b.cls} px-1.5 py-0.5 rounded text-[10px] font-medium`}>{b.label}</span>
                          </td>
                          <td className="px-2 py-1 truncate max-w-[18rem]" title={m.title ?? ''}>
                            <div className="font-mono text-[10px] text-gray-400">{m.source_sku_id}</div>
                            <div>{m.title ?? '—'}</div>
                          </td>
                          <td className="px-2 py-1 text-right font-mono">
                            {m.price_krw != null ? `${m.price_krw.toLocaleString()}원` : '—'}
                          </td>
                          <td className="px-2 py-1 text-right font-mono text-gray-500">
                            {m.review_count != null ? m.review_count.toLocaleString() : '—'}
                          </td>
                          <td className="px-2 py-1 text-right font-mono text-gray-500">
                            {m.rank_in_src != null ? `#${m.rank_in_src}` : '—'}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )
          })}
        </div>
      )}

      <section className="text-xs text-gray-500 border-t border-gray-200 pt-4 space-y-1">
        <div className="font-semibold text-gray-700">📐 클러스터링 공식</div>
        <code className="block bg-gray-50 px-3 py-2 rounded font-mono text-[11px] leading-relaxed">
          cluster_id = connected_component(graph(cosine(emb_i, emb_j) ≥ 0.88))
          <br />
          source_count = |distinct sources in cluster|
          <br />
          has_ggsan = '도매원 존재' 게이트 — recommend 페이지 배지 트리거
        </code>
      </section>
    </div>
  )
}

function Kpi({ label, value, highlight = false }: { label: string; value: number | string; highlight?: boolean }) {
  return (
    <div className={`rounded border p-3 ${highlight ? 'border-amber-300 bg-amber-50' : 'border-gray-200'}`}>
      <div className="text-xs text-gray-500">{label}</div>
      <div className={`text-2xl font-bold mt-1 ${highlight ? 'text-amber-700' : ''}`}>
        {typeof value === 'number' ? value.toLocaleString() : value}
      </div>
    </div>
  )
}

function PinForm({ clusterId, title }: { clusterId: number; title: string }) {
  // 기존 jimscanner_trends_pins 재활용 — 클러스터 ID 를 keyword 로, source 를 'visual_twin' 로 저장
  return (
    <form action="/admin/trend-radar/visual-twins/pin" method="post" className="flex-shrink-0">
      <input type="hidden" name="cluster_id" value={clusterId} />
      <input type="hidden" name="title" value={title} />
      <button
        type="submit"
        className="text-xs px-2 py-1 rounded border border-gray-300 hover:bg-gray-100 text-gray-700"
        title="이 트윈을 핀에 추가"
      >
        📌 핀
      </button>
    </form>
  )
}
