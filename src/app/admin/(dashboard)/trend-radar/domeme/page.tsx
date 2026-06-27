import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

interface SourcingRow {
  supplier: string
  supplier_goods_no: string
  title: string | null
  supply_price: number | null
  moq: number | null
  inventory: number | null
  overseas: boolean | null
  category_hint: string | null
  trend_keyword: string | null
  trend_signal: number | null
  trend_sources: string[] | null
  market_source: string | null
  market_price: number | null
  safe_cost: number | null
  est_margin_krw: number | null
  est_margin_rate: number | null
  sourcing_score: number | null
  image_url: string | null
  detail_url: string | null
  adopted: boolean | null
  last_sourced_at: string
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function sbLoose(): any {
  return createAdminClient()
}

const MARGIN_OPTIONS = [
  { v: '', label: '전체' },
  { v: '10', label: '≥10%' },
  { v: '20', label: '≥20%' },
  { v: '30', label: '≥30%' },
] as const

const SOURCE_OPTIONS = [
  { v: '', label: '전체' },
  { v: 'coupang', label: '🅒 쿠팡가' },
  { v: 'naver', label: 'Ⓝ 네이버가' },
] as const

function marginBadge(rate: number | null): { cls: string; label: string } | null {
  if (rate == null) return null
  if (rate < 0) return { cls: 'bg-red-100 text-red-700', label: `적자 ${rate.toFixed(0)}%` }
  if (rate < 20) return { cls: 'bg-amber-100 text-amber-800', label: `마진 ${rate.toFixed(0)}%` }
  if (rate < 35) return { cls: 'bg-green-100 text-green-700', label: `마진 ${rate.toFixed(0)}%` }
  return { cls: 'bg-emerald-200 text-emerald-900 font-semibold', label: `마진 ${rate.toFixed(0)}%` }
}

function sourceLabel(s: string): string {
  switch (s) {
    case 'domeggook_main': return '🛒 도매꾹'
    case 'naver_shopping_hot': return '🛍 쇼핑hot'
    case 'naver_shopping_insight': return '📈 쇼핑인사이트'
    case 'naver_search_trend': return '🔍 검색트렌드'
    case 'naver_tvtime': return '📺 TV'
    case 'aliex_best': return '🅰 알리'
    case 'musinsa_best': return '🅼 무신사'
    default: return s
  }
}

async function fetchCandidates(opts: { minMargin: number | null; source: string }): Promise<{ rows: SourcingRow[]; error: string | null }> {
  let q = sbLoose()
    .from('jimscanner_domeme_sourcing_candidates')
    .select('*')
    .order('sourcing_score', { ascending: false })
    .limit(300)
  if (opts.minMargin != null) q = q.gte('est_margin_rate', opts.minMargin)
  if (opts.source) q = q.eq('market_source', opts.source)
  const { data, error } = await q
  if (error) return { rows: [], error: error.message }
  return { rows: (data ?? []) as SourcingRow[], error: null }
}

function buildHref(current: Record<string, string>, override: Record<string, string | null>): string {
  const params = new URLSearchParams()
  for (const [k, v] of Object.entries(current)) if (v) params.set(k, v)
  for (const [k, v] of Object.entries(override)) {
    if (v == null || v === '') params.delete(k)
    else params.set(k, v)
  }
  const qs = params.toString()
  return '/admin/trend-radar/domeme' + (qs ? `?${qs}` : '')
}

export default async function DomemeSourcingPage({
  searchParams,
}: {
  searchParams: Promise<{ margin?: string; source?: string }>
}) {
  const sp = await searchParams
  const marginParam = MARGIN_OPTIONS.some((m) => m.v === sp.margin) ? (sp.margin ?? '') : ''
  const minMargin = marginParam === '' ? null : parseFloat(marginParam)
  const source = SOURCE_OPTIONS.some((s) => s.v === sp.source) ? (sp.source ?? '') : ''

  const current: Record<string, string> = { margin: marginParam, source }
  const { rows, error } = await fetchCandidates({ minMargin, source })

  const total = rows.length
  const coupangCount = rows.filter((r) => r.market_source === 'coupang').length
  const naverCount = rows.filter((r) => r.market_source === 'naver').length
  const avgMargin = rows.length > 0 ? rows.reduce((s, r) => s + Number(r.est_margin_rate ?? 0), 0) / rows.length : 0
  const lastRun = rows.reduce<string | null>((acc, r) => (!acc || r.last_sourced_at > acc ? r.last_sourced_at : acc), null)

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold">🧭 도매매 위탁 소싱 후보</h1>
          <p className="text-sm text-gray-500 mt-1">
            짐스캐너 트렌드 키워드 × 도매매(위탁배송) 카탈로그 × 시장가(쿠팡/네이버) — 신호강도 × 마진율 랭킹
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      <div className="rounded border border-sky-200 bg-sky-50 px-4 py-3 text-xs text-sky-900">
        <strong>도출 방식</strong> · 트렌드 키워드를 도매매 <code>getItemList(market=supply)</code> 로 검색해 제목 유사도로 매칭 →
        쿠팡(크롬 CDP, 사람처럼 검색)·네이버 쇼핑 OpenAPI 의 경쟁 시장가 중앙값으로 마진 산정.
        시장가 출처가 키워드 기준이라 <strong>제목이 다른 상품군과 섞이면 마진이 과대평가될 수 있음</strong> — 근거 키워드를 보고 판단.
        {lastRun && <> · 최근 도출 <strong>{new Date(lastRun).toLocaleString('ko-KR')}</strong></>}
      </div>

      {/* 필터 */}
      <div className="rounded border border-gray-200 px-4 py-3 flex flex-wrap items-center gap-4">
        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-500">마진율 ≥</span>
          {MARGIN_OPTIONS.map((m) => (
            <Link
              key={m.v}
              href={buildHref(current, { margin: m.v || null })}
              className={`px-2 py-1 text-xs rounded ${marginParam === m.v ? 'bg-amber-100 text-amber-700 font-semibold' : 'text-gray-500 hover:text-black'}`}
            >
              {m.label}
            </Link>
          ))}
        </div>
        <div className="flex items-center gap-2 border-l border-gray-100 pl-4">
          <span className="text-xs text-gray-500">시장가 출처</span>
          {SOURCE_OPTIONS.map((s) => (
            <Link
              key={s.v}
              href={buildHref(current, { source: s.v || null })}
              className={`px-2 py-1 text-xs rounded ${source === s.v ? 'bg-blue-100 text-blue-700 font-semibold' : 'text-gray-500 hover:text-black'}`}
            >
              {s.label}
            </Link>
          ))}
        </div>
      </div>

      {/* KPI */}
      <section className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Kpi label="후보 상품" value={total} />
        <Kpi label="평균 마진율" value={`${avgMargin.toFixed(1)}%`} highlight={avgMargin >= 20} />
        <Kpi label="🅒 쿠팡가 기준" value={coupangCount} />
        <Kpi label="Ⓝ 네이버가 기준" value={naverCount} />
      </section>

      {error && (
        <div className="rounded border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800">
          DB 에러: <code className="font-mono text-xs">{error}</code>
          <p className="text-xs mt-2 text-red-700">
            테이블 <code>jimscanner_domeme_sourcing_candidates</code> 미생성 가능성. supabase/domeme_sourcing_candidates.sql 적용 필요.
          </p>
        </div>
      )}

      {!error && rows.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500 space-y-2">
          <div className="text-base font-medium">후보 없음</div>
          <div className="text-xs text-gray-400">
            <code>node --env-file=.env.local scripts/domeme-sourcing-from-trends.mjs</code> 실행으로 채워집니다.
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          {rows.map((r, i) => {
            const badge = marginBadge(r.est_margin_rate)
            return (
              <div
                key={`${r.supplier}-${r.supplier_goods_no}`}
                className="block rounded border border-gray-200 hover:bg-gray-50 overflow-hidden transition-all"
              >
                <div className="flex items-start gap-3 p-3">
                  <div className="w-8 text-center text-sm font-mono text-gray-400 pt-1">{i + 1}</div>

                  <div className="w-20 h-20 bg-gray-100 rounded overflow-hidden flex-shrink-0 relative">
                    {r.image_url && (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={r.image_url} alt="" loading="lazy" className="w-full h-full object-cover" />
                    )}
                    {r.overseas && (
                      <span className="absolute top-0 left-0 bg-gray-800 text-white text-[9px] px-1 leading-tight rounded-br">해외</span>
                    )}
                  </div>

                  <div className="flex-1 min-w-0 space-y-1">
                    <a href={r.detail_url ?? '#'} target="_blank" rel="noopener" className="text-sm font-medium leading-snug hover:underline block" title={r.title ?? ''}>
                      {r.title ?? '(제목 없음)'}
                    </a>
                    <div className="text-xs text-gray-500">
                      {r.category_hint ? `${r.category_hint} · ` : ''}도매매 #{r.supplier_goods_no}
                      {r.moq && r.moq > 1 ? ` · MOQ ${r.moq}` : ''}
                      {r.inventory != null ? ` · 재고 ${r.inventory.toLocaleString()}` : ''}
                    </div>
                    <div className="flex flex-wrap gap-2 text-xs pt-1">
                      {r.trend_keyword && (
                        <span className="bg-amber-100 text-amber-800 px-2 py-0.5 rounded">
                          🔑 &quot;{r.trend_keyword}&quot; (신호 {Number(r.trend_signal ?? 0).toFixed(1)})
                        </span>
                      )}
                      {r.trend_sources && r.trend_sources.length > 0 && (
                        <span className="text-gray-500">from {r.trend_sources.map(sourceLabel).join(', ')}</span>
                      )}
                    </div>
                  </div>

                  <div className="text-right flex-shrink-0 space-y-1">
                    {badge && <div className={`inline-block text-xs px-2 py-0.5 rounded ${badge.cls}`}>{badge.label}</div>}
                    <div className="text-2xl font-bold font-mono text-sky-700">{Number(r.sourcing_score ?? 0).toFixed(0)}</div>
                    <div className="text-[10px] text-gray-500 font-mono space-y-0.5">
                      <div>공급 {r.supply_price?.toLocaleString() ?? '—'}원</div>
                      <div>시장 {r.market_price?.toLocaleString() ?? '—'}원 ({r.market_source})</div>
                      {r.est_margin_krw != null && <div className="text-emerald-700">+{r.est_margin_krw.toLocaleString()}원</div>}
                    </div>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}

      <section className="text-xs text-gray-500 border-t border-gray-200 pt-4 space-y-1">
        <div className="font-semibold text-gray-700">📐 sourcing_score 공식</div>
        <code className="block bg-gray-50 px-3 py-2 rounded font-mono text-[11px] leading-relaxed">
          sourcing_score = 트렌드 신호강도 × 예상 마진율(%)
          <br />
          safe_cost = 시장가 × (1 − 수수료 0.108 − 목표순익 0.20) − 물류 3000
          <br />
          est_margin = 시장가 − 도매매공급가 − 시장가×0.108 − 3000
        </code>
      </section>
    </div>
  )
}

function Kpi({ label, value, highlight = false }: { label: string; value: number | string; highlight?: boolean }) {
  return (
    <div className={`rounded border p-3 ${highlight ? 'border-emerald-300 bg-emerald-50' : 'border-gray-200'}`}>
      <div className="text-xs text-gray-500">{label}</div>
      <div className={`text-2xl font-bold mt-1 ${highlight ? 'text-emerald-700' : ''}`}>
        {typeof value === 'number' ? value.toLocaleString() : value}
      </div>
    </div>
  )
}
