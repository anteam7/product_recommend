import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import { fetchSourceHealth, type SourceHealth } from '@/lib/trend-radar/source-health'

export const dynamic = 'force-dynamic'

interface AliasRow {
  product_id: string
  source: string | null
}
interface ProductRow {
  id: string
  canonical_name: string
}

interface TrustRow {
  product_id: string
  name: string
  aliasCount: number
  sourcedCount: number
  degradedCount: number
  discount: number
}

async function fetchBoard() {
  const sb = createAdminClient()
  const { health, bySource, totalInserted24h } = await fetchSourceHealth()

  // 상품별 신뢰 디스카운트 — alias.source × 소스 건강도 역추적
  const [aliasRes, prodRes] = await Promise.all([
    sb.from('jimscanner_trends_aliases').select('product_id, source'),
    sb.from('jimscanner_trends_products').select('id, canonical_name'),
  ])
  const aliases = (aliasRes.data ?? []) as AliasRow[]
  const nameById = new Map(
    ((prodRes.data ?? []) as ProductRow[]).map((p) => [p.id, p.canonical_name]),
  )

  const agg = new Map<string, { alias: number; sourced: number; degraded: number }>()
  for (const a of aliases) {
    const cur = agg.get(a.product_id) ?? { alias: 0, sourced: 0, degraded: 0 }
    cur.alias++
    if (a.source) {
      cur.sourced++
      const h = bySource.get(a.source)
      if (h?.degraded) cur.degraded++
    }
    agg.set(a.product_id, cur)
  }

  const trust: TrustRow[] = []
  for (const [pid, c] of agg) {
    if (c.sourced === 0) continue
    const discount = Math.round((c.degraded / c.sourced) * 100) / 100
    if (discount <= 0) continue
    trust.push({
      product_id: pid,
      name: nameById.get(pid) ?? pid,
      aliasCount: c.alias,
      sourcedCount: c.sourced,
      degradedCount: c.degraded,
      discount,
    })
  }
  trust.sort((a, b) => b.discount - a.discount || b.degradedCount - a.degradedCount)

  // corpus 점유율 편향 (최근 30일 inserted 합 기준)
  const totalInserted = health.reduce((s, h) => s + h.meanInserted * h.nRuns, 0)

  return { health, totalInserted24h, totalInserted, trust: trust.slice(0, 40) }
}

function pct(v: number): string {
  return `${Math.round(v * 100)}%`
}

function StatBadge({ ok, warn }: { ok: boolean; warn: boolean }) {
  if (warn) return <span className="text-red-600">●</span>
  if (!ok) return <span className="text-yellow-600">●</span>
  return <span className="text-green-600">●</span>
}

