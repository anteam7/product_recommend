import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

// ─────────────────────────────────────────────────────────────
// 발굴 의사결정 회고 — 놓친 위너·헛다리 캘리브레이션 보드
// 결정 시점 점수 스냅샷(score_at_decision) vs 현재 점수/재고를 비교해
// 운영자 판단의 후회(놓친 위너)·오판(헛다리)·사각지대를 드러낸다.
// ─────────────────────────────────────────────────────────────

// 임계값 — 사후 변화 판정 기준선
const REGRET_DELTA = 5 // 반려/보류 후 final_score 가 +이만큼 급등하면 '놓친 위너'
const COLLAPSE_RATIO = 0.7 // 채택/소싱 후 현재점수가 스냅샷의 이 비율 미만이면 '점수 붕괴'
const BLINDSPOT_TOP_N = 30 // final_score 상위 N 중 결정 레코드 0건이면 '사각지대'

const REASON_LABELS: Record<string, string> = {
  too_competitive: '경쟁심함',
  low_margin: '마진박함',
  thin_demand: '수요약함',
  risky_supplier: '공급불안',
  good_fit: '핏좋음',
  imminent: '임박기회',
  other: '기타',
}

interface DecisionRow {
  goods_no: string | null
  decision: string
  reason_code: string | null
  note: string | null
  score_at_decision: { final_score?: number } & Record<string, unknown>
  decided_at: string
}

interface RecRow {
  goods_no: string
  title: string
  final_score: number
}

interface GgsanRow {
  goods_no: string
  title: string
  status: string | null
  price_krw: number | null
  detail_url: string | null
}

async function fetchAll() {
  const sb = createAdminClient()

  // 1) 의사결정 (전체) — goods_no 별 최신 1건만 사용
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: decRaw, error: decErr } = await (sb as any)
    .from('jimscanner_trends_decisions')
    .select('goods_no, decision, reason_code, note, score_at_decision, decided_at')
    .order('decided_at', { ascending: false })
    .limit(5000)

  const latest = new Map<string, DecisionRow>()
  for (const d of (decRaw ?? []) as DecisionRow[]) {
    if (d.goods_no && !latest.has(d.goods_no)) latest.set(d.goods_no, d)
  }

  // 2) 현재 추천 점수 (RPC 재실행) — goods_no → final_score
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: recRaw } = await (sb as any).rpc('jimscanner_ggsan_recommend', {
    days_window: 30,
    min_sim: 0.2,
    min_score: 0.5,
    result_limit: 300,
  })
  const recRows = (recRaw ?? []) as RecRow[]
  const curScore = new Map<string, number>()
  for (const r of recRows) curScore.set(r.goods_no, Number(r.final_score))

  // 3) ggsan 카탈로그 상태 (sold_out/removed 판정 + 제목·링크)
  const goodsNos = Array.from(latest.keys())
  let ggsan: GgsanRow[] = []
  if (goodsNos.length > 0) {
    const { data: gRaw } = await sb
      .from('jimscanner_ggsan_products')
      .select('goods_no, title, status, price_krw, detail_url')
      .in('goods_no', goodsNos)
    ggsan = (gRaw ?? []) as GgsanRow[]
  }
  const ggsanMap = new Map(ggsan.map((g) => [g.goods_no, g]))

  return { latest, curScore, recRows, ggsanMap, decErr: decErr?.message ?? null }
}

