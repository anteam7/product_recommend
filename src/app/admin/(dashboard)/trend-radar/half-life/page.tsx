import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

interface HalfLifeRow {
  keyword: string
  category_top: string | null
  peak_at: string
  peak_volume: number
  tau_half_days: number | null
  ci95_low: number | null
  ci95_high: number | null
  r2: number
  decay_class: 'spike' | 'mid' | 'long' | 'noise'
  sample_n: number
}

interface RestockRow {
  goods_no: string
  title: string | null
  restock_cadence_days: number | null
  restock_events: number | null
}

const DAYS_OPTIONS = [
  { v: 14, label: '14일' },
  { v: 30, label: '30일 (기본)' },
  { v: 60, label: '60일' },
  { v: 90, label: '90일' },
] as const

const CLASSES: Array<{ k: HalfLifeRow['decay_class']; label: string; color: string }> = [
  { k: 'spike', label: '단발 (<7d)', color: 'bg-red-100 text-red-700' },
  { k: 'mid', label: '중기 (7-30d)', color: 'bg-amber-100 text-amber-700' },
  { k: 'long', label: '장기 (≥30d)', color: 'bg-emerald-100 text-emerald-700' },
  { k: 'noise', label: '노이즈 (r²<0.4)', color: 'bg-gray-100 text-gray-500' },
]

function classMeta(k: HalfLifeRow['decay_class']) {
  return CLASSES.find((c) => c.k === k) ?? CLASSES[3]
}

// τ½ 기반 권장 발주량
function recommendOrderSize(tau: number | null, decayClass: HalfLifeRow['decay_class']) {
  if (tau == null || decayClass === 'noise') {
    return { size: '관찰', detail: '데이터 부족', tone: 'bg-gray-100 text-gray-600' }
  }
  if (decayClass === 'spike') {
    return { size: '소량', detail: '5–10개 · 단발 스파이크 — 빠른 회수 우선', tone: 'bg-red-50 text-red-700 border-red-200' }
  }
  if (decayClass === 'mid') {
    return { size: '중량', detail: '20–50개 · 2–4주 회수 가능', tone: 'bg-amber-50 text-amber-700 border-amber-200' }
  }
  return { size: '대량', detail: '100개+ · 안정 트렌드 · 리스팅 유지', tone: 'bg-emerald-50 text-emerald-700 border-emerald-200' }
}

// 회수 가능 비율 색 결정
function recoveryRatioTone(ratio: number | null) {
  if (ratio == null) return 'text-gray-400'
  if (ratio < 0.5) return 'text-red-600 font-semibold'
  if (ratio < 1) return 'text-amber-600'
  if (ratio < 2) return 'text-emerald-600 font-semibold'
  return 'text-blue-600 font-semibold'
}

async function fetchHalfLife(days: number): Promise<{ rows: HalfLifeRow[]; error: string | null }> {
  const sb = createAdminClient()
  // RPC 는 supabase/trends_v5_halflife.sql 적용 후 가용. generated types 미반영 → as never 캐스팅
  const { data, error } = await sb.rpc('jimscanner_keyword_halflife_recent' as never, { days } as never)
  if (error) return { rows: [], error: error.message }
  return { rows: (data ?? []) as HalfLifeRow[], error: null }
}

async function fetchRestockCadence(): Promise<RestockRow[]> {
  const sb = createAdminClient()
  // 뷰 jimscanner_ggsan_restock_cadence 가 적용된 상태 가정.
  const { data: rc } = await sb
    .from('jimscanner_ggsan_restock_cadence' as never)
    .select('goods_no, restock_cadence_days, restock_events')
    .order('restock_cadence_days', { ascending: true })
    .limit(2000)
  if (!rc) return []
  const list = rc as unknown as RestockRow[]
  if (list.length === 0) return []
  const ids = list.map((r) => r.goods_no)
  const { data: prods } = await sb
    .from('jimscanner_ggsan_products')
    .select('goods_no, title')
    .in('goods_no', ids)
  const byNo = new Map((prods ?? []).map((p: { goods_no: string; title: string }) => [p.goods_no, p.title]))
  return list.map((r) => ({ ...r, title: byNo.get(r.goods_no) ?? null }))
}

function buildHref(current: Record<string, string>, override: Record<string, string | null>): string {
  const params = new URLSearchParams()
  for (const [k, v] of Object.entries(current)) if (v) params.set(k, v)
  for (const [k, v] of Object.entries(override)) {
    if (v == null || v === '') params.delete(k)
    else params.set(k, v)
  }
  const qs = params.toString()
  return '/admin/trend-radar/half-life' + (qs ? `?${qs}` : '')
}

