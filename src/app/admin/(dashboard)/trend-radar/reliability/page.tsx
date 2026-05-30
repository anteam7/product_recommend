import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

const CATEGORIES = ['all', 'health', 'living', 'digital'] as const
type Category = (typeof CATEGORIES)[number]
const CATEGORY_LABEL: Record<Category, string> = {
  all: '전체',
  health: '건강식품',
  living: '생활/리빙',
  digital: '디지털/가전',
}

interface ShrinkRow {
  product_id: string
  category_top: string
  n: number
  raw_score: number
  mean_score: number
  prior_mean: number
  shrunk_score: number
  shrink_factor: number
  ci_width: number
}

async function fetchShrink(category: Category) {
  const sb = createAdminClient()
  const { data } = await sb.rpc('jimscanner_trends_score_shrinkage' as any, {
    p_category: category,
    p_k: 3,
  })
  const rows = ((data ?? []) as ShrinkRow[]).filter((r) => r.raw_score != null)

  // 상품명 join (보조 — 라벨용)
  const ids = rows.map((r) => r.product_id)
  const nameMap = new Map<string, string>()
  if (ids.length) {
    const { data: prods } = await sb
      .from('jimscanner_trends_products')
      .select('id, canonical_name')
      .in('id', ids)
    for (const p of (prods ?? []) as { id: string; canonical_name: string }[]) {
      nameMap.set(p.id, p.canonical_name)
    }
  }
  return rows.map((r) => ({ ...r, name: nameMap.get(r.product_id) ?? r.product_id.slice(0, 8) }))
}

