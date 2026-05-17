import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

// 새로 추가된 테이블이라 types/supabase.ts 가 아직 모름 → as any 캐스팅으로 통과.
// 마이그레이션 적용 후 `npm run gen:types` 로 재생성 가능.

interface DecisionRow {
  id: string
  decision_type: 'pin' | 'unpin' | 'reject' | 'note'
  entity_kind: 'keyword' | 'product'
  keyword: string | null
  source: string | null
  product_id: string | null
  notes: string | null
  snapshot_final_score: number | null
  snapshot_trend_score: number | null
  snapshot_commerce_score: number | null
  snapshot_supplier_score: number | null
  snapshot_competition_score: number | null
  decided_at: string
}

interface FollowupRow {
  decision_id: string
  decision_type: string
  product_id: string | null
  keyword: string | null
  decided_at: string
  snapshot_final: number | null
  followup_final: number | null
  delta: number | null
}

interface ScoreLatest {
  product_id: string
  final_score: number
  computed_at: string
  category_top?: string
  canonical_name?: string
}

const WINDOWS = [7, 14, 28, 42] as const

async function fetchData() {
  const sb = createAdminClient() as any

  const { data: decisionsRaw } = await sb
    .from('jimscanner_trends_decisions')
    .select(
      'id, decision_type, entity_kind, keyword, source, product_id, notes, snapshot_final_score, snapshot_trend_score, snapshot_commerce_score, snapshot_supplier_score, snapshot_competition_score, decided_at',
    )
    .order('decided_at', { ascending: false })
    .limit(2000)

  const decisions = (decisionsRaw ?? []) as DecisionRow[]

  // 각 window 별 followup 조회 (RPC 4번 호출)
  const followups: Record<number, FollowupRow[]> = {}
  for (const w of WINDOWS) {
    const { data } = await sb.rpc('jimscanner_trends_decision_followups', {
      p_days_after: w,
      p_since: new Date(Date.now() - 180 * 86400_000).toISOString(),
    })
    followups[w] = (data ?? []) as FollowupRow[]
  }

  // product 메타 (이름/카테고리) 조인용
  const productIds = Array.from(
    new Set(decisions.map((d) => d.product_id).filter((x): x is string => !!x)),
  )
  let prodMeta = new Map<string, { canonical_name: string; category_top: string }>()
  if (productIds.length > 0) {
    const { data: prods } = await sb
      .from('jimscanner_trends_products')
      .select('id, canonical_name, category_top')
      .in('id', productIds)
    prodMeta = new Map(
      ((prods ?? []) as any[]).map((p) => [
        p.id as string,
        { canonical_name: p.canonical_name as string, category_top: p.category_top as string },
      ]),
    )
  }

  return { decisions, followups, prodMeta }
}

function bucketDelta(delta: number | null): string {
  if (delta === null || delta === undefined || Number.isNaN(delta)) return 'n/a'
  if (delta >= 20) return '+20↑'
  if (delta >= 10) return '+10~+20'
  if (delta >= 0) return '0~+10'
  if (delta >= -10) return '-10~0'
  if (delta >= -20) return '-20~-10'
  return '-20↓'
}

const BUCKETS = ['+20↑', '+10~+20', '0~+10', '-10~0', '-20~-10', '-20↓', 'n/a']

function classify(decision_type: string): 'pin' | 'reject' | 'other' {
  if (decision_type === 'pin') return 'pin'
  if (decision_type === 'reject' || decision_type === 'unpin') return 'reject'
  return 'other'
}

