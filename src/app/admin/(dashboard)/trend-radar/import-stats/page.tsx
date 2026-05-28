/**
 * 관세청 HS코드 수입통계 × 트렌드 선행지표 보드
 *
 * 패널:
 *  1) HS코드별 12개월 수입금액 시계열 (sparkline + 막대)
 *  2) 카테고리 매핑된 검색 score (jimscanner_trends_keywords) 와 cross-correlation lag
 *  3) 4분면 매트릭스:
 *      - 수입 급증 + 검색 미반영 → 사전 진입 골든윈도우
 *      - 검색 급증 + 수입 정체 → 공급 스카시티 경고
 */
import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import { TaxonomyMapEditor } from './TaxonomyMapEditor'

export const dynamic = 'force-dynamic'

interface CustomsRow {
  hs_code: string
  hs_name: string | null
  month: string // YYYY-MM-DD
  import_value_usd: number | null
  import_qty: number | null
  prev_yoy: number | null
}

interface MapRow {
  id: string
  taxonomy_category: string
  hs_code_prefix: string
  label: string | null
  is_active: boolean
}

interface KeywordRow {
  category_top: string | null
  volume_relative: number | null
  collected_at: string
}

function monthKey(iso: string): string {
  return iso.slice(0, 7) // YYYY-MM
}

function last12Months(): string[] {
  const out: string[] = []
  const now = new Date()
  for (let i = 11; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1))
    out.push(d.toISOString().slice(0, 7))
  }
  return out
}

/**
 * 단순 cross-correlation: 두 시계열의 lag 별 Pearson correlation 을 계산하고
 * 최대값 lag (월 단위, -3..+3) 을 반환. 양수면 import 가 search 보다 선행.
 */
function bestLag(importSeries: number[], searchSeries: number[]): { lag: number; corr: number } {
  if (importSeries.length !== searchSeries.length || importSeries.length < 6) {
    return { lag: 0, corr: 0 }
  }
  let best = { lag: 0, corr: -2 }
  for (let lag = -3; lag <= 3; lag++) {
    const a: number[] = []
    const b: number[] = []
    for (let i = 0; i < importSeries.length; i++) {
      const j = i + lag
      if (j < 0 || j >= importSeries.length) continue
      a.push(importSeries[i])
      b.push(searchSeries[j])
    }
    if (a.length < 4) continue
    const corr = pearson(a, b)
    if (corr > best.corr) best = { lag, corr }
  }
  return best
}

function pearson(a: number[], b: number[]): number {
  const n = a.length
  const ma = a.reduce((s, x) => s + x, 0) / n
  const mb = b.reduce((s, x) => s + x, 0) / n
  let num = 0
  let da = 0
  let db = 0
  for (let i = 0; i < n; i++) {
    const xa = a[i] - ma
    const xb = b[i] - mb
    num += xa * xb
    da += xa * xa
    db += xb * xb
  }
  const denom = Math.sqrt(da * db)
  if (denom === 0) return 0
  return num / denom
}

async function fetchData() {
  const sb = createAdminClient() as any
  const since = new Date(Date.now() - 400 * 86400_000).toISOString()

  const [mapRes, customsRes, keywordsRes] = await Promise.all([
    sb
      .from('customs_hs_taxonomy_map')
      .select('id, taxonomy_category, hs_code_prefix, label, is_active')
      .order('taxonomy_category')
      .order('hs_code_prefix'),
    sb
      .from('jimscanner_customs_imports')
      .select('hs_code, hs_name, month, import_value_usd, import_qty, prev_yoy')
      .gte('month', since.slice(0, 10))
      .order('month', { ascending: true })
      .limit(5000),
    sb
      .from('jimscanner_trends_keywords')
      .select('category_top, volume_relative, collected_at')
      .gte('collected_at', since)
      .not('volume_relative', 'is', null)
      .limit(20000),
  ])

  const map = (mapRes.data ?? []) as MapRow[]
  const customs = (customsRes.data ?? []) as CustomsRow[]
  const keywords = (keywordsRes.data ?? []) as KeywordRow[]

  return { map, customs, keywords, mapErr: mapRes.error?.message ?? null }
}

interface PanelRow {
  hsCode: string
  hsName: string | null
  taxonomy: string
  label: string | null
  importSeries: number[] // 12 months
  searchSeries: number[] // 12 months (same window, mapped via taxonomy_category)
  totalImport: number
  importGrowthLast3: number // %, 최근3개월 평균 vs 직전3개월 평균
  searchGrowthLast3: number
  lag: { lag: number; corr: number }
  signal: 'golden' | 'scarcity' | 'aligned' | 'cold'
}

