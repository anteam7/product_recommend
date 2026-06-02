import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

type TrendState = 'heating' | 'stable' | 'cooling' | 'no_signal'

interface MomentumRow {
  listing_id: string
  registered_title: string
  status: string
  displayable: boolean
  list_price_krw: number | null
  msp_price_krw: number | null
  estimated_margin_pct: number | null
  product_id: number | null
  source_goods_no: string
  ggsan_title: string
  cate_label: string | null
  image_url: string | null
  detail_url: string | null
  sold_count: number | null

  recent_score: number
  prior_score: number
  delta_score: number
  momentum_pct: number
  recent_match_count: number
  top_keyword: string
  trend_state: TrendState
  spark: number[]
}

const WINDOW_OPTIONS = [
  { v: 7, label: '최근 7일 vs 직전 14일' },
  { v: 14, label: '최근 14일 vs 직전 28일' },
] as const

const STATE_META: Record<TrendState, { label: string; emoji: string; cls: string; action: string }> = {
  heating: {
    label: '가열',
    emoji: '🔥',
    cls: 'border-red-200 bg-red-50/40 hover:bg-red-50',
    action: '재고 보충 · 광고 증액 · MSP 상향 여력',
  },
  stable: {
    label: '안정',
    emoji: '→',
    cls: 'border-gray-200 hover:bg-gray-50',
    action: '현 상태 유지 · 모니터링',
  },
  cooling: {
    label: '냉각',
    emoji: '🧊',
    cls: 'border-blue-200 bg-blue-50/40 hover:bg-blue-50',
    action: '광고 감액 · 재고 소진 · 정리 후보',
  },
  no_signal: {
    label: '신호 없음',
    emoji: '·',
    cls: 'border-gray-200 hover:bg-gray-50',
    action: '트렌드 매칭 없음 (상품명/카탈로그 점검)',
  },
}

const STATE_BADGE: Record<TrendState, string> = {
  heating: 'bg-red-100 text-red-700',
  stable: 'bg-gray-100 text-gray-600',
  cooling: 'bg-blue-100 text-blue-700',
  no_signal: 'bg-zinc-100 text-zinc-500',
}

async function fetchMomentum(recentDays: number) {
  const sb = createAdminClient()
  // RPC는 supabase/coupang_momentum_rpc.sql 에 존재하나 generated 타입 미반영 — gen:types 시 캐스팅 제거
  const { data, error } = await sb.rpc('jimscanner_coupang_momentum' as never, {
    recent_days: recentDays,
    prior_days: recentDays * 2,
    min_sim: 0.2,
    spark_days: 14,
  } as never)
  if (error) return { rows: [] as MomentumRow[], error: error.message }
  return { rows: (data ?? []) as unknown as MomentumRow[], error: null as string | null }
}