export default async function HalfLifePage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string; cls?: string; cat?: string }>
}) {
  const sp = await searchParams
  const daysParsed = parseInt(sp.days ?? '30', 10)
  const days = DAYS_OPTIONS.some((d) => d.v === daysParsed) ? daysParsed : 30
  const clsFilter = (sp.cls as HalfLifeRow['decay_class'] | undefined) ?? ''
  const catFilter = sp.cat ?? ''
  const current: Record<string, string> = {
    days: String(days),
    cls: clsFilter,
    cat: catFilter,
  }

  const [{ rows, error }, restockRows] = await Promise.all([fetchHalfLife(days), fetchRestockCadence()])

  // 평균 재입고 주기 (보드 메인 KPI)
  const cadenceValues = restockRows
    .map((r) => Number(r.restock_cadence_days))
    .filter((n) => Number.isFinite(n) && n > 0)
  const avgRestock =
    cadenceValues.length > 0 ? cadenceValues.reduce((s, n) => s + n, 0) / cadenceValues.length : null

  // 카테고리 목록
  const categories = Array.from(new Set(rows.map((r) => r.category_top).filter((x): x is string => !!x))).sort()

  // 필터 적용
  const filtered = rows.filter((r) => {
    if (clsFilter && r.decay_class !== clsFilter) return false
    if (catFilter && (r.category_top ?? '') !== catFilter) return false
    return true
  })

  // KPI
  const classCounts = CLASSES.reduce((acc, c) => {
    acc[c.k] = rows.filter((r) => r.decay_class === c.k).length
    return acc
  }, {} as Record<HalfLifeRow['decay_class'], number>)

  // 카테고리×decay_class 박스플롯 데이터 (간이 — quartile 대신 min/median/max)
  const boxData: Array<{
    category: string
    cls: HalfLifeRow['decay_class']
    n: number
    min: number
    med: number
    max: number
  }> = []
  for (const cat of categories) {
    for (const c of CLASSES) {
      if (c.k === 'noise') continue
      const vals = rows
        .filter((r) => r.category_top === cat && r.decay_class === c.k && r.tau_half_days != null)
        .map((r) => Number(r.tau_half_days))
        .sort((a, b) => a - b)
      if (vals.length === 0) continue
      const min = vals[0]
      const max = vals[vals.length - 1]
      const med = vals[Math.floor(vals.length / 2)]
      boxData.push({ category: cat, cls: c.k, n: vals.length, min, med, max })
    }
  }

  // 시각화 스케일 — 0..max(τ½)
  const allTau = rows.map((r) => Number(r.tau_half_days)).filter((n) => Number.isFinite(n) && n > 0)
  const scaleMax = allTau.length > 0 ? Math.max(...allTau, 30) : 30

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold">⏳ τ½ 반감기 × 회수 윈도우</h1>
          <p className="text-sm text-gray-500 mt-1">
            지수감쇠 회귀로 추정한 키워드 반감기 — 위탁 발주 사이즈와 리스팅 유지 기간 결정에 사용
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      {error && (
        <div className="rounded border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800">
          RPC 에러: <code className="font-mono text-xs">{error}</code>
          <p className="text-xs mt-2 text-red-700">
            RPC <code>jimscanner_keyword_halflife_recent</code> 미적용 가능. supabase/trends_v5_halflife.sql 적용 필요.
          </p>
        </div>
      )}

      {/* 필터 */}
      <div className="rounded border border-gray-200 px-4 py-3 space-y-2">
        <div className="flex flex-wrap items-center gap-4">
          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-500">피크 윈도우</span>
            {DAYS_OPTIONS.map((d) => (
              <Link
                key={d.v}
                href={buildHref(current, { days: String(d.v) })}
                className={`px-2 py-1 text-xs rounded ${days === d.v ? 'bg-emerald-100 text-emerald-700 font-semibold' : 'text-gray-500 hover:text-black'}`}
              >
                {d.label}
              </Link>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-500">분류</span>
            <Link
              href={buildHref(current, { cls: null })}
              className={`px-2 py-1 text-xs rounded ${clsFilter === '' ? 'bg-black text-white font-semibold' : 'text-gray-500 hover:text-black'}`}
            >
              전체
            </Link>
            {CLASSES.map((c) => (
              <Link
                key={c.k}
                href={buildHref(current, { cls: c.k })}
                className={`px-2 py-1 text-xs rounded ${clsFilter === c.k ? c.color + ' font-semibold' : 'text-gray-500 hover:text-black'}`}
              >
                {c.label} ({classCounts[c.k] ?? 0})
              </Link>
            ))}
          </div>
        </div>
        {categories.length > 0 && (
          <div className="flex flex-wrap gap-1 border-t border-gray-100 pt-2">
            <Link
              href={buildHref(current, { cat: null })}
              className={`px-2 py-1 text-xs rounded ${catFilter === '' ? 'bg-black text-white font-semibold' : 'text-gray-500 hover:text-black'}`}
            >
              전체 카테고리
            </Link>
            {categories.map((c) => (
              <Link
                key={c}
                href={buildHref(current, { cat: c })}
                className={`px-2 py-1 text-xs rounded ${catFilter === c ? 'bg-black text-white font-semibold' : 'text-gray-500 hover:text-black'}`}
              >
                {c}
              </Link>
            ))}
          </div>
        )}
      </div>

      {/* KPI */}
      <section className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <Kpi label="총 키워드" value={rows.length} />
        {CLASSES.map((c) => (
          <Kpi key={c.k} label={c.label} value={classCounts[c.k] ?? 0} tone={c.color} />
        ))}
      </section>

      {/* (1) 카테고리×decay_class 박스플롯 */}
      <section className="rounded border border-gray-200 p-4">
        <div className="flex items-baseline justify-between mb-3">
          <h2 className="text-base font-semibold">카테고리 × decay_class 분포</h2>
          <span className="text-xs text-gray-500">막대 = min·median·max (τ½ days), 회색 라인 = avg 재입고 {avgRestock != null ? avgRestock.toFixed(1) + 'd' : 'N/A'}</span>
        </div>
        {boxData.length === 0 ? (
          <p className="text-sm text-gray-400 py-4 text-center">시계열 데이터 누적 후 표시 (회귀 표본 ≥ 3 필요)</p>
        ) : (
          <div className="space-y-2">
            {boxData.map((b, i) => {
              const meta = classMeta(b.cls)
              const pctMin = Math.min(100, (b.min / scaleMax) * 100)
              const pctMed = Math.min(100, (b.med / scaleMax) * 100)
              const pctMax = Math.min(100, (b.max / scaleMax) * 100)
              const cadencePct =
                avgRestock != null ? Math.min(100, (avgRestock / scaleMax) * 100) : null
              return (
                <div key={i} className="flex items-center gap-3 text-xs">
                  <div className="w-40 truncate text-gray-700">{b.category}</div>
                  <div className={`w-24 px-2 py-0.5 rounded text-center ${meta.color}`}>{meta.label}</div>
                  <div className="flex-1 relative h-5 bg-gray-50 rounded">
                    {/* 박스 (min~max) */}
                    <div
                      className="absolute top-1 bottom-1 bg-gray-200 rounded"
                      style={{ left: pctMin + '%', width: Math.max(1, pctMax - pctMin) + '%' }}
                    />
                    {/* median */}
                    <div
                      className="absolute top-0.5 bottom-0.5 w-0.5 bg-black"
                      style={{ left: pctMed + '%' }}
                      title={`median ${b.med.toFixed(1)}d`}
                    />
                    {/* 재입고 주기 기준선 */}
                    {cadencePct != null && (
                      <div
                        className="absolute top-0 bottom-0 w-px bg-gray-500"
                        style={{ left: cadencePct + '%' }}
                        title={`avg restock ${avgRestock!.toFixed(1)}d`}
                      />
                    )}
                  </div>
                  <div className="w-32 text-right text-gray-500 font-mono">
                    n={b.n} · med {b.med.toFixed(1)}d
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </section>

      {/* (2) 상위 후보 테이블 */}
      <section className="rounded border border-gray-200">
        <div className="flex items-baseline justify-between px-4 py-3 border-b border-gray-100">
          <h2 className="text-base font-semibold">상위 후보 ({filtered.length}건)</h2>
          <span className="text-xs text-gray-500">정렬: decay_class → r² → peak_volume</span>
        </div>
        {filtered.length === 0 ? (
          <p className="text-sm text-gray-400 py-12 text-center">
            조건 일치 키워드 없음. cron 누적 후 다시 방문하거나 필터 완화.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-gray-50 text-gray-500">
                <tr>
                  <th className="text-left px-3 py-2">키워드</th>
                  <th className="text-left px-3 py-2">카테고리</th>
                  <th className="text-left px-3 py-2">분류</th>
                  <th className="text-right px-3 py-2">τ½ (days)</th>
                  <th className="text-right px-3 py-2">95% CI</th>
                  <th className="text-right px-3 py-2">r²</th>
                  <th className="text-right px-3 py-2">회수율</th>
                  <th className="text-right px-3 py-2">권장 발주</th>
                  <th className="text-right px-3 py-2">피크</th>
                  <th className="text-right px-3 py-2">n</th>
                </tr>
              </thead>
              <tbody>
                {filtered.slice(0, 200).map((r) => {
                  const meta = classMeta(r.decay_class)
                  const tau = r.tau_half_days != null ? Number(r.tau_half_days) : null
                  const rec = recommendOrderSize(tau, r.decay_class)
                  const recoveryRatio =
                    tau != null && avgRestock != null && avgRestock > 0 ? tau / avgRestock : null
                  return (
                    <tr key={r.keyword} className="border-t border-gray-100 hover:bg-gray-50">
                      <td className="px-3 py-2 font-medium">{r.keyword}</td>
                      <td className="px-3 py-2 text-gray-500">{r.category_top ?? '-'}</td>
                      <td className="px-3 py-2">
                        <span className={`px-2 py-0.5 rounded ${meta.color}`}>{meta.label}</span>
                      </td>
                      <td className="px-3 py-2 text-right font-mono">
                        {tau != null ? tau.toFixed(2) : '—'}
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-gray-500">
                        {r.ci95_low != null && r.ci95_high != null
                          ? `${Number(r.ci95_low).toFixed(1)}–${Number(r.ci95_high).toFixed(1)}`
                          : '—'}
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-gray-500">
                        {Number(r.r2).toFixed(2)}
                      </td>
                      <td className={`px-3 py-2 text-right font-mono ${recoveryRatioTone(recoveryRatio)}`}>
                        {recoveryRatio != null ? recoveryRatio.toFixed(2) + '×' : '—'}
                      </td>
                      <td className="px-3 py-2 text-right">
                        <span className={`px-2 py-0.5 rounded border ${rec.tone}`} title={rec.detail}>
                          {rec.size}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-right text-gray-400">
                        {new Date(r.peak_at).toLocaleDateString('ko-KR', {
                          month: '2-digit',
                          day: '2-digit',
                        })}
                      </td>
                      <td className="px-3 py-2 text-right text-gray-400 font-mono">{r.sample_n}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* (3) 회수율 컬럼 설명 + 권장 발주 룰 */}
      <section className="text-xs text-gray-500 border-t border-gray-200 pt-4 space-y-2">
        <div className="font-semibold text-gray-700">📐 모델</div>
        <code className="block bg-gray-50 px-3 py-2 rounded font-mono text-[11px] leading-relaxed">
          ln(volume) = ln(V₀) − t/τ &nbsp;(피크 이후 시계열, log-linear OLS)
          <br />
          τ½ = ln(2) · τ &nbsp;·&nbsp; 95% CI = τ½ ± 1.96 · |ln2/slope²| · SE(slope)
          <br />
          회수 가능 비율 = τ½ / avg_restock_cadence &nbsp;(≥1× = 재입고 안에 수요가 살아있음)
        </code>
        <div className="font-semibold text-gray-700 pt-2">📦 τ½ 기반 권장 발주</div>
        <ul className="list-disc list-inside space-y-0.5 leading-relaxed">
          <li><strong>spike (&lt;7d)</strong> — <span className="text-red-700">소량</span> 5–10개, 빠른 회수 우선, 리스팅 2주 컷</li>
          <li><strong>mid (7–30d)</strong> — <span className="text-amber-700">중량</span> 20–50개, 2–4주 윈도우 적정</li>
          <li><strong>long (≥30d)</strong> — <span className="text-emerald-700">대량</span> 100개+, 안정 트렌드 · 상시 리스팅</li>
          <li><strong>noise (r²&lt;0.4)</strong> — 회귀 부적합, 발주 보류 후 추가 관찰</li>
        </ul>
        <p className="pt-2 text-gray-400">
          ※ 갱신 주기: <code>classify-trends-llm</code> cron 직후 일1회. 뷰 기반이므로 SELECT 시점 최신.
        </p>
      </section>
    </div>
  )
}

function Kpi({
  label,
  value,
  tone,
}: {
  label: string
  value: number | string
  tone?: string
}) {
  return (
    <div className={`rounded border border-gray-200 p-3 ${tone ? '' : ''}`}>
      <div className="text-xs text-gray-500">{label}</div>
      <div className={`text-2xl font-bold mt-1 ${tone ?? ''}`}>
        {typeof value === 'number' ? value.toLocaleString() : value}
      </div>
    </div>
  )
}
