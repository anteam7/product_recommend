import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

interface AffinityRow {
  token_a: string
  token_b: string
  cooccur_count: number
  count_a: number
  count_b: number
  total_docs: number
  pmi: number
  lift: number

  goods_no_a: string
  title_a: string
  price_a: number | null
  sim_a: number

  goods_no_b: string
  title_b: string
  price_b: number | null
  sim_b: number

  bundle_dome_krw: number
  msp_sum_krw: number
  affinity_score: number
}

const DAYS_OPTIONS = [
  { v: 7, label: '7일' },
  { v: 14, label: '14일' },
  { v: 30, label: '30일 (기본)' },
  { v: 60, label: '60일' },
] as const

const SIM_OPTIONS = [
  { v: 0.15, label: '0.15 (느슨)' },
  { v: 0.2, label: '0.20 (기본)' },
  { v: 0.3, label: '0.30 (엄격)' },
] as const

const COOCCUR_OPTIONS = [
  { v: 2, label: '2회+' },
  { v: 3, label: '3회+' },
  { v: 5, label: '5회+' },
] as const

// 쿠팡 13% 수수료 + 부가세(가격/11) 근사 — 단순 묶음 마진 추정 (배송 3,000원 1회)
const FEE_RATE = 0.106
const BUNDLE_SHIPPING = 3000

async function fetchAffinity(opts: { days: number; minSim: number; minCooccur: number }) {
  const sb = createAdminClient()
  // RPC는 DB(supabase/trends_affinity_rpc.sql)에 존재하나 generated 타입 미반영 — `npm run gen:types` 시 캐스팅 제거
  const { data, error } = await sb.rpc('jimscanner_trends_affinity' as never, {
    days_window: opts.days,
    min_sim: opts.minSim,
    min_cooccur: opts.minCooccur,
    result_limit: 150,
  } as never)
  if (error) {
    return { rows: [] as AffinityRow[], error: error.message }
  }
  return { rows: (data ?? []) as AffinityRow[], error: null as string | null }
}

function buildHref(current: Record<string, string>, override: Record<string, string | null>): string {
  const params = new URLSearchParams()
  for (const [k, v] of Object.entries(current)) if (v) params.set(k, v)
  for (const [k, v] of Object.entries(override)) {
    if (v == null || v === '') params.delete(k)
    else params.set(k, v)
  }
  const qs = params.toString()
  return '/admin/trend-radar/affinity' + (qs ? `?${qs}` : '')
}

// 예상 묶음 판매가/마진 (도매가 합 기준 단순 마크업; tiered MSP 합을 하한으로)
function estimate(row: AffinityRow) {
  const realCost = row.bundle_dome_krw + BUNDLE_SHIPPING
  // 가격은 MSP 합 하한 + 30% 마진 목표 중 큰 값으로 가정
  const targetByMargin = Math.round(realCost / (1 - FEE_RATE - 1 / 11 - 0.18))
  const listPrice = Math.max(row.msp_sum_krw || 0, targetByMargin)
  const fee = Math.round(listPrice * FEE_RATE)
  const vat = Math.round(listPrice / 11)
  const margin = listPrice - realCost - fee - vat
  const marginPct = listPrice > 0 ? Math.round((margin / listPrice) * 100) : 0
  return { listPrice, realCost, margin, marginPct }
}