export default async function DataHealthPage() {
  const { health, totalInserted24h, totalInserted, trust } = await fetchBoard()

  const degradedCount = health.filter((h) => h.degraded).length
  const staleCount = health.filter((h) => h.stale).length
  const dropCount = health.filter((h) => h.silentDrop).length

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold">데이터 신뢰도</h1>
          <p className="text-sm text-gray-500 mt-1">
            수집 파이프라인 무결성 — 무성 급락 · 신선도 지연 · 소스 편향 · 발굴 신뢰 디스카운트.
            GIGO 방어용. 입력이 흔들리면 발굴도 흔들린다.
          </p>
        </div>
        <div className="flex gap-3 text-sm">
          <Link href="/admin/trend-radar/sources" className="text-gray-700 hover:text-black underline">
            소스 헬스(나열)
          </Link>
          <Link href="/admin/trend-radar" className="text-gray-700 hover:text-black underline">
            ← 대시보드
          </Link>
        </div>
      </header>

      {/* 요약 카드 */}
      <section className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <SummaryCard label="degraded 소스" value={degradedCount} tone={degradedCount ? 'bad' : 'good'} />
        <SummaryCard label="무성 급락 (z≤-1.5)" value={dropCount} tone={dropCount ? 'bad' : 'good'} />
        <SummaryCard label="신선도 지연 (30h+)" value={staleCount} tone={staleCount ? 'warn' : 'good'} />
        <SummaryCard
          label="신뢰 디스카운트 상품"
          value={trust.length}
          tone={trust.length ? 'warn' : 'good'}
        />
      </section>

      {/* 소스 건강도 진단 */}
      <section>
        <h2 className="text-sm font-semibold text-gray-700 mb-2">
          소스 건강도 — 자기-baseline 대비 (최근 30일, {health.length}개 소스)
        </h2>
        <div className="rounded border border-gray-200 overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-gray-50 text-gray-500">
              <tr>
                <th className="px-3 py-2 text-left">상태</th>
                <th className="px-3 py-2 text-left">source</th>
                <th className="px-3 py-2 text-right">최근 inserted</th>
                <th className="px-3 py-2 text-right">평소(μ±σ)</th>
                <th className="px-3 py-2 text-right">z-score</th>
                <th className="px-3 py-2 text-right">corpus 점유율</th>
                <th className="px-3 py-2 text-right">ok/part/err</th>
                <th className="px-3 py-2 text-right">freshness</th>
                <th className="px-3 py-2 text-left">플래그</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {health.map((h: SourceHealth) => {
                const share = totalInserted > 0 ? (h.meanInserted * h.nRuns) / totalInserted : 0
                const overRepresented = share > 0.35
                return (
                  <tr key={h.source} className={h.degraded ? 'bg-red-50' : undefined}>
                    <td className="px-3 py-1.5 text-base">
                      <StatBadge ok={!h.degraded} warn={h.degraded} />
                    </td>
                    <td className="px-3 py-1.5 font-mono">{h.source}</td>
                    <td className="px-3 py-1.5 text-right font-medium">{h.lastInserted}</td>
                    <td className="px-3 py-1.5 text-right text-gray-500">
                      {h.meanInserted}±{h.sdInserted}
                    </td>
                    <td
                      className={`px-3 py-1.5 text-right font-mono ${
                        h.silentDrop ? 'text-red-600 font-bold' : h.insertedZ < -0.5 ? 'text-yellow-600' : 'text-gray-600'
                      }`}
                    >
                      {h.insertedZ > 0 ? '+' : ''}
                      {h.insertedZ}
                    </td>
                    <td
                      className={`px-3 py-1.5 text-right ${
                        overRepresented ? 'text-orange-600 font-medium' : 'text-gray-500'
                      }`}
                    >
                      {pct(share)}
                      {overRepresented ? ' ⚠' : ''}
                    </td>
                    <td className="px-3 py-1.5 text-right text-gray-500">
                      {pct(h.okRate)}/{pct(h.partialRate)}/{pct(h.errorRate)}
                    </td>
                    <td
                      className={`px-3 py-1.5 text-right ${
                        h.stale ? 'text-red-600 font-medium' : 'text-gray-500'
                      }`}
                    >
                      {h.hoursSinceLast < 48
                        ? `${Math.round(h.hoursSinceLast)}h`
                        : `${Math.round(h.hoursSinceLast / 24)}d`}
                    </td>
                    <td className="px-3 py-1.5 text-[10px]">
                      {h.silentDrop && <span className="text-red-600 mr-1">급락</span>}
                      {h.stale && <span className="text-red-600 mr-1">stale</span>}
                      {h.errorRate > 0.2 && <span className="text-red-600 mr-1">err{pct(h.errorRate)}</span>}
                      {overRepresented && <span className="text-orange-600 mr-1">과대표집</span>}
                      {!h.degraded && !overRepresented && <span className="text-gray-300">—</span>}
                    </td>
                  </tr>
                )
              })}
              {health.length === 0 && (
                <tr>
                  <td colSpan={9} className="px-3 py-6 text-center text-gray-400">
                    최근 30일 trends_runs 기록 없음
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <p className="text-[11px] text-gray-400 mt-1">
          z-score = (최근 inserted − 평소 μ) / σ. z≤-1.5 = 무성 급락(소스 죽었는데 status=ok 인 경우 탐지).
          corpus 점유율 35%+ = 한 소스 과대표집 → 발굴 편향 위험. 24h 총 적재 {totalInserted24h}건.
        </p>
      </section>

      {/* 발굴 신뢰 디스카운트 */}
      <section>
        <h2 className="text-sm font-semibold text-gray-700 mb-2">
          발굴 신뢰 디스카운트 — degraded/stale 소스에 의존하는 상품 ({trust.length})
        </h2>
        <p className="text-xs text-gray-500 mb-2">
          글리치성 수집이 낳은 유령 위너 방어. 디스카운트 ↑ = 떠받치는 소스 대부분이 현재 degraded.
          이런 상품의 급상승은 실수요가 아니라 파이프라인 노이즈일 수 있다.
        </p>
        <div className="rounded border border-gray-200 divide-y divide-gray-100">
          {trust.map((t) => (
            <Link
              key={t.product_id}
              href={`/admin/trend-radar/products/${t.product_id}`}
              className="grid grid-cols-12 px-3 py-2 text-sm items-center hover:bg-gray-50"
            >
              <div className="col-span-1">
                <TrustBadge discount={t.discount} />
              </div>
              <div className="col-span-7 truncate">{t.name}</div>
              <div className="col-span-2 text-right text-xs text-gray-500">
                degraded {t.degradedCount}/{t.sourcedCount} 소스
              </div>
              <div className="col-span-2 text-right text-xs font-mono text-gray-600">
                -{pct(t.discount)}
              </div>
            </Link>
          ))}
          {trust.length === 0 && (
            <div className="px-3 py-6 text-center text-gray-400 text-sm">
              현재 degraded 소스에만 의존하는 상품 없음 — 발굴 입력 건강함.
            </div>
          )}
        </div>
      </section>
    </div>
  )
}

function SummaryCard({
  label,
  value,
  tone,
}: {
  label: string
  value: number
  tone: 'good' | 'warn' | 'bad'
}) {
  const color =
    tone === 'bad'
      ? 'text-red-600'
      : tone === 'warn'
        ? 'text-yellow-600'
        : 'text-green-600'
  return (
    <div className="rounded border border-gray-200 p-3 text-center">
      <div className="text-xs text-gray-500">{label}</div>
      <div className={`mt-1 text-3xl font-bold ${color}`}>{value}</div>
    </div>
  )
}

export function TrustBadge({ discount }: { discount: number }) {
  const severe = discount >= 0.6
  return (
    <span
      className={`inline-block text-[10px] px-1.5 py-0.5 rounded font-medium ${
        severe ? 'bg-red-100 text-red-700' : 'bg-yellow-100 text-yellow-700'
      }`}
    >
      ⚠ -{Math.round(discount * 100)}%
    </span>
  )
}