function Sparkline({ data, state }: { data: number[]; state: TrendState }) {
  if (!data || data.length === 0) {
    return <div className="text-[10px] text-gray-300">—</div>
  }
  const w = 88
  const h = 24
  const max = Math.max(...data, 0.0001)
  const n = data.length
  const stroke = state === 'heating' ? '#dc2626' : state === 'cooling' ? '#2563eb' : '#9ca3af'
  const pts = data
    .map((v, i) => {
      const x = n === 1 ? w / 2 : (i / (n - 1)) * w
      const y = h - (v / max) * (h - 2) - 1
      return `${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')
  return (
    <svg width={w} height={h} className="block" aria-hidden>
      <polyline points={pts} fill="none" stroke={stroke} strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  )
}

function fmt(n: number | null | undefined) {
  if (n == null) return '—'
  return n.toLocaleString()
}

function buildHref(recentDays: number) {
  return `/admin/coupang-publish/momentum?win=${recentDays}`
}

export default async function MomentumPage({
  searchParams,
}: {
  searchParams: Promise<{ win?: string }>
}) {
  const sp = await searchParams
  const win = parseInt(sp.win ?? '7', 10)
  const recentDays = WINDOW_OPTIONS.some((o) => o.v === win) ? win : 7

  const { rows, error } = await fetchMomentum(recentDays)

  const heating = rows.filter((r) => r.trend_state === 'heating')
  const cooling = rows.filter((r) => r.trend_state === 'cooling')
  const stable = rows.filter((r) => r.trend_state === 'stable')
  const noSignal = rows.filter((r) => r.trend_state === 'no_signal')

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold">📈 판매중 SKU 트렌드 모멘텀</h1>
          <p className="text-sm text-gray-500 mt-1">
            판매중·승인 SKU 를 트렌드 레이더로 역추적 — 가열↑/안정→/냉각↓ 분류 후 재고·광고·정리 액션 라우팅
          </p>
        </div>
        <Link href="/admin/coupang-publish" className="text-sm text-gray-700 hover:text-black underline">
          ← 등록 상품 관리
        </Link>
      </header>

      {/* 윈도 + 안내 */}
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-xs text-gray-500">비교 윈도</span>
        {WINDOW_OPTIONS.map((o) => (
          <Link
            key={o.v}
            href={buildHref(o.v)}
            className={`px-3 py-1 text-xs rounded ${
              recentDays === o.v ? 'bg-amber-100 text-amber-700 font-semibold' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
            }`}
          >
            {o.label}
          </Link>
        ))}
      </div>

      {/* KPI */}
      <section className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Kpi label="🔥 가열 (밀 후보)" value={heating.length} highlight={heating.length > 0} tone="red" />
        <Kpi label="🧊 냉각 (정리 후보)" value={cooling.length} highlight={cooling.length > 0} tone="blue" />
        <Kpi label="→ 안정" value={stable.length} />
        <Kpi label="· 신호 없음" value={noSignal.length} />
      </section>

      {error && (
        <div className="rounded border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800">
          RPC 에러: <code className="font-mono text-xs">{error}</code>
          <p className="text-xs mt-2 text-red-700">
            RPC <code>jimscanner_coupang_momentum</code> 미적용 가능성. supabase/coupang_momentum_rpc.sql 적용 필요.
          </p>
        </div>
      )}

      {!error && rows.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500 space-y-2">
          <div className="text-base font-medium">판매중·승인 SKU 없음 또는 ggsan 매칭 0건</div>
          <div className="text-xs text-gray-400">
            등록 상품이 SELLING/APPROVED 상태이고 source_goods_no 가 ggsan 카탈로그에 존재해야 매칭됩니다.
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          {rows.map((r) => {
            const meta = STATE_META[r.trend_state]
            const coupangUrl = r.product_id ? `https://www.coupang.com/vp/products/${r.product_id}` : null
            return (
              <div key={r.listing_id} className={`block rounded border overflow-hidden transition-all ${meta.cls}`}>
                <div className="flex items-start gap-3 p-3">
                  {/* 이미지 */}
                  <div className="w-16 h-16 bg-gray-100 rounded overflow-hidden flex-shrink-0">
                    {r.image_url && (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={r.image_url} alt="" loading="lazy" className="w-full h-full object-cover" />
                    )}
                  </div>

                  {/* 본문 */}
                  <div className="flex-1 min-w-0 space-y-1">
                    <div className="flex items-center gap-2">
                      <span className={`inline-block px-2 py-0.5 rounded text-xs font-semibold ${STATE_BADGE[r.trend_state]}`}>
                        {meta.emoji} {meta.label}
                      </span>
                      <span className="text-sm font-medium leading-snug truncate" title={r.registered_title}>
                        {r.registered_title}
                      </span>
                    </div>
                    <div className="text-xs text-gray-500">
                      {r.cate_label ?? ''} · goods_no={r.source_goods_no}
                      {r.sold_count != null && r.sold_count > 0 && <span> · 판매 {r.sold_count}건</span>}
                    </div>
                    {/* 매칭 근거 */}
                    <div className="flex flex-wrap gap-2 text-xs pt-0.5">
                      {r.recent_match_count > 0 ? (
                        <span className="bg-amber-100 text-amber-800 px-2 py-0.5 rounded">
                          🔍 최근 매칭 {r.recent_match_count}건 · &quot;{r.top_keyword}&quot;
                        </span>
                      ) : (
                        <span className="text-gray-400">최근 윈도 트렌드 매칭 없음</span>
                      )}
                    </div>
                    {/* 액션 라우팅 */}
                    <div className="text-xs text-gray-700 pt-0.5">
                      <span className="font-semibold">액션:</span> {meta.action}
                    </div>
                  </div>

                  {/* 스파크라인 + 모멘텀 */}
                  <div className="text-right flex-shrink-0 space-y-1">
                    <Sparkline data={r.spark} state={r.trend_state} />
                    <div
                      className={`text-sm font-bold font-mono ${
                        r.delta_score > 0 ? 'text-red-600' : r.delta_score < 0 ? 'text-blue-600' : 'text-gray-500'
                      }`}
                    >
                      {r.delta_score > 0 ? '▲' : r.delta_score < 0 ? '▼' : '–'}{' '}
                      {r.momentum_pct >= 999
                        ? 'NEW'
                        : `${r.momentum_pct > 0 ? '+' : ''}${r.momentum_pct.toFixed(0)}%`}
                    </div>
                    <div className="text-[10px] text-gray-400 font-mono">
                      {Number(r.recent_score).toFixed(2)} ← {Number(r.prior_score).toFixed(2)}
                    </div>
                  </div>

                  {/* 마진 + 링크 */}
                  <div className="text-right flex-shrink-0 space-y-1 w-24">
                    <div className="text-xs text-gray-500">판매가</div>
                    <div className="text-sm font-semibold tabular-nums">{fmt(r.list_price_krw)}원</div>
                    <div className="text-xs tabular-nums">
                      {r.estimated_margin_pct != null ? (
                        <span className={r.estimated_margin_pct >= 40 ? 'text-emerald-700 font-semibold' : 'text-gray-700'}>
                          마진 {r.estimated_margin_pct.toFixed(1)}%
                        </span>
                      ) : (
                        '—'
                      )}
                    </div>
                    {coupangUrl && (
                      <a href={coupangUrl} target="_blank" rel="noreferrer noopener" className="text-blue-700 hover:underline text-xs block">
                        쿠팡 →
                      </a>
                    )}
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* 공식 설명 */}
      <section className="text-xs text-gray-500 border-t border-gray-200 pt-4 space-y-1">
        <div className="font-semibold text-gray-700">📐 모멘텀 분류 방식</div>
        <code className="block bg-gray-50 px-3 py-2 rounded font-mono text-[11px] leading-relaxed">
          recent_score = Σ similarity(키워드, ggsan_title) / recent_days &nbsp;(최근 윈도 일평균)
          <br />
          prior_score = 직전 윈도 일평균 · momentum_pct = (recent − prior) / prior × 100
          <br />
          가열 ≥ +20% · 냉각 ≤ −20% · 그 외 안정 · 매칭 0건 = 신호 없음
        </code>
        <div className="pt-1">
          판매중·승인 SKU 의 source_goods_no(=ggsan goods_no)를 트렌드 키워드(TV·검색·쇼핑)와 trigram 매칭해
          시계열 변화로 운영 액션을 라우팅. 발굴(forward)의 역방향 — forward-operations 루프.
        </div>
      </section>
    </div>
  )
}

function Kpi({
  label,
  value,
  highlight = false,
  tone = 'amber',
}: {
  label: string
  value: number | string
  highlight?: boolean
  tone?: 'amber' | 'red' | 'blue'
}) {
  const hi =
    tone === 'red'
      ? 'border-red-300 bg-red-50 text-red-700'
      : tone === 'blue'
        ? 'border-blue-300 bg-blue-50 text-blue-700'
        : 'border-amber-300 bg-amber-50 text-amber-700'
  return (
    <div className={`rounded border p-3 ${highlight ? hi : 'border-gray-200'}`}>
      <div className="text-xs text-gray-500">{label}</div>
      <div className="text-2xl font-bold mt-1">{typeof value === 'number' ? value.toLocaleString() : value}</div>
    </div>
  )
}