export default async function AffinityPage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string; sim?: string; cooccur?: string }>
}) {
  const sp = await searchParams
  const days = parseInt(sp.days ?? '30', 10)
  const validDays = DAYS_OPTIONS.some((d) => d.v === days) ? days : 30
  const sim = parseFloat(sp.sim ?? '0.2')
  const validSim = SIM_OPTIONS.some((s) => Math.abs(s.v - sim) < 0.001) ? sim : 0.2
  const cooccur = parseInt(sp.cooccur ?? '2', 10)
  const validCooccur = COOCCUR_OPTIONS.some((c) => c.v === cooccur) ? cooccur : 2

  const current: Record<string, string> = {
    days: String(validDays),
    sim: String(validSim),
    cooccur: String(validCooccur),
  }

  const { rows, error } = await fetchAffinity({ days: validDays, minSim: validSim, minCooccur: validCooccur })

  // KPI
  const total = rows.length
  const strongLift = rows.filter((r) => Number(r.lift) >= 2).length
  const distinctGoods = new Set<string>()
  rows.forEach((r) => {
    distinctGoods.add(r.goods_no_a)
    distinctGoods.add(r.goods_no_b)
  })
  const maxLift = rows.length > 0 ? Math.max(...rows.map((r) => Number(r.lift))) : 0

  // 네트워크 그래프용: 상위 25 페어의 노드/엣지 (간단 force-free 원형 배치)
  const top = rows.slice(0, 25)
  const nodeMap = new Map<string, { id: string; title: string }>()
  top.forEach((r) => {
    if (!nodeMap.has(r.goods_no_a)) nodeMap.set(r.goods_no_a, { id: r.goods_no_a, title: r.title_a })
    if (!nodeMap.has(r.goods_no_b)) nodeMap.set(r.goods_no_b, { id: r.goods_no_b, title: r.title_b })
  })
  const nodes = Array.from(nodeMap.values())
  const W = 720
  const H = 420
  const cx = W / 2
  const cy = H / 2
  const radius = Math.min(W, H) / 2 - 60
  const pos = new Map<string, { x: number; y: number }>()
  nodes.forEach((n, i) => {
    const ang = (2 * Math.PI * i) / Math.max(nodes.length, 1)
    pos.set(n.id, { x: cx + radius * Math.cos(ang), y: cy + radius * Math.sin(ang) })
  })
  const maxLiftTop = top.length > 0 ? Math.max(...top.map((r) => Number(r.lift))) : 1

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold">🔗 동반언급 친화도 · 묶음 SKU 발굴</h1>
          <p className="text-sm text-gray-500 mt-1">
            동일 출처(방송·스레드·기사) 내 동시 등장 트렌드 토큰의 양의 동반언급(lift/PMI) — 양쪽 모두 ggsan 매칭되는 묶음후보
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      <div className="rounded border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-900">
        <strong>측정 원리</strong> · naver_tvtime 동일 방송 · 커뮤니티 동일 스레드 · naver_news metadata.tags 를
        천연 co-occurrence 라벨로 사용. <code>lift = cooccur×N / (df_a×df_b)</code> 가 1보다 크면 우연 이상으로
        함께 수요되는 보완재 시그널. 양쪽 모두 ggsan 도매 매칭(pg_trgm)되는 페어만 등록가능 묶음후보로 승격.
      </div>

      {/* 필터 */}
      <div className="rounded border border-gray-200 px-4 py-3">
        <div className="flex flex-wrap items-center gap-4">
          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-500">기간</span>
            {DAYS_OPTIONS.map((d) => (
              <Link
                key={d.v}
                href={buildHref(current, { days: String(d.v) })}
                className={`px-2 py-1 text-xs rounded ${validDays === d.v ? 'bg-amber-100 text-amber-700 font-semibold' : 'text-gray-500 hover:text-black'}`}
              >
                {d.label}
              </Link>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-500">유사도 ≥</span>
            {SIM_OPTIONS.map((s) => (
              <Link
                key={s.v}
                href={buildHref(current, { sim: String(s.v) })}
                className={`px-2 py-1 text-xs rounded ${Math.abs(validSim - s.v) < 0.001 ? 'bg-amber-100 text-amber-700 font-semibold' : 'text-gray-500 hover:text-black'}`}
              >
                {s.label}
              </Link>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-500">동반 ≥</span>
            {COOCCUR_OPTIONS.map((c) => (
              <Link
                key={c.v}
                href={buildHref(current, { cooccur: String(c.v) })}
                className={`px-2 py-1 text-xs rounded ${validCooccur === c.v ? 'bg-amber-100 text-amber-700 font-semibold' : 'text-gray-500 hover:text-black'}`}
              >
                {c.label}
              </Link>
            ))}
          </div>
        </div>
      </div>

      {/* KPI */}
      <section className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Kpi label="묶음후보 페어" value={total} />
        <Kpi label="강한 보완재 (lift≥2)" value={strongLift} highlight={strongLift > 0} />
        <Kpi label="관여 상품 수" value={distinctGoods.size} />
        <Kpi label="최대 lift" value={maxLift.toFixed(1)} />
      </section>

      {/* 에러 */}
      {error && (
        <div className="rounded border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800">
          RPC 에러: <code className="font-mono text-xs">{error}</code>
          <p className="text-xs mt-2 text-red-700">
            RPC <code>jimscanner_trends_affinity</code> 가 DB에 적용 안 됐을 가능성. supabase/trends_affinity_rpc.sql 적용 필요.
          </p>
        </div>
      )}

      {/* 친화도 네트워크 */}
      {!error && top.length > 0 && (
        <section className="rounded border border-gray-200 p-4">
          <div className="text-xs font-semibold text-gray-700 mb-2">친화도 네트워크 (상위 25페어 · 노드=상품, 선 굵기=lift)</div>
          <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto" role="img" aria-label="친화도 네트워크">
            {top.map((r, i) => {
              const a = pos.get(r.goods_no_a)
              const b = pos.get(r.goods_no_b)
              if (!a || !b) return null
              const w = 0.6 + (Number(r.lift) / maxLiftTop) * 4
              return (
                <line
                  key={`e${i}`}
                  x1={a.x}
                  y1={a.y}
                  x2={b.x}
                  y2={b.y}
                  stroke="#f59e0b"
                  strokeOpacity={0.45}
                  strokeWidth={w}
                />
              )
            })}
            {nodes.map((n) => {
              const p = pos.get(n.id)!
              return (
                <g key={n.id}>
                  <circle cx={p.x} cy={p.y} r={6} fill="#111827" />
                  <text x={p.x} y={p.y - 9} textAnchor="middle" fontSize="9" fill="#374151">
                    {n.title.length > 12 ? n.title.slice(0, 12) + '…' : n.title}
                  </text>
                </g>
              )
            })}
          </svg>
        </section>
      )}

      {/* 묶음후보 테이블 */}
      {!error && rows.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500 space-y-2">
          <div className="text-base font-medium">동반언급 묶음후보 없음</div>
          <div className="text-xs text-gray-400">
            데이터 부족 가능성: 1) 동일 출처 내 동시 등장이 적음 · 2) 양쪽 ggsan 매칭 실패
            <br />
            동반 ≥2, 유사도 0.15, 기간 60일로 완화해보기. 누적될수록 풍부해짐.
          </div>
        </div>
      ) : (
        !error && (
          <div className="space-y-2">
            {rows.map((r, i) => {
              const est = estimate(r)
              const bundleArg = `node scripts/coupang-register-bundle.mjs --base=${r.goods_no_a} --pack=2 --price=${est.listPrice} --title="..." (페어 상대: ${r.goods_no_b})`
              return (
                <div key={`${r.goods_no_a}-${r.goods_no_b}`} className="rounded border border-gray-200 hover:bg-gray-50 transition-colors">
                  <div className="flex items-start gap-3 p-3">
                    <div className="w-8 text-center text-sm font-mono text-gray-400 pt-1">{i + 1}</div>
                    <div className="flex-1 min-w-0 space-y-1">
                      <div className="flex items-center gap-2 text-sm font-medium leading-snug flex-wrap">
                        <span className="text-blue-700" title={r.title_a}>
                          {r.title_a}
                        </span>
                        <span className="text-gray-400">＋</span>
                        <span className="text-emerald-700" title={r.title_b}>
                          {r.title_b}
                        </span>
                      </div>
                      <div className="text-xs text-gray-500">
                        <span className="font-mono">{r.goods_no_a}</span> ＋ <span className="font-mono">{r.goods_no_b}</span>
                        {' · '}매칭 sim {Number(r.sim_a).toFixed(2)} / {Number(r.sim_b).toFixed(2)}
                      </div>
                      <div className="flex flex-wrap gap-2 text-xs pt-1">
                        <span className="bg-amber-100 text-amber-800 px-2 py-0.5 rounded">
                          🔗 동반 {r.cooccur_count}회 · lift {Number(r.lift).toFixed(1)} · PMI {Number(r.pmi).toFixed(2)}
                        </span>
                        <span className="text-gray-500">
                          토큰 &quot;{r.token_a}&quot; ({r.count_a}) × &quot;{r.token_b}&quot; ({r.count_b}) / {r.total_docs}문서
                        </span>
                      </div>
                      {/* 등록 인자 복사용 */}
                      <details className="pt-1">
                        <summary className="text-[11px] text-gray-400 cursor-pointer hover:text-gray-700">
                          register-bundle 인자 보기
                        </summary>
                        <code className="block mt-1 bg-gray-50 px-2 py-1 rounded font-mono text-[10px] text-gray-700 break-all select-all">
                          {bundleArg}
                        </code>
                      </details>
                    </div>
                    <div className="text-right flex-shrink-0 space-y-1">
                      <div className="text-2xl font-bold font-mono text-amber-700">{Number(r.affinity_score).toFixed(1)}</div>
                      <div className="text-[10px] text-gray-500 font-mono">affinity</div>
                      <div className="text-xs text-gray-700 pt-1">
                        도매합 {r.bundle_dome_krw.toLocaleString()}원
                      </div>
                      <div className="text-xs text-gray-500">
                        MSP합 {r.msp_sum_krw.toLocaleString()}원
                      </div>
                      <div className={`text-sm font-semibold ${est.margin > 0 ? 'text-emerald-700' : 'text-red-600'}`}>
                        ~{est.listPrice.toLocaleString()}원 / 마진 {est.marginPct}%
                      </div>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        )
      )}

      {/* 공식 설명 */}
      <section className="text-xs text-gray-500 border-t border-gray-200 pt-4 space-y-1">
        <div className="font-semibold text-gray-700">📐 AffinityScore 공식</div>
        <code className="block bg-gray-50 px-3 py-2 rounded font-mono text-[11px] leading-relaxed">
          lift = cooccur × N / (df_a × df_b)
          <br />
          pmi = ln(lift)
          <br />
          affinity_score = lift × ln(1 + cooccur) × √(sim_a × sim_b)
          <br />
          예상 묶음가 ≈ max(MSP합, (도매합+3000) / (1 − 0.106 − 1/11 − 0.18))
        </code>
        <div className="pt-2">
          <strong>활용:</strong> 각 행의 register-bundle 인자로 페어 묶음(--pack=2) 등록 가능. tiered_msp 합을 하한으로
          준수하며, 실제 가격은 coupang-register-bundle.mjs 내부 MSP 검증을 통과해야 함.
        </div>
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
