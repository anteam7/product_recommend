import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

// ─────────────────────────────────────────────────────────────
// 실판매 성과 귀속 보드
//  ① 등록시점 발굴점수(ggsan_recommend RPC) ↔ ② 실현 P&L(jimscanner_attribution_skus 뷰)
//  를 goods_no 로 시점 매칭해, "점수가 실제 내 매출을 예측했는가?" 를 학습.
// ─────────────────────────────────────────────────────────────

interface AttribRow {
  listing_id: string
  seller_product_id: number | null
  goods_no: string | null
  registered_title: string | null
  registered_at: string | null
  status: string
  estimated_margin_pct: number | null
  estimated_margin_krw: number | null
  order_count: number
  total_qty: number
  revenue: number
  cost: number
  fee: number
  vat: number
  net_profit: number
  cost_missing: number
  first_order_at: string | null
  last_order_at: string | null
  days_register_to_last_sale: number | null
}

// ggsan_recommend RPC 한 row (recommend 페이지와 동일 형태, 필요 필드만)
interface ScoreRow {
  goods_no: string
  tv_score: number
  search_score: number
  final_score: number
  is_imminent: boolean
}

// 분석 대상 = 발굴점수와 실현성과를 짝지은 SKU
interface Joined extends AttribRow {
  tv_score: number | null
  search_score: number | null
  final_score: number | null
  is_imminent: boolean
}

const DAYS_OPTIONS = [
  { v: 60, label: '60일' },
  { v: 90, label: '90일 (기본)' },
  { v: 180, label: '180일' },
  { v: 0, label: '전체' },
] as const

function periodCutoff(days: number): number | null {
  return days > 0 ? Date.now() - days * 86400000 : null
}

async function fetchAttribution(scoreWindow: number) {
  const sb = createAdminClient() as unknown as {
    from: (t: string) => ReturnType<ReturnType<typeof createAdminClient>['from']>
    rpc: ReturnType<typeof createAdminClient>['rpc']
  }

  // 1) 실현 P&L 뷰 (마이그레이션: supabase/attribution_board.sql)
  const { data: attribData, error: attribError } = await sb
    .from('jimscanner_attribution_skus')
    .select('*')
  const attribRows = (attribData ?? []) as unknown as AttribRow[]

  // 2) 발굴점수: ggsan_recommend RPC — goods_no 별 현 시점 점수(= 등록시점 발굴 신호의 프록시)
  //    RPC 는 generated 타입 미반영 → recommend 페이지와 동일하게 캐스팅.
  const { data: scoreData } = await sb.rpc('jimscanner_ggsan_recommend' as never, {
    days_window: scoreWindow > 0 ? scoreWindow : 365,
    min_sim: 0.15,
    min_score: 0,
    result_limit: 2000,
  } as never)
  const scoreRows = (scoreData ?? []) as unknown as ScoreRow[]
  const scoreMap = new Map<string, ScoreRow>()
  for (const s of scoreRows) scoreMap.set(s.goods_no, s)

  const joined: Joined[] = attribRows.map((r) => {
    const s = r.goods_no ? scoreMap.get(r.goods_no) : undefined
    return {
      ...r,
      tv_score: s ? Number(s.tv_score) : null,
      search_score: s ? Number(s.search_score) : null,
      final_score: s ? Number(s.final_score) : null,
      is_imminent: s ? !!s.is_imminent : false,
    }
  })
  return { joined, attribError: attribError?.message ?? null, scoredCount: scoreMap.size }
}

