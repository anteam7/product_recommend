import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'
export const revalidate = 0

// Vocabulary Velocity — 신조어·밈 조기 감지 lexical 선행지표 보드
//
// 1열 ① 등장 곡선 — emergence RPC + per-term sparkline
// 2열 ② 1-hop co-mention 단어
// 3열 ③ 매칭되는 기존 핀/상품 후보 (canonical_name·trends_pins.keyword)
//
// RPC/MV 가 아직 적용 안 된 환경에서는 catch 로 빈 상태 표시.

type EmergeRow = {
  term: string
  gram: 'unigram' | 'bigram'
  recent_mentions: number
  baseline_mentions: number
  sources_n: number
  docs_n: number
  first_recent_day: string
  last_recent_day: string
  growth_ratio: number
}

type DailyRow = {
  term: string
  gram: 'unigram' | 'bigram'
  day: string
  mentions: number
}

type CoRow = { co_term: string; co_mentions: number; co_docs: number }

type TermMeta = {
  term: string
  gram: string
  is_slang: boolean | null
  has_commerce_intent: boolean | null
  category_top: string | null
  brand_guess: string | null
}

const WINDOW = 3
const BASELINE = 30
const MIN_GROWTH = 3
const BASELINE_MAX = 5
const SPARK_DAYS = 14
const TOP_N = 30

async function fetchEmerging(): Promise<{
  rows: EmergeRow[]
  error: string | null
}> {
  const sb = createAdminClient()
  try {
    const { data, error } = await (sb as any).rpc('jimscanner_vocab_emergence', {
      window_days: WINDOW,
      baseline_days: BASELINE,
      min_growth: MIN_GROWTH,
      baseline_max: BASELINE_MAX,
      gram_filter: null,
      limit_n: TOP_N,
    })
    if (error) return { rows: [], error: error.message }
    return { rows: (data ?? []) as EmergeRow[], error: null }
  } catch (e) {
    return { rows: [], error: e instanceof Error ? e.message : String(e) }
  }
}

async function fetchSparklines(terms: EmergeRow[]): Promise<Map<string, number[]>> {
  if (terms.length === 0) return new Map()
  const sb = createAdminClient()
  const sinceDate = new Date(Date.now() - SPARK_DAYS * 86400_000)
  const sinceStr = sinceDate.toISOString().slice(0, 10)

  const out = new Map<string, number[]>()
  try {
    const { data, error } = await (sb as any)
      .from('jimscanner_vocab_daily')
      .select('term, gram, day, mentions')
      .gte('day', sinceStr)
      .in(
        'term',
        terms.map((t) => t.term),
      )
    if (error) return out
    const rows = (data ?? []) as DailyRow[]
    // bucket per (gram,term)
    const buckets = new Map<string, Map<string, number>>()
    for (const r of rows) {
      const k = `${r.gram}::${r.term}`
      let b = buckets.get(k)
      if (!b) {
        b = new Map()
        buckets.set(k, b)
      }
      b.set(r.day.slice(0, 10), (b.get(r.day.slice(0, 10)) ?? 0) + r.mentions)
    }
    // align to SPARK_DAYS slots ending today
    const days: string[] = []
    for (let i = SPARK_DAYS - 1; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86400_000)
      days.push(d.toISOString().slice(0, 10))
    }
    for (const t of terms) {
      const b = buckets.get(`${t.gram}::${t.term}`)
      out.set(`${t.gram}::${t.term}`, days.map((d) => (b ? (b.get(d) ?? 0) : 0)))
    }
    return out
  } catch {
    return out
  }
}

async function fetchCoMentions(target: EmergeRow | null): Promise<CoRow[]> {
  if (!target) return []
  const sb = createAdminClient()
  try {
    const { data, error } = await (sb as any).rpc('jimscanner_vocab_comentions', {
      target_term: target.term.split(' ')[0], // bigram 경우 첫 토큰 기준
      window_days: 7,
      limit_n: 18,
    })
    if (error) return []
    return (data ?? []) as CoRow[]
  } catch {
    return []
  }
}

async function fetchMatchingPinsAndProducts(terms: EmergeRow[]): Promise<{
  pins: { keyword: string; source: string }[]
  products: { id: string; canonical_name: string; category_top: string }[]
}> {
  if (terms.length === 0) return { pins: [], products: [] }
  const sb = createAdminClient()
  const lowered = terms.map((t) => t.term.toLowerCase())

  const [pinsRes, prodRes] = await Promise.all([
    (sb as any)
      .from('jimscanner_trends_pins')
      .select('keyword, source')
      .limit(200),
    (sb as any)
      .from('jimscanner_trends_products')
      .select('id, canonical_name, category_top')
      .limit(500),
  ])

  const pins = (pinsRes.data ?? []) as { keyword: string; source: string }[]
  const products = (prodRes.data ?? []) as {
    id: string
    canonical_name: string
    category_top: string
  }[]

  const matchedPins = pins.filter((p) => {
    const k = (p.keyword ?? '').toLowerCase()
    return lowered.some((t) => k.includes(t) || t.includes(k))
  })
  const matchedProducts = products.filter((p) => {
    const k = (p.canonical_name ?? '').toLowerCase()
    return lowered.some((t) => k.includes(t) || t.includes(k))
  })

  return { pins: matchedPins.slice(0, 25), products: matchedProducts.slice(0, 25) }
}

