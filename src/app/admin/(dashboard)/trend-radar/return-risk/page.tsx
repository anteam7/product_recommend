import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import { fetchReturnRiskBatch, riskBadge, type ReturnRiskRow } from '@/lib/trend-radar/return-risk'

export const dynamic = 'force-dynamic'

interface RecommendRow {
  goods_no: string
  title: string
  cate_cd: string | null
  cate_label: string | null
  price_krw: number | null
  is_imminent: boolean
  image_url: string | null
  detail_url: string | null
  final_score: number
}

async function fetchData(opts: { days: number; tier: string }) {
  const sb = createAdminClient()

  // 추천 RPC 가 깔린 경우 → 그 후보를 베이스로
  const { data: rec } = await sb.rpc('jimscanner_ggsan_recommend' as never, {
    days_window: opts.days,
    min_sim: 0.15,
    min_score: 0.0,
    result_limit: 200,
  } as never)

  let candidates = (rec ?? []) as RecommendRow[]

  // fallback: 추천이 비어있으면 최근 활성 ggsan 상품 직접 사용
  if (candidates.length === 0) {
    const { data: prods } = await sb
      .from('jimscanner_ggsan_products')
      .select('goods_no, title, cate_cd, cate_label, price_krw, is_imminent, image_url, detail_url')
      .eq('status', 'active')
      .order('last_seen_at', { ascending: false })
      .limit(200)
    candidates = ((prods ?? []) as Array<Omit<RecommendRow, 'final_score'>>).map((p) => ({
      ...p,
      final_score: 0,
    }))
  }

  const goodsNos = candidates.map((c) => c.goods_no)
  const riskMap = await fetchReturnRiskBatch(sb, goodsNos)

  const rows = candidates.map((c) => ({
    ...c,
    risk: riskMap.get(c.goods_no) ?? null,
  }))

  // tier 필터
  const filtered =
    opts.tier === 'all'
      ? rows
      : rows.filter((r) => r.risk?.risk_tier === opts.tier)

  // risk_score 내림차순 (위험 큰 것 먼저), 같으면 final_score 내림차순
  filtered.sort((a, b) => {
    const ra = a.risk?.risk_score ?? -1
    const rb = b.risk?.risk_score ?? -1
    if (rb !== ra) return rb - ra
    return Number(b.final_score) - Number(a.final_score)
  })

  return { rows: filtered }
}

const DAYS_OPTIONS = [
  { v: 7, label: '7일' },
  { v: 30, label: '30일' },
  { v: 60, label: '60일' },
] as const

const TIER_OPTIONS = [
  { v: 'all', label: '전체' },
  { v: 'high', label: '⚠ 高 (70+)' },
  { v: 'medium', label: '中 (40~69)' },
  { v: 'low', label: '低 (~39)' },
] as const