// ── 통계 헬퍼 ────────────────────────────────────────────────
/** 스피어만 순위상관: 두 배열을 순위로 변환 후 피어슨. 동순위는 평균순위. */
function spearman(pairs: Array<[number, number]>): number | null {
  const n = pairs.length
  if (n < 3) return null
  const rank = (vals: number[]): number[] => {
    const idx = vals.map((v, i) => [v, i] as [number, number]).sort((a, b) => a[0] - b[0])
    const r = new Array<number>(vals.length)
    let i = 0
    while (i < idx.length) {
      let j = i
      while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++
      const avg = (i + j) / 2 + 1 // 1-based 평균순위
      for (let k = i; k <= j; k++) r[idx[k][1]] = avg
      i = j + 1
    }
    return r
  }
  const rx = rank(pairs.map((p) => p[0]))
  const ry = rank(pairs.map((p) => p[1]))
  const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length
  const mx = mean(rx), my = mean(ry)
  let num = 0, dx = 0, dy = 0
  for (let i = 0; i < n; i++) {
    num += (rx[i] - mx) * (ry[i] - my)
    dx += (rx[i] - mx) ** 2
    dy += (ry[i] - my) ** 2
  }
  if (dx === 0 || dy === 0) return null
  return num / Math.sqrt(dx * dy)
}

function fmt(n: number | null | undefined) {
  return n == null ? '—' : Math.round(n).toLocaleString()
}
function corrLabel(r: number | null): { txt: string; cls: string } {
  if (r == null) return { txt: '데이터 부족', cls: 'text-gray-400' }
  const a = Math.abs(r)
  if (a >= 0.4) return { txt: r > 0 ? '강한 양(+) 신호' : '강한 역(−) 신호', cls: r > 0 ? 'text-emerald-700' : 'text-rose-600' }
  if (a >= 0.2) return { txt: r > 0 ? '약한 양(+)' : '약한 역(−)', cls: r > 0 ? 'text-emerald-600' : 'text-rose-500' }
  return { txt: '무상관 (헛신호 의심)', cls: 'text-gray-500' }
}