async function fetchTermMeta(terms: EmergeRow[]): Promise<Map<string, TermMeta>> {
  const out = new Map<string, TermMeta>()
  if (terms.length === 0) return out
  const sb = createAdminClient()
  try {
    const { data } = await (sb as any)
      .from('jimscanner_vocab_terms')
      .select('term, gram, is_slang, has_commerce_intent, category_top, brand_guess')
      .in(
        'term',
        terms.map((t) => t.term),
      )
    for (const r of (data ?? []) as TermMeta[]) {
      out.set(`${r.gram}::${r.term}`, r)
    }
  } catch {
    /* table may not exist yet */
  }
  return out
}

function Sparkline({ values }: { values: number[] }) {
  if (values.length === 0) return <span className="text-gray-300">—</span>
  const max = Math.max(...values, 1)
  const w = 80
  const h = 20
  const step = values.length > 1 ? w / (values.length - 1) : 0
  const pts = values
    .map((v, i) => `${(i * step).toFixed(1)},${(h - (v / max) * h).toFixed(1)}`)
    .join(' ')
  return (
    <svg width={w} height={h} className="inline-block align-middle">
      <polyline
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
        points={pts}
        className="text-blue-600"
      />
    </svg>
  )
}

export default async function VocabPage({
  searchParams,
}: {
  searchParams: Promise<{ term?: string; gram?: string }>
}) {
  const sp = await searchParams

  const { rows: emerging, error } = await fetchEmerging()

  const selected =
    emerging.find((r) => r.term === sp.term && r.gram === (sp.gram ?? r.gram)) ??
    emerging[0] ??
    null

  const [sparklines, coMentions, matches, termMeta] = await Promise.all([
    fetchSparklines(emerging),
    fetchCoMentions(selected),
    fetchMatchingPinsAndProducts(selected ? [selected] : emerging.slice(0, 8)),
    fetchTermMeta(emerging),
  ])

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold">Vocabulary Velocity</h1>
          <p className="text-sm text-gray-500 mt-1">
            신조어·밈 조기 감지 — 직전 {BASELINE}일 ≤{BASELINE_MAX}회 / 최근 {WINDOW}일 ≥
            {MIN_GROWTH}회 패턴.
            검색트렌드 등재 1~4주 전 lexical 선행지표.
          </p>
        </div>
        <Link
          href="/admin/trend-radar"
          className="text-sm text-gray-700 hover:text-black underline"
        >
          ← 대시보드
        </Link>
      </header>

      {error && (
        <div className="rounded border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900">
          RPC 호출 실패: <code className="font-mono">{error}</code>
          <br />
          <span className="text-amber-700">
            supabase/vocab_velocity.sql 미적용 가능. psql 로 적용 후 cron{' '}
            <code className="font-mono">refresh-vocab-daily</code> 1회 실행 필요.
          </span>
        </div>
      )}

      {emerging.length === 0 && !error && (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500">
          <p className="text-base font-medium">아직 등장 패턴 없음</p>
          <p className="text-sm mt-2">
            jimscanner_market_raw 누적이 부족하거나, materialized view 갱신 전.
            <br />
            <code className="font-mono">/api/cron/refresh-vocab-daily</code> 또는{' '}
            <code className="font-mono">SELECT jimscanner_refresh_vocab_daily()</code>.
          </p>
        </div>
      )}

      {emerging.length > 0 && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          {/* ① 등장 곡선 */}
          <section className="rounded border border-gray-200 p-3">
            <h2 className="text-sm font-semibold text-gray-700 mb-2">
              ① 등장 곡선 — emerging Top {emerging.length}
            </h2>
            <div className="grid grid-cols-12 text-[10px] text-gray-500 px-1 py-1 border-b">
              <div className="col-span-5">term</div>
              <div className="col-span-3">spark ({SPARK_DAYS}d)</div>
              <div className="col-span-2 text-right">recent</div>
              <div className="col-span-2 text-right">growth</div>
            </div>
            <div className="divide-y divide-gray-100">
              {emerging.map((r) => {
                const sparks = sparklines.get(`${r.gram}::${r.term}`) ?? []
                const meta = termMeta.get(`${r.gram}::${r.term}`)
                const isActive =
                  selected && selected.term === r.term && selected.gram === r.gram
                return (
                  <Link
                    key={`${r.gram}::${r.term}`}
                    href={`/admin/trend-radar/vocab?term=${encodeURIComponent(r.term)}&gram=${r.gram}`}
                    className={`grid grid-cols-12 px-1 py-1.5 items-center text-sm hover:bg-blue-50 ${
                      isActive ? 'bg-blue-50' : ''
                    }`}
                  >
                    <div className="col-span-5 truncate">
                      <span className="font-medium">{r.term}</span>
                      <span className="ml-1 text-[10px] text-gray-400">
                        {r.gram === 'bigram' ? '2-gram' : '1-gram'}
                      </span>
                      {meta?.is_slang && (
                        <span className="ml-1 text-[10px] bg-pink-100 text-pink-700 px-1 rounded">
                          slang
                        </span>
                      )}
                      {meta?.has_commerce_intent && (
                        <span className="ml-1 text-[10px] bg-emerald-100 text-emerald-700 px-1 rounded">
                          buy
                        </span>
                      )}
                    </div>
                    <div className="col-span-3 text-gray-600">
                      <Sparkline values={sparks} />
                    </div>
                    <div className="col-span-2 text-right font-mono">
                      {r.recent_mentions}/{r.baseline_mentions}
                    </div>
                    <div className="col-span-2 text-right font-mono text-blue-700">
                      ×{r.growth_ratio.toFixed(1)}
                    </div>
                  </Link>
                )
              })}
            </div>
          </section>

          {/* ② 1-hop co-mention */}
          <section className="rounded border border-gray-200 p-3">
            <h2 className="text-sm font-semibold text-gray-700 mb-2">
              ② 1-hop co-mention
              {selected && (
                <span className="ml-2 text-xs font-normal text-gray-500">
                  「{selected.term}」 함께 등장 (7일)
                </span>
              )}
            </h2>
            {coMentions.length === 0 ? (
              <div className="text-xs text-gray-400 px-1 py-4">
                {selected ? '동시 등장 단어 부족 — 더 누적 필요.' : '왼쪽에서 단어 선택.'}
              </div>
            ) : (
              <div className="divide-y divide-gray-100">
                {coMentions.map((c) => (
                  <div
                    key={c.co_term}
                    className="grid grid-cols-12 px-1 py-1.5 text-sm"
                  >
                    <div className="col-span-7 truncate font-medium">{c.co_term}</div>
                    <div className="col-span-3 text-right font-mono text-gray-600">
                      {c.co_mentions}
                    </div>
                    <div className="col-span-2 text-right font-mono text-gray-400">
                      {c.co_docs}d
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* ③ 매칭 핀 / 상품 */}
          <section className="rounded border border-gray-200 p-3">
            <h2 className="text-sm font-semibold text-gray-700 mb-2">
              ③ 매칭 핀·상품 후보
              <span className="ml-2 text-xs font-normal text-gray-500">
                {selected ? `「${selected.term}」 substring` : 'Top 8 단어 substring'}
              </span>
            </h2>

            <div className="mb-3">
              <div className="text-[10px] text-gray-500 px-1 mb-1">
                핀 ({matches.pins.length})
              </div>
              {matches.pins.length === 0 ? (
                <div className="text-xs text-gray-400 px-1 py-1">매칭 없음</div>
              ) : (
                <div className="divide-y divide-gray-100">
                  {matches.pins.map((p, i) => (
                    <div
                      key={`${p.keyword}-${i}`}
                      className="grid grid-cols-12 px-1 py-1 text-sm"
                    >
                      <div className="col-span-9 truncate">{p.keyword}</div>
                      <div className="col-span-3 text-right text-[10px] font-mono text-gray-400">
                        {p.source}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div>
              <div className="text-[10px] text-gray-500 px-1 mb-1">
                상품 ({matches.products.length})
              </div>
              {matches.products.length === 0 ? (
                <div className="text-xs text-gray-400 px-1 py-1">매칭 없음</div>
              ) : (
                <div className="divide-y divide-gray-100">
                  {matches.products.map((p) => (
                    <Link
                      key={p.id}
                      href={`/admin/trend-radar/products/${p.id}`}
                      className="grid grid-cols-12 px-1 py-1 text-sm hover:bg-gray-50"
                    >
                      <div className="col-span-9 truncate">{p.canonical_name}</div>
                      <div className="col-span-3 text-right text-[10px] font-mono text-gray-400">
                        {p.category_top}
                      </div>
                    </Link>
                  ))}
                </div>
              )}
            </div>
          </section>
        </div>
      )}

      <section className="rounded border border-dashed border-gray-300 p-3 text-[11px] text-gray-500 leading-relaxed">
        <strong className="text-gray-700">파이프라인:</strong>{' '}
        market_raw + trends_keywords 한글 텍스트 → 정규식 토큰화 (unigram·bigram) → daily MV{' '}
        <code className="font-mono">jimscanner_vocab_daily</code> → RPC{' '}
        <code className="font-mono">jimscanner_vocab_emergence(window, baseline, min_growth)</code>{' '}
        → 이 보드. LLM 분류 결과는{' '}
        <code className="font-mono">jimscanner_vocab_terms</code> 에 캐시. cron{' '}
        <code className="font-mono">refresh-vocab-daily</code> KST 06:50 매일 1회.
      </section>
    </div>
  )
}