export default async function ReliabilityPage({
  searchParams,
}: {
  searchParams: Promise<{ cat?: string }>
}) {
  const sp = await searchParams
  const category = (CATEGORIES.includes(sp.cat as Category) ? sp.cat : 'all') as Category
  const rows = await fetchShrink(category)

  // 산점도 영역
  const W = 720
  const H = 460
  const PAD = 48
  const maxN = Math.max(5, ...rows.map((r) => r.n))
  const maxRaw = 100
  // n 축은 √ 스케일(1~2회가 다수라 좌측 밀집 완화)
  const nx = (n: number) => PAD + (Math.sqrt(n) / Math.sqrt(maxN)) * (W - PAD * 2)
  const ry = (raw: number) => H - PAD - (raw / maxRaw) * (H - PAD * 2)

  const N_THRESHOLD = 3 // 얇은 증거 경계
  const RAW_THRESHOLD = 50 // 고득점 경계
  const xThresh = nx(N_THRESHOLD)
  const yThresh = ry(RAW_THRESHOLD)

  const suspect = rows.filter((r) => r.n < N_THRESHOLD && r.raw_score >= RAW_THRESHOLD)
  const trueSignal = rows.filter((r) => r.n >= N_THRESHOLD && r.raw_score >= RAW_THRESHOLD)

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold">신뢰 산점도 — 표본수 vs raw 점수</h1>
          <p className="text-sm text-gray-500 mt-1">
            우상단 = 진짜 신호(관측 깊이 + 높은 점수) · 좌상단 = 요주의 스파이크(얇은 증거, 회귀 보정 대상)
          </p>
        </div>
        <Link href={`/admin/trend-radar?cat=${category}`} className="text-sm text-gray-700 hover:text-black underline">
          ← 레이더로
        </Link>
      </header>

      <nav className="flex gap-2 border-b border-gray-200">
        {CATEGORIES.map((c) => (
          <Link
            key={c}
            href={`/admin/trend-radar/reliability?cat=${c}`}
            className={`px-3 py-2 text-sm ${
              category === c ? 'border-b-2 border-black font-semibold text-black' : 'text-gray-500 hover:text-black'
            }`}
          >
            {CATEGORY_LABEL[c]}
          </Link>
        ))}
      </nav>

      <section className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Kpi label="관측 product" value={rows.length} hint="점 개수" />
        <Kpi label="진짜 신호 (우상단)" value={trueSignal.length} hint={`n≥${N_THRESHOLD} · raw≥${RAW_THRESHOLD}`} />
        <Kpi label="요주의 스파이크 (좌상단)" value={suspect.length} hint={`n<${N_THRESHOLD} · raw≥${RAW_THRESHOLD}`} />
        <Kpi
          label="평균 관측수"
          value={rows.length ? Math.round((rows.reduce((a, r) => a + r.n, 0) / rows.length) * 10) / 10 : 0}
          hint="표본 깊이"
        />
      </section>

      {rows.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500">
          아직 score 데이터가 없습니다. 30일 누적 후 신뢰 분리가 가능합니다.
        </div>
      ) : (
        <section className="rounded border border-gray-200 p-4 overflow-x-auto">
          <svg width={W} height={H} className="mx-auto" role="img" aria-label="표본수 대 raw 점수 산점도">
            {/* 사분면 음영 */}
            <rect x={PAD} y={PAD} width={xThresh - PAD} height={yThresh - PAD} fill="#fef3c7" opacity={0.5} />
            <rect x={xThresh} y={PAD} width={W - PAD - xThresh} height={yThresh - PAD} fill="#d1fae5" opacity={0.5} />

            {/* 임계선 */}
            <line x1={xThresh} y1={PAD} x2={xThresh} y2={H - PAD} stroke="#d97706" strokeDasharray="4 3" strokeWidth={1} />
            <line x1={PAD} y1={yThresh} x2={W - PAD} y2={yThresh} stroke="#9ca3af" strokeDasharray="4 3" strokeWidth={1} />

            {/* 축 */}
            <line x1={PAD} y1={H - PAD} x2={W - PAD} y2={H - PAD} stroke="#374151" strokeWidth={1} />
            <line x1={PAD} y1={PAD} x2={PAD} y2={H - PAD} stroke="#374151" strokeWidth={1} />

            {/* 축 라벨 */}
            <text x={W / 2} y={H - 12} textAnchor="middle" className="fill-gray-600" fontSize={12}>
              관측 횟수 n (√ 스케일) →
            </text>
            <text x={16} y={H / 2} textAnchor="middle" fontSize={12} transform={`rotate(-90 16 ${H / 2})`} className="fill-gray-600">
              raw final_score →
            </text>
            <text x={PAD + 6} y={PAD + 14} fontSize={11} className="fill-amber-700 font-semibold">
              ⚠ 요주의 스파이크
            </text>
            <text x={W - PAD - 6} y={PAD + 14} textAnchor="end" fontSize={11} className="fill-emerald-700 font-semibold">
              ✓ 진짜 신호
            </text>

            {/* y 눈금 */}
            {[0, 25, 50, 75, 100].map((v) => (
              <g key={v}>
                <text x={PAD - 6} y={ry(v) + 4} textAnchor="end" fontSize={10} className="fill-gray-400">
                  {v}
                </text>
              </g>
            ))}

            {/* 점: raw(채움) → shrunk(테두리) 선분으로 수축 방향 표시 */}
            {rows.map((r) => {
              const x = nx(r.n)
              const yRaw = ry(r.raw_score)
              const yShrunk = ry(r.shrunk_score)
              const thin = r.n < N_THRESHOLD
              const high = r.raw_score >= RAW_THRESHOLD
              const color = thin && high ? '#d97706' : high ? '#059669' : '#9ca3af'
              return (
                <g key={r.product_id}>
                  <line x1={x} y1={yRaw} x2={x} y2={yShrunk} stroke={color} strokeWidth={1} opacity={0.4} />
                  <circle cx={x} cy={yShrunk} r={2.5} fill="none" stroke={color} strokeWidth={1} opacity={0.6} />
                  <circle cx={x} cy={yRaw} r={4} fill={color} opacity={0.8}>
                    <title>
                      {r.name} · n={r.n} · raw={r.raw_score} → shrunk={r.shrunk_score} · 수축{Math.round(r.shrink_factor * 100)}% · CI±{Math.round(r.ci_width / 2)}
                    </title>
                  </circle>
                </g>
              )
            })}
          </svg>
          <p className="text-xs text-gray-400 text-center mt-2">
            채운 점 = raw, 빈 점 = 신뢰보정(shrunk). 선분 길이 = 수축 거리(표본 얇을수록 김).
          </p>
        </section>
      )}

      {/* 요주의 스파이크 목록 */}
      {suspect.length > 0 && (
        <section className="rounded border border-amber-300 bg-amber-50/40 p-4">
          <h2 className="text-sm font-semibold text-amber-900 mb-3">
            ⚠ 요주의 스파이크 {suspect.length}개 — raw 높지만 표본이 얇음(회귀 보정으로 강등)
          </h2>
          <div className="space-y-1">
            <div className="grid grid-cols-12 text-xs text-amber-800/70 px-2 py-1">
              <div className="col-span-5">상품명</div>
              <div className="col-span-1 text-right">n</div>
              <div className="col-span-2 text-right">raw</div>
              <div className="col-span-2 text-right">보정</div>
              <div className="col-span-2 text-right">수축%</div>
            </div>
            {suspect
              .sort((a, b) => b.raw_score - a.raw_score)
              .slice(0, 30)
              .map((r) => (
                <Link
                  key={r.product_id}
                  href={`/admin/trend-radar/products/${r.product_id}`}
                  className="grid grid-cols-12 px-2 py-1 text-sm rounded hover:bg-white"
                >
                  <div className="col-span-5 truncate">{r.name}</div>
                  <div className="col-span-1 text-right font-mono text-amber-700">{r.n}</div>
                  <div className="col-span-2 text-right font-mono font-bold">{r.raw_score}</div>
                  <div className="col-span-2 text-right font-mono text-gray-700">{r.shrunk_score}</div>
                  <div className="col-span-2 text-right font-mono text-amber-700">
                    {Math.round(r.shrink_factor * 100)}%
                  </div>
                </Link>
              ))}
          </div>
        </section>
      )}
    </div>
  )
}

function Kpi({ label, value, hint }: { label: string; value: number; hint: string }) {
  return (
    <div className="rounded border border-gray-200 p-4">
      <div className="text-xs text-gray-500">{label}</div>
      <div className="text-3xl font-bold mt-1">{value.toLocaleString()}</div>
      <div className="text-xs text-gray-400 mt-1">{hint}</div>
    </div>
  )
}