export default async function AttributionPage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string }>
}) {
  const sp = await searchParams
  const daysRaw = parseInt(sp.days ?? '90', 10)
  const days = DAYS_OPTIONS.some((d) => d.v === daysRaw) ? daysRaw : 90
  const current: Record<string, string> = { days: String(days) }

  const { joined, attribError, scoredCount } = await fetchAttribution(days)

  // 기간 필터: registered_at 기준 (전체=0 이면 무필터)
  const cutoff = periodCutoff(days)
  const inWindow = joined.filter((r) => {
    if (cutoff == null) return true
    if (!r.registered_at) return false
    return new Date(r.registered_at).getTime() >= cutoff
  })

  // 분석 모집단: 발굴점수가 있는 SKU (점수 ↔ 성과 짝)
  const scored = inWindow.filter((r) => r.final_score != null)
  const sold = inWindow.filter((r) => r.total_qty > 0)
  const totalNet = inWindow.reduce((s, r) => s + r.net_profit, 0)
  const costMissingTotal = inWindow.reduce((s, r) => s + r.cost_missing, 0)

  // ① 캘리브레이션: final_score 4분위 버킷 → 평균 실현 판매수량·실수익
  const buckets = (() => {
    const withScore = scored.slice().sort((a, b) => (a.final_score ?? 0) - (b.final_score ?? 0))
    if (withScore.length < 4) return [] as Array<{ label: string; n: number; avgQty: number; avgNet: number; soldRate: number }>
    const q = Math.ceil(withScore.length / 4)
    const labels = ['하위 25% (저점수)', '하위 25~50%', '상위 25~50%', '상위 25% (고점수)']
    const out: Array<{ label: string; n: number; avgQty: number; avgNet: number; soldRate: number }> = []
    for (let b = 0; b < 4; b++) {
      const slice = withScore.slice(b * q, b === 3 ? withScore.length : (b + 1) * q)
      if (slice.length === 0) continue
      out.push({
        label: labels[b],
        n: slice.length,
        avgQty: slice.reduce((s, r) => s + r.total_qty, 0) / slice.length,
        avgNet: slice.reduce((s, r) => s + r.net_profit, 0) / slice.length,
        soldRate: slice.filter((r) => r.total_qty > 0).length / slice.length,
      })
    }
    return out
  })()
  const maxAvgNet = Math.max(1, ...buckets.map((b) => Math.abs(b.avgNet)))

  // ② 점수 컴포넌트별 실판매(net_profit)와의 스피어만 상관
  const components: Array<{ key: keyof Joined; label: string; note: string; population: Joined[] }> = [
    { key: 'final_score', label: 'final_score (종합 발굴점수)', note: 'tv×1.5 + search', population: scored },
    { key: 'tv_score', label: 'tv_score (TV 편성 신호)', note: '홈쇼핑 푸시', population: scored },
    { key: 'search_score', label: 'search_score (검색·쇼핑 신호)', note: '수요 강도', population: scored },
    { key: 'estimated_margin_pct', label: 'estimated_margin_pct (등록시 예상마진)', note: '내부 가격 신호', population: inWindow.filter((r) => r.estimated_margin_pct != null) },
  ]
  const correlations = components.map((c) => {
    const pairs = c.population
      .map((r) => [Number(r[c.key]), r.net_profit] as [number, number])
      .filter((p) => Number.isFinite(p[0]))
    return { ...c, n: pairs.length, r: spearman(pairs) }
  }).sort((a, b) => (b.r ?? -2) - (a.r ?? -2))

  // ③ 발굴 오탐(dud): 고점수(상위 25%)인데 안 팔림 / 놓친 보석(gem): 저점수인데 잘 팔림
  const scoredByFinal = scored.slice().sort((a, b) => (b.final_score ?? 0) - (a.final_score ?? 0))
  const topQ = scoredByFinal.slice(0, Math.max(1, Math.ceil(scoredByFinal.length / 4)))
  const duds = topQ.filter((r) => r.total_qty === 0).slice(0, 12)
  const gems = inWindow
    .filter((r) => r.net_profit > 0 && (r.final_score == null || r.final_score <= (scoredByFinal[Math.floor(scoredByFinal.length / 2)]?.final_score ?? 0)))
    .sort((a, b) => b.net_profit - a.net_profit)
    .slice(0, 12)

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold">🎯 실판매 성과 귀속 보드</h1>
          <p className="text-sm text-gray-500 mt-1">
            등록시점 <strong>발굴점수</strong> ↔ 실현 <strong>P&amp;L</strong> 학습 루프 — &ldquo;점수가 높을수록 실제로 더 팔렸나?&rdquo;
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      {/* 기간 */}
      <div className="flex items-center gap-2">
        <span className="text-xs text-gray-500">등록 기간</span>
        {DAYS_OPTIONS.map((d) => (
          <Link
            key={d.v}
            href={`/admin/trend-radar/attribution?days=${d.v}`}
            className={`px-2.5 py-1 text-xs rounded ${days === d.v ? 'bg-amber-100 text-amber-700 font-semibold' : 'text-gray-500 hover:bg-gray-100'}`}
          >
            {d.label}
          </Link>
        ))}
      </div>

      {attribError && (
        <div className="rounded border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800">
          뷰 조회 에러: <code className="font-mono text-xs">{attribError}</code>
          <p className="text-xs mt-2 text-red-700">
            뷰 <code>jimscanner_attribution_skus</code> 미적용 가능성 — <code>supabase/attribution_board.sql</code> 적용 필요.
          </p>
        </div>
      )}

      {/* KPI */}
      <section className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Kpi label="분석 SKU (등록)" value={inWindow.length} sub={`점수 매칭 ${scored.length}개`} />
        <Kpi label="실판매 발생 SKU" value={sold.length} sub={`${inWindow.length ? Math.round((sold.length / inWindow.length) * 100) : 0}% 판매 전환`} />
        <Kpi label="총 실수익" value={`${fmt(totalNet)}원`} highlight positive={totalNet >= 0} />
        <Kpi label="발굴 오탐(dud)" value={duds.length} sub={`놓친 보석 ${gems.length}개`} />
      </section>

      {costMissingTotal > 0 && (
        <p className="text-[11px] text-amber-600">
          ⚠ 매입원가 미입력 주문 <strong>{costMissingTotal}건</strong>은 원가 0 으로 계산되어 실수익이 과대 표시될 수 있습니다.
        </p>
      )}

      {/* ① 캘리브레이션 차트 */}
      <section className="rounded border border-gray-200 p-4 space-y-3">
        <div>
          <h2 className="font-semibold text-gray-800">① 발굴점수 캘리브레이션</h2>
          <p className="text-xs text-gray-500 mt-0.5">final_score 4분위별 평균 실현 판매수량·실수익. 막대가 우상향이면 점수가 매출을 예측.</p>
        </div>
        {buckets.length === 0 ? (
          <p className="text-sm text-gray-400 py-4 text-center">점수 매칭 SKU 4개 미만 — 누적되면 표시됩니다.</p>
        ) : (
          <div className="space-y-2">
            {buckets.map((b) => {
              const w = Math.round((Math.abs(b.avgNet) / maxAvgNet) * 100)
              return (
                <div key={b.label} className="flex items-center gap-3 text-xs">
                  <div className="w-32 text-gray-600 shrink-0">{b.label}</div>
                  <div className="flex-1 bg-gray-100 rounded h-6 relative overflow-hidden">
                    <div
                      className={`h-full ${b.avgNet >= 0 ? 'bg-emerald-400' : 'bg-rose-400'}`}
                      style={{ width: `${w}%` }}
                    />
                    <span className="absolute inset-0 flex items-center px-2 text-[11px] font-medium text-gray-700">
                      평균 실수익 {fmt(b.avgNet)}원 · 평균 {b.avgQty.toFixed(1)}개 · 판매율 {Math.round(b.soldRate * 100)}%
                    </span>
                  </div>
                  <div className="w-12 text-right text-gray-400 shrink-0">n={b.n}</div>
                </div>
              )
            })}
          </div>
        )}
      </section>

      {/* ② 점수 컴포넌트별 상관 랭킹 */}
      <section className="rounded border border-gray-200 p-4 space-y-3">
        <div>
          <h2 className="font-semibold text-gray-800">② 점수 컴포넌트 × 실판매 상관 (스피어만)</h2>
          <p className="text-xs text-gray-500 mt-0.5">내 데이터로 검증된 신호 vs 헛신호. +1 에 가까울수록 실매출 예측력 ↑.</p>
        </div>
        <div className="space-y-2">
          {correlations.map((c) => {
            const lbl = corrLabel(c.r)
            const pct = c.r == null ? 0 : Math.round(((c.r + 1) / 2) * 100)
            return (
              <div key={String(c.key)} className="flex items-center gap-3 text-xs">
                <div className="w-64 shrink-0">
                  <div className="text-gray-700 font-medium">{c.label}</div>
                  <div className="text-[10px] text-gray-400">{c.note} · n={c.n}</div>
                </div>
                <div className="flex-1 bg-gray-100 rounded h-5 relative overflow-hidden">
                  {/* 0(=상관 0) 중앙 기준선 */}
                  <div className="absolute top-0 bottom-0 left-1/2 w-px bg-gray-300" />
                  <div
                    className={`h-full ${(c.r ?? 0) >= 0 ? 'bg-emerald-400' : 'bg-rose-400'}`}
                    style={{
                      width: `${Math.abs(pct - 50)}%`,
                      marginLeft: (c.r ?? 0) >= 0 ? '50%' : `${pct}%`,
                    }}
                  />
                </div>
                <div className={`w-36 text-right shrink-0 font-medium ${lbl.cls}`}>
                  {c.r == null ? '—' : `r=${c.r.toFixed(2)}`} · {lbl.txt}
                </div>
              </div>
            )
          })}
        </div>
      </section>

      {/* ③ 오탐 + 보석 */}
      <section className="grid md:grid-cols-2 gap-4">
        <div className="rounded border border-rose-200 bg-rose-50/40 p-4 space-y-2">
          <h2 className="font-semibold text-rose-700">③-a 발굴 오탐 (dud)</h2>
          <p className="text-[11px] text-rose-600/80">고점수(상위 25%)였지만 한 개도 안 팔린 SKU — 점수 보정 후보.</p>
          <SkuList rows={duds} kind="dud" />
        </div>
        <div className="rounded border border-emerald-200 bg-emerald-50/40 p-4 space-y-2">
          <h2 className="font-semibold text-emerald-700">③-b 놓친 보석 (gem)</h2>
          <p className="text-[11px] text-emerald-600/80">저점수/무점수였지만 실수익을 낸 SKU — 발굴 신호 누락 후보.</p>
          <SkuList rows={gems} kind="gem" />
        </div>
      </section>

      {/* 공식/한계 */}
      <section className="text-xs text-gray-500 border-t border-gray-200 pt-4 space-y-1">
        <div className="font-semibold text-gray-700">📐 방법</div>
        <ul className="list-disc pl-4 space-y-0.5">
          <li>실수익 = 매출 − 매입원가 − 수수료(10.6%) − 부가세(÷11), 취소 제외 (coupang-orders 와 동일).</li>
          <li>발굴점수 = <code>jimscanner_ggsan_recommend</code> RPC 의 goods_no 별 점수 (등록시점 발굴 신호의 프록시).</li>
          <li>점수 매칭 SKU {scored.length}개 / 전체 등록 {inWindow.length}개 · RPC 점수 보유 goods {scoredCount}개.</li>
        </ul>
        <div className="pt-1 text-amber-600">
          ※ 한계: 현재 RPC 점수는 <em>등록시점 스냅샷이 아닌 현 시점 재계산값</em>입니다. 시점 정확도를 높이려면 등록시 점수를 별도 스냅샷 테이블에 적재해 <code>registered_at</code> 직전 row 로 매칭하세요.
        </div>
      </section>
    </div>
  )
}