export default async function DecisionsPage() {
  const { decisions, followups, prodMeta } = await fetchData()

  // 코호트 분포 (각 window x cohort x bucket)
  const distribution: Record<number, Record<'pin' | 'reject', Record<string, number>>> = {}
  for (const w of WINDOWS) {
    distribution[w] = {
      pin: Object.fromEntries(BUCKETS.map((b) => [b, 0])) as Record<string, number>,
      reject: Object.fromEntries(BUCKETS.map((b) => [b, 0])) as Record<string, number>,
    }
    for (const f of followups[w]) {
      const k = classify(f.decision_type)
      if (k === 'other') continue
      const b = bucketDelta(f.delta)
      distribution[w][k][b] = (distribution[w][k][b] ?? 0) + 1
    }
  }

  // 후회 카드 ('이때 핀했지만 점수 하락' TOP 20) — t+28d 기준
  const w28 = followups[28] ?? []
  const regrets = [...w28]
    .filter((f) => f.decision_type === 'pin' && (f.delta ?? 0) < 0)
    .sort((a, b) => (a.delta ?? 0) - (b.delta ?? 0))
    .slice(0, 20)

  // 놓침 카드 ('이때 리젝했는데 급등')
  const misses = [...w28]
    .filter(
      (f) =>
        (f.decision_type === 'reject' || f.decision_type === 'unpin') && (f.delta ?? 0) > 0,
    )
    .sort((a, b) => (b.delta ?? 0) - (a.delta ?? 0))
    .slice(0, 20)

  // 카테고리별 precision / recall / F1 (t+28d 기준)
  // 정의:
  //   TP = pin 결정 후 final 상승(+10 이상)
  //   FP = pin 결정 후 final 하락 또는 정체
  //   FN = reject 결정 후 final 상승(+10 이상) — 놓친 것
  //   precision = TP / (TP+FP), recall = TP / (TP+FN)
  const catAgg = new Map<string, { tp: number; fp: number; fn: number }>()
  const PIN_HIT_THRESHOLD = 10
  for (const f of w28) {
    const meta = f.product_id ? prodMeta.get(f.product_id) : null
    const cat = meta?.category_top ?? 'unknown'
    if (!catAgg.has(cat)) catAgg.set(cat, { tp: 0, fp: 0, fn: 0 })
    const a = catAgg.get(cat)!
    const delta = f.delta ?? 0
    if (f.decision_type === 'pin') {
      if (delta >= PIN_HIT_THRESHOLD) a.tp += 1
      else a.fp += 1
    } else if (f.decision_type === 'reject' || f.decision_type === 'unpin') {
      if (delta >= PIN_HIT_THRESHOLD) a.fn += 1
    }
  }
  const catScores = Array.from(catAgg.entries())
    .map(([cat, { tp, fp, fn }]) => {
      const precision = tp + fp > 0 ? tp / (tp + fp) : null
      const recall = tp + fn > 0 ? tp / (tp + fn) : null
      const f1 =
        precision !== null && recall !== null && precision + recall > 0
          ? (2 * precision * recall) / (precision + recall)
          : null
      return { cat, tp, fp, fn, precision, recall, f1 }
    })
    .sort((a, b) => (b.f1 ?? -1) - (a.f1 ?? -1))

  const totalPin = decisions.filter((d) => d.decision_type === 'pin').length
  const totalReject = decisions.filter(
    (d) => d.decision_type === 'reject' || d.decision_type === 'unpin',
  ).length

  return (
    <div className="space-y-8 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold">결정 회고 코호트</h1>
          <p className="text-sm text-gray-500 mt-1">
            Pin·Reject 결정 시점 스냅샷과 t+N주 점수 추이를 비교해 운영자 직관을 사후 보정.
            총 결정 {decisions.length}건 (pin {totalPin} / reject·unpin {totalReject})
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      {/* 1) 코호트 분포: pin vs reject 의 t+N final 변화 */}
      <section>
        <h2 className="text-sm font-semibold mb-2">
          ① 코호트 분포 — Pin vs Reject 의 t+N final 변화량
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {WINDOWS.map((w) => (
            <div key={w} className="rounded border border-gray-200 p-3">
              <div className="text-xs text-gray-500 font-mono mb-2">t+{w}d ({Math.round(w / 7)}주)</div>
              <table className="w-full text-xs">
                <thead className="text-gray-400">
                  <tr>
                    <th className="text-left">bucket</th>
                    <th className="text-right">pin</th>
                    <th className="text-right">reject</th>
                  </tr>
                </thead>
                <tbody>
                  {BUCKETS.map((b) => {
                    const pinN = distribution[w].pin[b]
                    const rejN = distribution[w].reject[b]
                    return (
                      <tr key={b} className="border-t border-gray-100">
                        <td className="py-1 font-mono">{b}</td>
                        <td className="py-1 text-right">{pinN}</td>
                        <td className="py-1 text-right">{rejN}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          ))}
        </div>
        <p className="text-[11px] text-gray-400 mt-2">
          delta = (t+N일 후 최초 final_score) − (결정 시점 snapshot_final_score). product_id 매핑된 결정만 집계.
        </p>
      </section>

      {/* 2) 후회/놓침 카드 */}
      <section className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <h2 className="text-sm font-semibold mb-2 text-red-700">
            ② 후회 TOP 20 — 핀했지만 t+28d 점수 하락
          </h2>
          <div className="rounded border border-red-200 divide-y divide-red-100 text-xs">
            {regrets.length === 0 ? (
              <div className="px-3 py-4 text-gray-400">데이터 부족 (t+28d 미달 또는 결정 없음)</div>
            ) : (
              regrets.map((r) => {
                const meta = r.product_id ? prodMeta.get(r.product_id) : null
                return (
                  <div key={r.decision_id} className="grid grid-cols-12 px-3 py-2 items-center">
                    <div className="col-span-6 truncate">
                      {r.product_id ? (
                        <Link
                          href={`/admin/trend-radar/products/${r.product_id}`}
                          className="hover:underline"
                        >
                          {meta?.canonical_name ?? r.keyword ?? r.product_id}
                        </Link>
                      ) : (
                        <span>{r.keyword ?? '?'}</span>
                      )}
                      <div className="text-[10px] text-gray-400">
                        {meta?.category_top ?? '—'} · {r.decided_at.slice(0, 10)}
                      </div>
                    </div>
                    <div className="col-span-2 text-right font-mono text-gray-500">
                      {r.snapshot_final?.toFixed(0) ?? '—'}
                    </div>
                    <div className="col-span-2 text-right font-mono text-gray-500">
                      {r.followup_final?.toFixed(0) ?? '—'}
                    </div>
                    <div className="col-span-2 text-right font-mono font-bold text-red-600">
                      {(r.delta ?? 0).toFixed(0)}
                    </div>
                  </div>
                )
              })
            )}
          </div>
        </div>

        <div>
          <h2 className="text-sm font-semibold mb-2 text-amber-700">
            ③ 놓침 TOP 20 — 리젝했는데 t+28d 점수 급등
          </h2>
          <div className="rounded border border-amber-200 divide-y divide-amber-100 text-xs">
            {misses.length === 0 ? (
              <div className="px-3 py-4 text-gray-400">데이터 부족</div>
            ) : (
              misses.map((r) => {
                const meta = r.product_id ? prodMeta.get(r.product_id) : null
                return (
                  <div key={r.decision_id} className="grid grid-cols-12 px-3 py-2 items-center">
                    <div className="col-span-6 truncate">
                      {r.product_id ? (
                        <Link
                          href={`/admin/trend-radar/products/${r.product_id}`}
                          className="hover:underline"
                        >
                          {meta?.canonical_name ?? r.keyword ?? r.product_id}
                        </Link>
                      ) : (
                        <span>{r.keyword ?? '?'}</span>
                      )}
                      <div className="text-[10px] text-gray-400">
                        {meta?.category_top ?? '—'} · {r.decided_at.slice(0, 10)}
                      </div>
                    </div>
                    <div className="col-span-2 text-right font-mono text-gray-500">
                      {r.snapshot_final?.toFixed(0) ?? '—'}
                    </div>
                    <div className="col-span-2 text-right font-mono text-gray-500">
                      {r.followup_final?.toFixed(0) ?? '—'}
                    </div>
                    <div className="col-span-2 text-right font-mono font-bold text-amber-700">
                      +{(r.delta ?? 0).toFixed(0)}
                    </div>
                  </div>
                )
              })
            )}
          </div>
        </div>
      </section>

      {/* 4) 카테고리별 적중률 */}
      <section>
        <h2 className="text-sm font-semibold mb-2">
          ④ 카테고리별 적중률 (t+28d, hit threshold = +10)
        </h2>
        <div className="rounded border border-gray-200 overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-gray-50 text-gray-500">
              <tr>
                <th className="px-3 py-2 text-left">category</th>
                <th className="px-3 py-2 text-right">TP</th>
                <th className="px-3 py-2 text-right">FP</th>
                <th className="px-3 py-2 text-right">FN</th>
                <th className="px-3 py-2 text-right">precision</th>
                <th className="px-3 py-2 text-right">recall</th>
                <th className="px-3 py-2 text-right">F1</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {catScores.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-3 py-4 text-center text-gray-400">
                    아직 t+28d 도달 결정 없음
                  </td>
                </tr>
              ) : (
                catScores.map((c) => (
                  <tr key={c.cat}>
                    <td className="px-3 py-1 font-medium">{c.cat}</td>
                    <td className="px-3 py-1 text-right">{c.tp}</td>
                    <td className="px-3 py-1 text-right">{c.fp}</td>
                    <td className="px-3 py-1 text-right">{c.fn}</td>
                    <td className="px-3 py-1 text-right font-mono">
                      {c.precision !== null ? (c.precision * 100).toFixed(0) + '%' : '—'}
                    </td>
                    <td className="px-3 py-1 text-right font-mono">
                      {c.recall !== null ? (c.recall * 100).toFixed(0) + '%' : '—'}
                    </td>
                    <td className="px-3 py-1 text-right font-mono font-bold">
                      {c.f1 !== null ? c.f1.toFixed(2) : '—'}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        <p className="text-[11px] text-gray-400 mt-2">
          precision = TP/(TP+FP) — 핀한 것 중 진짜로 떴던 비율 · recall = TP/(TP+FN) — 떴어야 할 것 중 핀한 비율.
          FN 은 reject/unpin 결정 후에도 final 이 +10 이상 오른 케이스.
        </p>
      </section>

      {/* 5) 최근 결정 로그 (raw) */}
      <section>
        <h2 className="text-sm font-semibold mb-2">⑤ 최근 결정 로그 (최신 50건)</h2>
        <div className="rounded border border-gray-200 overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-gray-50 text-gray-500">
              <tr>
                <th className="px-3 py-2 text-left">decided_at</th>
                <th className="px-3 py-2 text-left">type</th>
                <th className="px-3 py-2 text-left">keyword / product</th>
                <th className="px-3 py-2 text-right">snapshot final</th>
                <th className="px-3 py-2 text-left">notes</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {decisions.slice(0, 50).map((d) => {
                const meta = d.product_id ? prodMeta.get(d.product_id) : null
                return (
                  <tr key={d.id}>
                    <td className="px-3 py-1 font-mono text-gray-500">
                      {d.decided_at.slice(0, 16).replace('T', ' ')}
                    </td>
                    <td className="px-3 py-1">
                      <span
                        className={
                          'px-1.5 py-0.5 rounded text-[10px] font-medium ' +
                          (d.decision_type === 'pin'
                            ? 'bg-green-100 text-green-700'
                            : d.decision_type === 'reject'
                              ? 'bg-red-100 text-red-700'
                              : d.decision_type === 'unpin'
                                ? 'bg-gray-100 text-gray-700'
                                : 'bg-blue-100 text-blue-700')
                        }
                      >
                        {d.decision_type}
                      </span>
                    </td>
                    <td className="px-3 py-1 truncate">
                      {d.product_id ? (
                        <Link
                          href={`/admin/trend-radar/products/${d.product_id}`}
                          className="hover:underline"
                        >
                          {meta?.canonical_name ?? d.keyword ?? d.product_id}
                        </Link>
                      ) : (
                        d.keyword ?? '?'
                      )}
                    </td>
                    <td className="px-3 py-1 text-right font-mono">
                      {d.snapshot_final_score?.toFixed(0) ?? '—'}
                    </td>
                    <td className="px-3 py-1 text-gray-500 truncate">{d.notes ?? ''}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  )
}