export default async function RetroPage() {
  const { latest, curScore, recRows, ggsanMap, decErr } = await fetchAll()

  type Verdict = {
    goods_no: string
    title: string
    decision: string
    reason_code: string | null
    note: string | null
    snapScore: number
    nowScore: number | null
    delta: number | null
    status: string | null
    detail_url: string | null
    decided_at: string
  }

  const missedWinners: Verdict[] = [] // ① 놓친 위너
  const falsePositives: Verdict[] = [] // ② 헛다리

  // 사유코드별 적중/오판 집계
  const reasonStats = new Map<string, { total: number; misjudged: number }>()
  function bump(code: string | null, misjudged: boolean) {
    const key = code ?? '(미입력)'
    const s = reasonStats.get(key) ?? { total: 0, misjudged: 0 }
    s.total += 1
    if (misjudged) s.misjudged += 1
    reasonStats.set(key, s)
  }

  for (const [goodsNo, d] of latest) {
    const g = ggsanMap.get(goodsNo)
    const snapScore = Number(d.score_at_decision?.final_score ?? 0)
    const nowScore = curScore.has(goodsNo) ? curScore.get(goodsNo)! : null
    const delta = nowScore != null ? nowScore - snapScore : null
    const base: Verdict = {
      goods_no: goodsNo,
      title: g?.title ?? '(카탈로그에서 사라짐)',
      decision: d.decision,
      reason_code: d.reason_code,
      note: d.note,
      snapScore,
      nowScore,
      delta,
      status: g?.status ?? null,
      detail_url: g?.detail_url ?? null,
      decided_at: d.decided_at,
    }

    const isReject = d.decision === 'rejected' || d.decision === 'deferred'
    const isAdopt = d.decision === 'adopted' || d.decision === 'sourced'

    if (isReject) {
      // 놓친 위너: 반려/보류했는데 점수가 +REGRET_DELTA 이상 급등
      if (delta != null && delta >= REGRET_DELTA) {
        missedWinners.push(base)
        bump(d.reason_code, true)
      } else {
        bump(d.reason_code, false)
      }
    } else if (isAdopt) {
      // 헛다리: 채택/소싱했는데 점수 붕괴 OR 재고 sold_out/removed
      const collapsed = nowScore != null && snapScore > 0 && nowScore < snapScore * COLLAPSE_RATIO
      const goneStock = g?.status === 'sold_out' || g?.status === 'removed' || !g
      if (collapsed || goneStock) {
        falsePositives.push(base)
        bump(d.reason_code, true)
      } else {
        bump(d.reason_code, false)
      }
    }
  }

  missedWinners.sort((a, b) => (b.delta ?? 0) - (a.delta ?? 0))
  falsePositives.sort((a, b) => (a.nowScore ?? 0) - (b.nowScore ?? 0))

  // ③ 사각지대: final_score 상위 N 중 결정 레코드 전혀 없는 후보
  const blindSpots = recRows
    .slice(0, BLINDSPOT_TOP_N)
    .filter((r) => !latest.has(r.goods_no))
    .slice(0, 15)

  const reasonRows = Array.from(reasonStats.entries())
    .map(([code, s]) => ({
      code,
      label: REASON_LABELS[code] ?? code,
      total: s.total,
      misjudged: s.misjudged,
      rate: s.total > 0 ? s.misjudged / s.total : 0,
    }))
    .sort((a, b) => b.rate - a.rate || b.total - a.total)

  const totalDecided = latest.size

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold">🪞 발굴 의사결정 회고</h1>
          <p className="text-sm text-gray-500 mt-1">
            결정 시점 점수 스냅샷 대비 사후 변화로 <strong>놓친 위너·헛다리·사각지대</strong>를 드러낸다.
          </p>
        </div>
        <div className="flex gap-3 text-sm">
          <Link href="/admin/trend-radar/recommend" className="text-gray-700 hover:text-black underline">
            ⭐ 추천 후보
          </Link>
          <Link href="/admin/trend-radar" className="text-gray-700 hover:text-black underline">
            ← 대시보드
          </Link>
        </div>
      </header>

      <div className="rounded border border-gray-200 bg-gray-50 px-4 py-3 text-xs text-gray-600 leading-relaxed">
        <strong>판정 기준</strong> · 놓친 위너 = 반려/보류 후 final_score{' '}
        <code className="font-mono">+{REGRET_DELTA}</code> 이상 급등 · 헛다리 = 채택/소싱 후 점수가 스냅샷의{' '}
        <code className="font-mono">{Math.round(COLLAPSE_RATIO * 100)}%</code> 미만으로 붕괴 또는 재고 품절/삭제 ·
        사각지대 = final_score 상위 {BLINDSPOT_TOP_N} 중 한 번도 검토 안 된 후보.
      </div>

      {decErr && (
        <div className="rounded border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800">
          decisions 조회 에러: <code className="font-mono text-xs">{decErr}</code>
          <p className="text-xs mt-1 text-red-700">
            supabase/trends_decisions.sql 적용 필요할 수 있음.
          </p>
        </div>
      )}

      <section className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Kpi label="기록된 결정(상품)" value={totalDecided} />
        <Kpi label="😱 놓친 위너" value={missedWinners.length} tone="rose" />
        <Kpi label="💸 헛다리" value={falsePositives.length} tone="amber" />
        <Kpi label="🕳 사각지대" value={blindSpots.length} tone="gray" />
      </section>

      {/* ① 놓친 위너 */}
      <Board
        title="😱 놓친 위너 (반려/보류 후 점수 급등)"
        desc="반려·보류했는데 final_score 가 결정 시점보다 크게 올랐다. 후회 후보."
        empty="아직 놓친 위너 없음 (또는 재계산된 점수가 부족)."
      >
        {missedWinners.map((v) => (
          <VerdictRow key={v.goods_no} v={v} highlight="rose" deltaSign />
        ))}
      </Board>

      {/* ② 헛다리 */}
      <Board
        title="💸 헛다리 (채택/소싱 후 점수 붕괴·품절)"
        desc="채택·소싱했는데 점수가 무너졌거나 ggsan 재고가 품절/삭제됐다."
        empty="아직 헛다리 없음."
      >
        {falsePositives.map((v) => (
          <VerdictRow key={v.goods_no} v={v} highlight="amber" />
        ))}
      </Board>

      {/* ③ 사각지대 */}
      <Board
        title="🕳 사각지대 (상위 점수인데 한 번도 안 봄)"
        desc={`final_score 상위 ${BLINDSPOT_TOP_N} 중 의사결정 레코드가 전혀 없는 후보.`}
        empty="상위 후보를 모두 한 번씩은 검토했음. 👍"
      >
        {blindSpots.map((r, i) => (
          <div key={r.goods_no} className="flex items-center gap-3 px-3 py-2 text-sm">
            <span className="w-6 text-center font-mono text-gray-400">{i + 1}</span>
            <span className="flex-1 min-w-0 truncate" title={r.title}>
              {r.title}
            </span>
            <span className="text-xs text-gray-400 font-mono">{r.goods_no}</span>
            <span className="text-base font-bold font-mono text-amber-700">
              {Number(r.final_score).toFixed(1)}
            </span>
          </div>
        ))}
      </Board>

      {/* 사유코드별 편향 */}
      <section className="space-y-2">
        <h2 className="text-lg font-semibold">⚖️ 사유코드별 오판율 (판단 편향)</h2>
        <p className="text-xs text-gray-500">
          각 사유로 내린 결정 중 사후에 뒤집힌(놓친 위너/헛다리) 비율. 높을수록 그 사유를 의심해야 한다.
        </p>
        {reasonRows.length === 0 ? (
          <div className="rounded border border-dashed border-gray-300 p-6 text-center text-gray-400 text-sm">
            집계할 결정 없음.
          </div>
        ) : (
          <div className="rounded border border-gray-200 divide-y divide-gray-100">
            {reasonRows.map((r) => (
              <div key={r.code} className="flex items-center gap-3 px-4 py-2.5 text-sm">
                <span className="w-24 font-medium">{r.label}</span>
                <div className="flex-1 h-2 bg-gray-100 rounded overflow-hidden">
                  <div
                    className={`h-full ${r.rate >= 0.5 ? 'bg-rose-500' : r.rate >= 0.25 ? 'bg-amber-400' : 'bg-emerald-400'}`}
                    style={{ width: `${Math.round(r.rate * 100)}%` }}
                  />
                </div>
                <span className="w-32 text-right text-xs text-gray-500 font-mono">
                  {r.misjudged}/{r.total} ({Math.round(r.rate * 100)}%)
                </span>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}

function Kpi({
  label,
  value,
  tone = 'gray',
}: {
  label: string
  value: number
  tone?: 'rose' | 'amber' | 'gray'
}) {
  const cls =
    tone === 'rose'
      ? 'border-rose-300 bg-rose-50 text-rose-700'
      : tone === 'amber'
        ? 'border-amber-300 bg-amber-50 text-amber-700'
        : 'border-gray-200'
  return (
    <div className={`rounded border p-3 ${cls}`}>
      <div className="text-xs text-gray-500">{label}</div>
      <div className="text-2xl font-bold mt-1">{value.toLocaleString()}</div>
    </div>
  )
}

function Board({
  title,
  desc,
  empty,
  children,
}: {
  title: string
  desc: string
  empty: string
  children: React.ReactNode
}) {
  const arr = Array.isArray(children) ? children : [children]
  const hasItems = arr.some((c) => c)
  return (
    <section className="space-y-2">
      <div>
        <h2 className="text-lg font-semibold">{title}</h2>
        <p className="text-xs text-gray-500">{desc}</p>
      </div>
      {hasItems ? (
        <div className="rounded border border-gray-200 divide-y divide-gray-100">{children}</div>
      ) : (
        <div className="rounded border border-dashed border-gray-300 p-6 text-center text-gray-400 text-sm">
          {empty}
        </div>
      )}
    </section>
  )
}

function VerdictRow({
  v,
  highlight,
  deltaSign = false,
}: {
  v: {
    goods_no: string
    title: string
    decision: string
    reason_code: string | null
    note: string | null
    snapScore: number
    nowScore: number | null
    delta: number | null
    status: string | null
    detail_url: string | null
  }
  highlight: 'rose' | 'amber'
  deltaSign?: boolean
}) {
  const reason = v.reason_code ? (REASON_LABELS[v.reason_code] ?? v.reason_code) : null
  return (
    <div className="flex items-start gap-3 px-3 py-2.5 text-sm">
      <div className="flex-1 min-w-0 space-y-0.5">
        {v.detail_url ? (
          <a href={v.detail_url} target="_blank" rel="noopener" className="font-medium hover:underline block truncate" title={v.title}>
            {v.title}
          </a>
        ) : (
          <div className="font-medium truncate" title={v.title}>
            {v.title}
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2 text-xs text-gray-500">
          <span className={`px-1.5 py-0.5 rounded ${highlight === 'rose' ? 'bg-rose-100 text-rose-700' : 'bg-amber-100 text-amber-700'}`}>
            {v.decision}
          </span>
          {reason && <span className="text-gray-600">사유: {reason}</span>}
          {v.status && <span className="font-mono">재고: {v.status}</span>}
          {v.note && <span className="italic text-gray-400">“{v.note}”</span>}
          <span className="font-mono text-gray-400">{v.goods_no}</span>
        </div>
      </div>
      <div className="text-right flex-shrink-0 font-mono text-xs">
        <div className="text-gray-400">결정시 {v.snapScore.toFixed(1)}</div>
        <div className="text-base font-bold text-gray-800">
          → {v.nowScore != null ? v.nowScore.toFixed(1) : '—'}
        </div>
        {v.delta != null && (
          <div className={v.delta >= 0 ? 'text-rose-600' : 'text-emerald-600'}>
            {deltaSign && v.delta >= 0 ? '+' : ''}
            {v.delta.toFixed(1)}
          </div>
        )}
      </div>
    </div>
  )
}