function SkuList({ rows, kind }: { rows: Joined[]; kind: 'dud' | 'gem' }) {
  if (rows.length === 0) {
    return <p className="text-xs text-gray-400 py-3 text-center">해당 없음 👍</p>
  }
  return (
    <ul className="space-y-1.5">
      {rows.map((r) => (
        <li key={r.listing_id} className="flex items-center gap-2 text-xs bg-white/70 rounded px-2 py-1.5">
          <div className="flex-1 min-w-0">
            <div className="font-medium text-gray-800 truncate" title={r.registered_title ?? ''}>
              {r.registered_title ?? `goods ${r.goods_no}`}
            </div>
            <div className="text-[10px] text-gray-400">
              goods {r.goods_no ?? '—'} · final {r.final_score != null ? r.final_score.toFixed(1) : '무점수'}
              {r.estimated_margin_pct != null && ` · 예상마진 ${r.estimated_margin_pct.toFixed(0)}%`}
            </div>
          </div>
          <div className="text-right shrink-0">
            {kind === 'dud' ? (
              <span className="text-rose-600 font-semibold">판매 0</span>
            ) : (
              <>
                <div className="text-emerald-700 font-semibold tabular-nums">+{fmt(r.net_profit)}원</div>
                <div className="text-[10px] text-gray-400">{r.total_qty}개</div>
              </>
            )}
          </div>
        </li>
      ))}
    </ul>
  )
}

function Kpi({
  label, value, sub, highlight = false, positive = true,
}: { label: string; value: number | string; sub?: string; highlight?: boolean; positive?: boolean }) {
  return (
    <div className={`rounded border p-3 ${highlight ? (positive ? 'border-emerald-300 bg-emerald-50' : 'border-rose-300 bg-rose-50') : 'border-gray-200 bg-white'}`}>
      <div className="text-xs text-gray-500">{label}</div>
      <div className={`text-2xl font-bold mt-1 tabular-nums ${highlight ? (positive ? 'text-emerald-700' : 'text-rose-600') : 'text-gray-900'}`}>
        {typeof value === 'number' ? value.toLocaleString() : value}
      </div>
      {sub && <div className="text-[10px] text-gray-400 mt-0.5">{sub}</div>}
    </div>
  )
}