function buildPanel(
  customs: CustomsRow[],
  keywords: KeywordRow[],
  map: MapRow[],
): PanelRow[] {
  const months = last12Months()
  const monthIdx = new Map(months.map((m, i) => [m, i]))

  // 검색 시계열: taxonomy_category(=category_top) → 월별 평균 volume_relative
  const searchByTax = new Map<string, number[]>()
  for (const m of map) {
    if (!searchByTax.has(m.taxonomy_category)) {
      searchByTax.set(m.taxonomy_category, Array(12).fill(0))
    }
  }
  const searchCount = new Map<string, number[]>()
  for (const k of keywords) {
    if (!k.category_top || k.volume_relative == null) continue
    const idx = monthIdx.get(monthKey(k.collected_at))
    if (idx == null) continue
    if (!searchByTax.has(k.category_top)) continue
    const arr = searchByTax.get(k.category_top)!
    const cnt = searchCount.get(k.category_top) ?? Array(12).fill(0)
    arr[idx] += Number(k.volume_relative)
    cnt[idx] += 1
    searchCount.set(k.category_top, cnt)
  }
  for (const [tax, arr] of searchByTax) {
    const cnt = searchCount.get(tax) ?? Array(12).fill(0)
    for (let i = 0; i < 12; i++) if (cnt[i] > 0) arr[i] = arr[i] / cnt[i]
  }

  // HS 코드별 시계열
  const hsAggKey = new Map<string, MapRow>() // hs_code (정확매칭은 prefix → 매핑된 첫 그룹)
  for (const row of customs) {
    for (const m of map) {
      if (row.hs_code.startsWith(m.hs_code_prefix)) {
        const key = m.hs_code_prefix
        if (!hsAggKey.has(key)) hsAggKey.set(key, m)
        break
      }
    }
  }

  const series = new Map<string, { rows: CustomsRow[]; map: MapRow }>()
  for (const [prefix, m] of hsAggKey) {
    series.set(prefix, { rows: [], map: m })
  }
  for (const row of customs) {
    for (const prefix of hsAggKey.keys()) {
      if (row.hs_code.startsWith(prefix)) {
        series.get(prefix)!.rows.push(row)
        break
      }
    }
  }

  const out: PanelRow[] = []
  for (const [prefix, { rows, map: m }] of series) {
    const importSeries = Array(12).fill(0)
    let hsName: string | null = null
    for (const row of rows) {
      const idx = monthIdx.get(monthKey(row.month))
      if (idx == null) continue
      importSeries[idx] += Number(row.import_value_usd ?? 0)
      if (!hsName && row.hs_name) hsName = row.hs_name
    }
    const searchSeries = (searchByTax.get(m.taxonomy_category) ?? Array(12).fill(0)).slice()
    const totalImport = importSeries.reduce((a, b) => a + b, 0)

    const recent3 = avg(importSeries.slice(9, 12))
    const prev3 = avg(importSeries.slice(6, 9))
    const importGrowth = prev3 > 0 ? ((recent3 - prev3) / prev3) * 100 : 0

    const sRecent = avg(searchSeries.slice(9, 12))
    const sPrev = avg(searchSeries.slice(6, 9))
    const searchGrowth = sPrev > 0 ? ((sRecent - sPrev) / sPrev) * 100 : 0

    let signal: PanelRow['signal'] = 'cold'
    if (importGrowth >= 15 && searchGrowth < 5) signal = 'golden'
    else if (searchGrowth >= 15 && importGrowth < 5) signal = 'scarcity'
    else if (importGrowth >= 10 && searchGrowth >= 10) signal = 'aligned'

    out.push({
      hsCode: prefix,
      hsName,
      taxonomy: m.taxonomy_category,
      label: m.label,
      importSeries,
      searchSeries,
      totalImport,
      importGrowthLast3: Math.round(importGrowth * 10) / 10,
      searchGrowthLast3: Math.round(searchGrowth * 10) / 10,
      lag: bestLag(importSeries, searchSeries),
      signal,
    })
  }
  return out.sort((a, b) => b.totalImport - a.totalImport)
}

function avg(arr: number[]): number {
  if (arr.length === 0) return 0
  return arr.reduce((a, b) => a + b, 0) / arr.length
}

function formatUsd(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `$${(n / 1_000).toFixed(0)}K`
  return `$${Math.round(n)}`
}

