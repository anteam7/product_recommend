import Link from 'next/link'
import { revalidatePath } from 'next/cache'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

// RPC/컬럼이 generated types 에 아직 없음 → as any 캐스팅 (마이그레이션 후 상태 가정)

interface GapRow {
  product_id: string
  canonical_name: string
  category_top: string
  category_mid: string | null
  brand: string | null
  alias_count: number
  final_score: number
  trend_score: number
  commerce_score: number
  supplier_score: number
  competition_score: number
  sourcing_queries: SourcingQueries | null
  supplier_count: number
  last_supplier_collected: string | null
  gap_reason: 'no_supplier' | 'stale'
}

interface SourcingQueries {
  domeggook?: string
  ownerclan?: string
  '1688'?: string
  aliexpress?: string
  generated_at?: string
  model?: string
}

const STALE_DAYS = 30
const MIN_FINAL_SCORE = 30

const MARKETS: {
  key: keyof SourcingQueries
  label: string
  emoji: string
  url: (q: string) => string
  klass: string
}[] = [
  {
    key: 'domeggook',
    label: '도매꾹',
    emoji: '🇰🇷',
    url: (q) => `https://domeggook.com/main/total/total_search.php?sf=title&sk=${encodeURIComponent(q)}`,
    klass: 'bg-amber-100 text-amber-800 hover:bg-amber-200',
  },
  {
    key: 'ownerclan',
    label: '오너클랜',
    emoji: '🇰🇷',
    url: (q) => `https://ownerclan.com/V2/product/search.php?keyword=${encodeURIComponent(q)}`,
    klass: 'bg-orange-100 text-orange-800 hover:bg-orange-200',
  },
  {
    key: '1688',
    label: '1688',
    emoji: '🇨🇳',
    url: (q) => `https://s.1688.com/selloffer/offer_search.htm?keywords=${encodeURIComponent(q)}`,
    klass: 'bg-red-100 text-red-800 hover:bg-red-200',
  },
  {
    key: 'aliexpress',
    label: 'AliExpress',
    emoji: '🌐',
    url: (q) => `https://www.aliexpress.com/wholesale?SearchText=${encodeURIComponent(q)}`,
    klass: 'bg-sky-100 text-sky-800 hover:bg-sky-200',
  },
]

async function registerSupplier(formData: FormData) {
  'use server'
  const productId = String(formData.get('product_id') ?? '').trim()
  const supplierSource = String(formData.get('supplier_source') ?? '').trim()
  const supplierUrl = String(formData.get('supplier_url') ?? '').trim()
  if (!productId || !supplierSource || !supplierUrl) return

  const sb = createAdminClient()
  // 운영자가 도매처를 찾으면 supplier row 등록 → 큐에서 자동 제거(RPC 가 fresh supplier 제외).
  await (sb.from('jimscanner_trends_supplier') as any).insert({
    product_id: productId,
    supplier_source: supplierSource,
    supplier_url: supplierUrl,
    title: '운영자 수동 등록',
    raw_payload: { registered_via: 'sourcing_gap', registered_at: new Date().toISOString() },
  })
  revalidatePath('/admin/trend-radar/sourcing-gap')
}

async function fetchGap() {
  const sb = createAdminClient()
  const { data, error } = await (sb.rpc as any)('jimscanner_trends_sourcing_gap', {
    stale_days: STALE_DAYS,
    min_final_score: MIN_FINAL_SCORE,
    result_limit: 100,
  })
  if (error) return { rows: [] as GapRow[], error: error.message }
  return { rows: (data ?? []) as GapRow[], error: null as string | null }
}

