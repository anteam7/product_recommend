import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

const INTENT_ORDER = ['informational', 'comparison', 'review', 'transactional'] as const
type IntentClass = (typeof INTENT_ORDER)[number] | 'unknown'

const INTENT_LABEL: Record<string, string> = {
  informational: '정보탐색',
  comparison: '비교',
  review: '후기',
  transactional: '거래',
  unknown: '미분류',
}

const INTENT_COLOR: Record<string, string> = {
  informational: 'bg-blue-500',
  comparison: 'bg-amber-500',
  review: 'bg-purple-500',
  transactional: 'bg-emerald-500',
  unknown: 'bg-gray-300',
}

interface SignalRow {
  product_id: string
  intent_class: string
  volume: number | null
}

interface ProductRow {
  id: string
  canonical_name: string
  category_top: string
}

async function fetchData() {
  const sb = createAdminClient()

  // 최근 7일 의도 시그널 (latest view)
  const { data: signals } = await (sb as any)
    .from('jimscanner_trends_intent_latest')
    .select('product_id, intent_class, volume')
    .limit(20000)

  const { data: products } = await sb
    .from('jimscanner_trends_products')
    .select('id, canonical_name, category_top')
    .limit(2000)

  // 최신 purchase_intent_score 가져오기
  const { data: scores } = await (sb as any)
    .from('jimscanner_trends_scores')
    .select('product_id, purchase_intent_score, final_score, commerce_score, computed_at')
    .order('computed_at', { ascending: false })
    .limit(3000)
  const latestScore = new Map<string, any>()
  for (const s of (scores ?? []) as any[]) {
    if (!latestScore.has(s.product_id)) latestScore.set(s.product_id, s)
  }

  return {
    signals: (signals ?? []) as SignalRow[],
    products: (products ?? []) as ProductRow[],
    latestScore,
  }
}