function Sparkline({ values, width = 120, height = 28 }: { values: number[]; width?: number; height?: number }) {
  const max = Math.max(...values, 1)
  const min = Math.min(...values, 0)
  const range = max - min || 1
  const step = width / Math.max(values.length - 1, 1)
  const path = values
    .map((v, i) => {
      const x = i * step
      const y = height - ((v - min) / range) * height
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')
  return (
    <svg width={width} height={height} className="inline-block">
      <path d={path} fill="none" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  )
}

const SIGNAL_LABEL = {
  golden: { tag: '🟢 골든윈도우', color: 'bg-green-100 text-green-800 border-green-300' },
  scarcity: { tag: '🔴 공급 스카시티', color: 'bg-red-100 text-red-800 border-red-300' },
  aligned: { tag: '🔵 정렬', color: 'bg-blue-50 text-blue-700 border-blue-200' },
  cold: { tag: '— 무관심', color: 'bg-gray-50 text-gray-500 border-gray-200' },
} as const

export default async function ImportStatsPage() {
  const { map, customs, keywords, mapErr } = await fetchData()
  const panel = buildPanel(customs, keywords, map)

  const months = last12Months()
  const golden = panel.filter((p) => p.signal === 'golden')
  const scarcity = panel.filter((p) => p.signal === 'scarcity')

  const hasData = customs.length > 0

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold">관세청 HS코드 수입통계 × 트렌드 선행지표</h1>
          <p className="text-sm text-gray-500 mt-1">
            한국 수입 ground truth — 검색 시그널 대비 1~3개월 선행할 수 있는 supply-side 보드
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      {mapErr && (
        <div className="rounded border border-yellow-300 bg-yellow-50 p-3 text-xs text-yellow-800">
          ⚠ customs_hs_taxonomy_map 조회 실패: {mapErr}. supabase/customs_imports.sql 을 먼저 적용하세요.
        </div>
      )}

      {!hasData && (
        <div className="rounded border border-dashed border-gray-300 p-6 text-sm text-gray-600">
          <p className="font-medium text-gray-800">아직 수입 데이터가 없습니다.</p>
          <p className="mt-2 text-xs">
            <code className="px-1 bg-gray-100 rounded">node --env-file=.env.local scripts/customs-import-fetch.mjs --mock</code>{' '}
            로 mock 데이터를 적재하거나, CUSTOMS_API_KEY 를 .env.local 에 설정하고 same 스크립트 (--mock 제외) 를 실행하세요.
          </p>
        </div>
      )}

      {/* 4분면 매트릭스 */}
      <section className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="rounded border border-green-300 bg-green-50 p-4">
          <div className="text-sm font-semibold text-green-900">
            🟢 사전 진입 골든윈도우 ({golden.length})
          </div>
          <div className="text-xs text-green-800 mt-1">
            수입은 늘었는데 검색은 안 떴음 = 도매·위탁 선점 기회
          </div>
          <div className="mt-2 space-y-1">
            {golden.length === 0 && <div className="text-xs text-gray-500">해당 없음</div>}
            {golden.slice(0, 6).map((p) => (
              <div key={p.hsCode} className="flex items-center justify-between text-xs">
                <span className="font-mono">{p.hsCode}</span>
                <span className="text-gray-600 truncate mx-2 flex-1">{p.label ?? p.hsName ?? '—'}</span>
                <span className="text-green-700 font-mono">+{p.importGrowthLast3}%</span>
              </div>
            ))}
          </div>
        </div>

        <div className="rounded border border-red-300 bg-red-50 p-4">
          <div className="text-sm font-semibold text-red-900">
            🔴 공급 스카시티 경고 ({scarcity.length})
          </div>
          <div className="text-xs text-red-800 mt-1">
            검색은 급증했는데 수입은 정체 = 마진 압박 + 품절 위험
          </div>
          <div className="mt-2 space-y-1">
            {scarcity.length === 0 && <div className="text-xs text-gray-500">해당 없음</div>}
            {scarcity.slice(0, 6).map((p) => (
              <div key={p.hsCode} className="flex items-center justify-between text-xs">
                <span className="font-mono">{p.hsCode}</span>
                <span className="text-gray-600 truncate mx-2 flex-1">{p.label ?? p.hsName ?? '—'}</span>
                <span className="text-red-700 font-mono">검색 +{p.searchGrowthLast3}%</span>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* 메인 시계열 표 */}
      <section>
        <h2 className="text-sm font-semibold text-gray-700 mb-2">
          HS코드별 12개월 수입 시계열 ({months[0]} ~ {months[11]})
        </h2>
        <div className="rounded border border-gray-200 overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-gray-50 text-gray-500">
              <tr>
                <th className="px-2 py-2 text-left">HS</th>
                <th className="px-2 py-2 text-left">분류</th>
                <th className="px-2 py-2 text-left">라벨</th>
                <th className="px-2 py-2 text-right">12M 총수입</th>
                <th className="px-2 py-2 text-center">수입 추이</th>
                <th className="px-2 py-2 text-center">검색 추이</th>
                <th className="px-2 py-2 text-right">수입 △3M</th>
                <th className="px-2 py-2 text-right">검색 △3M</th>
                <th className="px-2 py-2 text-right">선행 lag</th>
                <th className="px-2 py-2 text-left">시그널</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {panel.map((p) => {
                const sig = SIGNAL_LABEL[p.signal]
                return (
                  <tr key={p.hsCode}>
                    <td className="px-2 py-1 font-mono">{p.hsCode}</td>
                    <td className="px-2 py-1 text-gray-600">{p.taxonomy}</td>
                    <td className="px-2 py-1 text-gray-600 truncate max-w-[180px]">
                      {p.label ?? p.hsName ?? '—'}
                    </td>
                    <td className="px-2 py-1 text-right font-mono">{formatUsd(p.totalImport)}</td>
                    <td className="px-2 py-1 text-center text-green-700">
                      <Sparkline values={p.importSeries} />
                    </td>
                    <td className="px-2 py-1 text-center text-blue-700">
                      <Sparkline values={p.searchSeries} />
                    </td>
                    <td
                      className={`px-2 py-1 text-right font-mono ${
                        p.importGrowthLast3 >= 15
                          ? 'text-green-700 font-bold'
                          : p.importGrowthLast3 <= -10
                            ? 'text-red-600'
                            : 'text-gray-600'
                      }`}
                    >
                      {p.importGrowthLast3 > 0 ? '+' : ''}
                      {p.importGrowthLast3}%
                    </td>
                    <td
                      className={`px-2 py-1 text-right font-mono ${
                        p.searchGrowthLast3 >= 15
                          ? 'text-blue-700 font-bold'
                          : p.searchGrowthLast3 <= -10
                            ? 'text-red-600'
                            : 'text-gray-600'
                      }`}
                    >
                      {p.searchGrowthLast3 > 0 ? '+' : ''}
                      {p.searchGrowthLast3}%
                    </td>
                    <td className="px-2 py-1 text-right font-mono text-gray-600">
                      {p.lag.lag > 0 ? `import +${p.lag.lag}M 선행` : p.lag.lag < 0 ? `search ${-p.lag.lag}M 선행` : '동행'}
                      <span className="text-gray-400 ml-1">(r={p.lag.corr.toFixed(2)})</span>
                    </td>
                    <td className="px-2 py-1">
                      <span className={`text-xs border rounded px-1.5 py-0.5 ${sig.color}`}>{sig.tag}</span>
                    </td>
                  </tr>
                )
              })}
              {panel.length === 0 && (
                <tr>
                  <td colSpan={10} className="px-3 py-6 text-center text-gray-400">
                    매핑된 HS 코드가 없습니다. 아래 매핑 편집기에서 추가하세요.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* lag 막대 — 선행성 시각화 */}
      {panel.length > 0 && (
        <section>
          <h2 className="text-sm font-semibold text-gray-700 mb-2">
            cross-correlation lag: import 가 search 보다 N개월 선행
          </h2>
          <div className="rounded border border-gray-200 p-4 space-y-1">
            {panel.slice(0, 12).map((p) => {
              const lag = p.lag.lag
              const lagPct = Math.min(Math.abs(lag) / 3, 1) * 50
              return (
                <div key={p.hsCode} className="flex items-center text-xs gap-2">
                  <div className="w-16 font-mono text-gray-700">{p.hsCode}</div>
                  <div className="flex-1 relative h-4 bg-gray-50 rounded">
                    <div className="absolute left-1/2 top-0 bottom-0 w-px bg-gray-300" />
                    {lag !== 0 && (
                      <div
                        className={`absolute top-0 bottom-0 ${lag > 0 ? 'bg-green-400' : 'bg-orange-400'}`}
                        style={
                          lag > 0
                            ? { left: '50%', width: `${lagPct}%` }
                            : { right: '50%', width: `${lagPct}%` }
                        }
                      />
                    )}
                  </div>
                  <div className="w-32 text-right text-gray-600">
                    {lag > 0 ? `import +${lag}M 선행` : lag < 0 ? `search ${-lag}M 선행` : '동행'} · r={p.lag.corr.toFixed(2)}
                  </div>
                </div>
              )
            })}
          </div>
        </section>
      )}

      {/* 매핑 편집기 */}
      <section>
        <h2 className="text-sm font-semibold text-gray-700 mb-2">
          taxonomy_category ↔ HS코드 매핑 (운영자 편집)
        </h2>
        <p className="text-xs text-gray-500 mb-3">
          jimscanner_trends_products.taxonomy_category / category_top 와 HS prefix 를 묶어 검색 vs 수입을 같은 축에서 비교.
        </p>
        <TaxonomyMapEditor rows={map} />
      </section>

      <section className="rounded border border-dashed border-gray-300 p-4 text-xs text-gray-500">
        <strong className="text-gray-700">데이터 적재:</strong>{' '}
        <code className="px-1 bg-gray-100 rounded">node --env-file=.env.local scripts/customs-import-fetch.mjs</code>{' '}
        — 주 1회 cron 권장 (CUSTOMS_API_KEY 없으면 자동으로 mock 모드). UPSERT 키 = (hs_code, month, source).
      </section>
    </div>
  )
}