export default async function SourcingGapPage() {
  const { rows, error } = await fetchGap()

  const noSupplier = rows.filter((r) => r.gap_reason === 'no_supplier').length
  const stale = rows.filter((r) => r.gap_reason === 'stale').length
  const withQueries = rows.filter((r) => r.sourcing_queries).length

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold">🔗 소싱 공백 큐</h1>
          <p className="text-sm text-gray-500 mt-1">
            고득점(final≥{MIN_FINAL_SCORE})인데 도매처 미매칭 / {STALE_DAYS}일+ stale 한 &lsquo;죽은 리드&rsquo; ·
            발굴①→소싱② 사이 끊긴 고리
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 레이더로
        </Link>
      </header>

      <section className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <KpiCard label="공백 리드" value={rows.length} hint="action 필요" />
        <KpiCard label="도매처 전무" value={noSupplier} hint="supplier 0건" />
        <KpiCard label="stale" value={stale} hint={`${STALE_DAYS}일+ 미갱신`} />
        <KpiCard label="검색어 생성됨" value={withQueries} hint="딥링크 가능" />
      </section>

      {error && (
        <div className="rounded border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-700">
          RPC 오류: {error}
          <div className="text-xs text-red-600 mt-1">
            supabase/trends_sourcing_gap.sql 마이그레이션이 적용됐는지 확인하세요.
          </div>
        </div>
      )}

      <div className="rounded border border-gray-200 bg-gray-50 px-4 py-2 text-xs text-gray-600">
        검색어가 아직 없으면{' '}
        <code className="px-1 bg-white rounded border">
          node --env-file=.env.local scripts/trends-gen-sourcing-queries.mjs
        </code>{' '}
        로 도매처별 검색어를 LLM 생성하세요.
      </div>

      {rows.length === 0 && !error ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500">
          <p className="text-base font-medium">🎉 소싱 공백 없음</p>
          <p className="text-sm mt-2">고득점 상품에 모두 신선한 도매처가 매칭돼 있습니다.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {rows.map((r) => (
            <div key={r.product_id} className="rounded border border-gray-200 p-4 hover:shadow-sm transition-shadow">
              <div className="flex items-start justify-between gap-4 flex-wrap">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <Link
                      href={`/admin/trend-radar/products/${r.product_id}`}
                      className="font-semibold hover:underline"
                    >
                      {r.canonical_name}
                    </Link>
                    {r.gap_reason === 'no_supplier' ? (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-red-600 text-white">도매처 전무</span>
                    ) : (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-yellow-500 text-white">
                        stale · {r.last_supplier_collected?.slice(0, 10)}
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-gray-500 mt-0.5">
                    {r.category_top}
                    {r.category_mid ? ` · ${r.category_mid}` : ''}
                    {r.brand ? ` · ${r.brand}` : ''} · alias {r.alias_count}
                  </div>
                </div>
                <div className="flex items-center gap-4 text-right shrink-0">
                  <Score label="final" value={r.final_score} bold />
                  <Score label="trend" value={r.trend_score} />
                  <Score label="commerce" value={r.commerce_score} />
                  <Score label="supplier" value={r.supplier_score} />
                </div>
              </div>

              {/* 도매처별 검색어 딥링크 */}
              <div className="mt-3 flex flex-wrap gap-2 items-center">
                {r.sourcing_queries ? (
                  MARKETS.map((m) => {
                    const q = r.sourcing_queries?.[m.key] as string | undefined
                    if (!q) return null
                    return (
                      <a
                        key={m.key}
                        href={m.url(q)}
                        target="_blank"
                        rel="noopener"
                        className={`text-xs px-2.5 py-1 rounded transition-colors ${m.klass}`}
                        title={q}
                      >
                        {m.emoji} {m.label}: <span className="font-mono">{q}</span> ↗
                      </a>
                    )
                  })
                ) : (
                  <span className="text-xs text-gray-400">검색어 미생성 — 스크립트 실행 대기</span>
                )}
              </div>

              {/* 도매처 찾음 → 등록 (등록 시 큐에서 자동 제거) */}
              <form action={registerSupplier} className="mt-3 flex flex-wrap items-center gap-2">
                <input type="hidden" name="product_id" value={r.product_id} />
                <select
                  name="supplier_source"
                  defaultValue="domeggook"
                  className="text-xs border border-gray-300 rounded px-2 py-1"
                >
                  <option value="domeggook">도매꾹</option>
                  <option value="ownerclan">오너클랜</option>
                  <option value="1688">1688</option>
                  <option value="aliexpress">aliexpress</option>
                  <option value="ggsan">ggsan</option>
                </select>
                <input
                  type="url"
                  name="supplier_url"
                  required
                  placeholder="도매처 상품 URL 붙여넣기"
                  className="flex-1 min-w-[200px] text-xs border border-gray-300 rounded px-2 py-1"
                />
                <button
                  type="submit"
                  className="text-xs px-3 py-1 rounded bg-black text-white hover:bg-gray-800"
                >
                  도매처 등록 → 큐 제거
                </button>
              </form>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function KpiCard({ label, value, hint }: { label: string; value: number; hint: string }) {
  return (
    <div className="rounded border border-gray-200 p-4">
      <div className="text-xs text-gray-500">{label}</div>
      <div className="text-3xl font-bold mt-1">{value.toLocaleString()}</div>
      <div className="text-xs text-gray-400 mt-1">{hint}</div>
    </div>
  )
}

function Score({ label, value, bold }: { label: string; value: number; bold?: boolean }) {
  return (
    <div>
      <div className="text-[10px] text-gray-400">{label}</div>
      <div className={`font-mono ${bold ? 'text-lg font-bold' : 'text-sm text-gray-600'}`}>
        {Math.round(value)}
      </div>
    </div>
  )
}