export default async function IntentFunnelPage() {
  const { signals, products, latestScore } = await fetchData()

  const productById = new Map(products.map((p) => [p.id, p]))

  // ── 카테고리별 의도 분포 ─────────────────────────
  const byCategory: Record<string, Record<string, number>> = {}
  // ── product 별 의도 합계 ─────────────────────────
  const byProduct = new Map<string, Record<string, number>>()

  for (const s of signals) {
    const vol = Number(s.volume ?? 0)
    const p = productById.get(s.product_id)
    if (!p) continue
    const cat = p.category_top || 'other'
    if (!byCategory[cat]) byCategory[cat] = {}
    byCategory[cat][s.intent_class] = (byCategory[cat][s.intent_class] ?? 0) + vol

    if (!byProduct.has(s.product_id))
      byProduct.set(s.product_id, { informational: 0, comparison: 0, review: 0, transactional: 0, unknown: 0 })
    const m = byProduct.get(s.product_id)!
    m[s.intent_class] = (m[s.intent_class] ?? 0) + vol
  }

  // 카테고리별 정보→거래 전환비율
  const categoryStats = Object.entries(byCategory).map(([cat, m]) => {
    const info = m.informational ?? 0
    const txn = m.transactional ?? 0
    const total = Object.values(m).reduce((a, b) => a + b, 0)
    const txnPct = total > 0 ? Math.round((txn / total) * 100) : 0
    const infoPct = total > 0 ? Math.round((info / total) * 100) : 0
    const ratio = info > 0 ? +(txn / info).toFixed(2) : null
    return { cat, total, info, txn, ratio, txnPct, infoPct, dist: m }
  })
  categoryStats.sort((a, b) => b.total - a.total)

  // 거래의도 농도 Top N
  const rankings = Array.from(byProduct.entries())
    .map(([pid, m]) => {
      const total = Object.values(m).reduce((a, b) => a + b, 0)
      const txn = m.transactional ?? 0
      const concentration = total > 0 ? (txn / total) * 100 : 0
      const p = productById.get(pid)
      const score = latestScore.get(pid)
      return {
        pid,
        name: p?.canonical_name ?? '?',
        category: p?.category_top ?? 'other',
        total,
        txn,
        concentration: Math.round(concentration),
        purchaseScore: score?.purchase_intent_score ?? null,
        finalScore: score?.final_score ?? null,
        commerceScore: score?.commerce_score ?? null,
        dist: m,
      }
    })
    .filter((r) => r.total >= 5)
    .sort((a, b) => b.concentration - a.concentration)
    .slice(0, 30)

  const hasData = signals.length > 0

  return (
    <div className="space-y-6 p-6">
      <header>
        <h1 className="text-2xl font-bold">의도 퍼널</h1>
        <p className="text-sm text-gray-500 mt-1">
          Naver autosuggest 로 수집한 suffix 를 정보탐색/비교/후기/거래로 분류한 분포. 거래의도 농도 높은 상품 = 지금 살 사람이 많음.
        </p>
      </header>

      {!hasData && (
        <div className="rounded border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
          아직 의도 시그널이 수집되지 않았습니다. <code className="bg-amber-100 px-1 rounded">scripts/harvest-intent-suffix.mjs</code> 를 실행하세요.
        </div>
      )}

      {/* 카테고리별 분포 */}
      <section>
        <h2 className="text-sm font-semibold mb-2">카테고리별 의도 분포</h2>
        <div className="rounded border border-gray-200 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-xs text-gray-500">
              <tr>
                <th className="px-3 py-2 text-left">카테고리</th>
                <th className="px-3 py-2 text-right">총 볼륨</th>
                <th className="px-3 py-2 text-right">정보%</th>
                <th className="px-3 py-2 text-right">거래%</th>
                <th className="px-3 py-2 text-right">거래/정보</th>
                <th className="px-3 py-2 text-left w-1/3">분포</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {categoryStats.map((c) => (
                <tr key={c.cat}>
                  <td className="px-3 py-2 font-medium">{c.cat}</td>
                  <td className="px-3 py-2 text-right font-mono">{c.total.toLocaleString()}</td>
                  <td className="px-3 py-2 text-right font-mono">{c.infoPct}%</td>
                  <td className="px-3 py-2 text-right font-mono">{c.txnPct}%</td>
                  <td className="px-3 py-2 text-right font-mono font-semibold">
                    {c.ratio === null ? '—' : c.ratio.toFixed(2)}
                  </td>
                  <td className="px-3 py-2">
                    <IntentBar dist={c.dist} />
                  </td>
                </tr>
              ))}
              {categoryStats.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-3 py-6 text-center text-gray-400">
                    데이터 없음
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* 거래의도 농도 Top */}
      <section>
        <h2 className="text-sm font-semibold mb-2">거래의도 농도 Top {rankings.length}</h2>
        <p className="text-xs text-gray-500 mb-2">
          suffix 중 transactional 비중이 높은 상품. purchase_intent_score 0–100 은 의도 시그널 가중합 점수.
        </p>
        <div className="rounded border border-gray-200 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-xs text-gray-500">
              <tr>
                <th className="px-3 py-2 text-left">상품</th>
                <th className="px-3 py-2 text-left">카테고리</th>
                <th className="px-3 py-2 text-right">거래%</th>
                <th className="px-3 py-2 text-right">PI score</th>
                <th className="px-3 py-2 text-right">commerce</th>
                <th className="px-3 py-2 text-right">final</th>
                <th className="px-3 py-2 text-left w-64">분포</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {rankings.map((r) => (
                <tr key={r.pid}>
                  <td className="px-3 py-2">
                    <Link href={`/admin/trend-radar/products/${r.pid}`} className="text-blue-600 hover:underline">
                      {r.name}
                    </Link>
                  </td>
                  <td className="px-3 py-2 text-xs text-gray-500">{r.category}</td>
                  <td className="px-3 py-2 text-right font-mono font-semibold">{r.concentration}%</td>
                  <td className="px-3 py-2 text-right font-mono">
                    {r.purchaseScore ?? '—'}
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-gray-600">{r.commerceScore ?? '—'}</td>
                  <td className="px-3 py-2 text-right font-mono">{r.finalScore ?? '—'}</td>
                  <td className="px-3 py-2">
                    <IntentBar dist={r.dist} />
                  </td>
                </tr>
              ))}
              {rankings.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-3 py-6 text-center text-gray-400">
                    의도 시그널 수집된 product 없음
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* 범례 */}
      <section className="text-xs text-gray-500 flex gap-4 flex-wrap">
        {INTENT_ORDER.map((cls) => (
          <span key={cls} className="flex items-center gap-1">
            <span className={`inline-block w-3 h-3 rounded ${INTENT_COLOR[cls]}`} /> {INTENT_LABEL[cls]}
          </span>
        ))}
        <span className="flex items-center gap-1">
          <span className={`inline-block w-3 h-3 rounded ${INTENT_COLOR.unknown}`} /> {INTENT_LABEL.unknown}
        </span>
      </section>
    </div>
  )
}

function IntentBar({ dist }: { dist: Record<string, number> }) {
  const total = Object.values(dist).reduce((a, b) => a + b, 0)
  if (total === 0) return <div className="text-xs text-gray-400">—</div>
  const classes: IntentClass[] = ['informational', 'comparison', 'review', 'transactional']
  return (
    <div className="flex h-3 w-full rounded overflow-hidden bg-gray-100">
      {classes.map((cls) => {
        const v = dist[cls] ?? 0
        const pct = (v / total) * 100
        if (pct <= 0) return null
        return (
          <div
            key={cls}
            className={INTENT_COLOR[cls]}
            style={{ width: `${pct}%` }}
            title={`${INTENT_LABEL[cls]}: ${Math.round(pct)}%`}
          />
        )
      })}
      {dist.unknown ? (
        <div
          className={INTENT_COLOR.unknown}
          style={{ width: `${(dist.unknown / total) * 100}%` }}
          title={`미분류: ${Math.round((dist.unknown / total) * 100)}%`}
        />
      ) : null}
    </div>
  )
}