export default async function ReturnRiskPage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string; tier?: string }>
}) {
  const sp = await searchParams
  const days = parseInt(sp.days ?? '30', 10)
  const validDays = DAYS_OPTIONS.some((d) => d.v === days) ? days : 30
  const tier = TIER_OPTIONS.some((t) => t.v === sp.tier) ? (sp.tier as string) : 'all'

  const { rows } = await fetchData({ days: validDays, tier })

  const highCount = rows.filter((r) => r.risk?.risk_tier === 'high').length
  const medCount = rows.filter((r) => r.risk?.risk_tier === 'medium').length
  const lowCount = rows.filter((r) => r.risk?.risk_tier === 'low').length
  const unscored = rows.filter((r) => !r.risk).length

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold">⚠ 반품위험 게이트 보드</h1>
          <p className="text-sm text-gray-500 mt-1">
            위탁 ROI 를 결정짓는 반품률을 발굴 단계에서 차단. baseline (카테고리) × 옵션변량 × 가격대 휴리스틱 합산 (0~100).
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      <div className="rounded border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-900">
        <strong>V0 휴리스틱</strong> · baseline 시드는 업계 추정치. 실제 반품 데이터 누적 후 베이지언 업데이트 예정.
        리뷰/Q&A '사이즈 안맞·색상 다름·불량' 멘션 빈도는 V1.
      </div>

      <div className="rounded border border-gray-200 px-4 py-3 space-y-2">
        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-500">기간</span>
          {DAYS_OPTIONS.map((d) => (
            <Link
              key={d.v}
              href={`/admin/trend-radar/return-risk?days=${d.v}&tier=${tier}`}
              className={`px-2 py-1 text-xs rounded ${validDays === d.v ? 'bg-amber-100 text-amber-700 font-semibold' : 'text-gray-500 hover:text-black'}`}
            >
              {d.label}
            </Link>
          ))}
        </div>
        <div className="flex items-center gap-2 border-t border-gray-100 pt-2">
          <span className="text-xs text-gray-500">위험도</span>
          {TIER_OPTIONS.map((t) => (
            <Link
              key={t.v}
              href={`/admin/trend-radar/return-risk?days=${validDays}&tier=${t.v}`}
              className={`px-2 py-1 text-xs rounded ${tier === t.v ? 'bg-black text-white font-semibold' : 'text-gray-500 hover:text-black'}`}
            >
              {t.label}
            </Link>
          ))}
        </div>
      </div>

      <section className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Kpi label="후보 총수" value={rows.length} />
        <Kpi label="⚠ 高 위험" value={highCount} highlight={highCount > 0} />
        <Kpi label="中 위험" value={medCount} />
        <Kpi label="低 위험 / 미점수" value={`${lowCount} / ${unscored}`} />
      </section>

      {rows.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500">
          데이터 없음. ggsan 카탈로그 cron 누적 후 다시 방문.
        </div>
      ) : (
        <div className="rounded border border-gray-200 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="text-left px-3 py-2 text-xs text-gray-500 font-medium">상품</th>
                <th className="text-right px-3 py-2 text-xs text-gray-500 font-medium">가격</th>
                <th className="text-center px-3 py-2 text-xs text-gray-500 font-medium">baseline</th>
                <th className="text-center px-3 py-2 text-xs text-gray-500 font-medium">반품위험</th>
                <th className="text-left px-3 py-2 text-xs text-gray-500 font-medium">신호</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {rows.map((r) => {
                const risk: ReturnRiskRow | null = r.risk
                const badge = risk ? riskBadge(risk.risk_tier) : null
                return (
                  <tr key={r.goods_no} className={risk?.risk_tier === 'high' ? 'bg-red-50/40' : ''}>
                    <td className="px-3 py-2">
                      <a href={r.detail_url ?? '#'} target="_blank" rel="noopener" className="block">
                        <div className="text-sm font-medium leading-snug" title={r.title}>
                          {r.title.length > 60 ? r.title.slice(0, 60) + '…' : r.title}
                        </div>
                        <div className="text-xs text-gray-500 mt-0.5">
                          {r.cate_label ?? r.cate_cd ?? '-'} · {r.goods_no}
                          {r.is_imminent && <span className="ml-2 text-red-600">임박</span>}
                        </div>
                      </a>
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-sm">
                      {r.price_krw ? `${r.price_krw.toLocaleString()}원` : '-'}
                    </td>
                    <td className="px-3 py-2 text-center text-xs text-gray-600">
                      {risk ? (
                        <>
                          <div className="font-mono">{Number(risk.baseline_rate).toFixed(1)}%</div>
                          <div className="text-[10px] text-gray-400">{risk.baseline_source}</div>
                        </>
                      ) : (
                        '-'
                      )}
                    </td>
                    <td className="px-3 py-2 text-center">
                      {risk && badge ? (
                        <div className="inline-flex flex-col items-center gap-0.5">
                          <span
                            className={`inline-block text-[10px] px-2 py-0.5 rounded border font-semibold ${badge.className}`}
                          >
                            {badge.label}
                          </span>
                          <span className="text-base font-bold font-mono text-gray-800">
                            {risk.risk_score}
                          </span>
                        </div>
                      ) : (
                        <span className="text-xs text-gray-400">미점수</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-xs text-gray-600">
                      {risk?.signals && risk.signals.length > 0
                        ? risk.signals.map((s, i) => (
                            <span
                              key={i}
                              className="inline-block bg-gray-100 px-1.5 py-0.5 rounded mr-1 mb-1"
                            >
                              {s}
                            </span>
                          ))
                        : <span className="text-gray-400">-</span>}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      <section className="text-xs text-gray-500 border-t border-gray-200 pt-4 space-y-1">
        <div className="font-semibold text-gray-700">📐 ReturnRisk V0 공식</div>
        <code className="block bg-gray-50 px-3 py-2 rounded font-mono text-[11px] leading-relaxed">
          risk_score = category_score(0~50) + option_variance(0~30) + price_penalty(0~20)
          <br />
          category_score = baseline_rate(%) × 2  // 의류 20% → 40, 건기식 3% → 6
          <br />
          option_variance = 사이즈(+15) + 컬러(+10) + 옵션N종(+5), cap 30
          <br />
          price_penalty = price &lt; 1만원 ? 20 : price &lt; 3만원 ? 10 : 0
        </code>
        <div className="pt-2">
          <strong>V1 보강:</strong> 리뷰 텍스트 LLM 분류 (사이즈불일치/색상오인/불량) · 실제 반품 데이터 베이지언 업데이트 · 옵션 매트릭스 (S·M·L × 컬러5) cardinality
        </div>
      </section>
    </div>
  )
}

function Kpi({ label, value, highlight = false }: { label: string; value: number | string; highlight?: boolean }) {
  return (
    <div className={`rounded border p-3 ${highlight ? 'border-red-300 bg-red-50' : 'border-gray-200'}`}>
      <div className="text-xs text-gray-500">{label}</div>
      <div className={`text-2xl font-bold mt-1 ${highlight ? 'text-red-700' : ''}`}>
        {typeof value === 'number' ? value.toLocaleString() : value}
      </div>
    </div>
  )
}
