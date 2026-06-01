import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import { detectBrandTokens, type DetectedToken } from './brandTokens'

export const dynamic = 'force-dynamic'

// jimscanner_trends_ip_risk_board 뷰 (supabase 타입 미생성 → as any 캐스팅)
interface BoardRow {
  id: string
  canonical_name: string
  category_top: string
  category_mid: string | null
  brand: string | null
  ip_risk_label: 'generic' | 'brand_mention' | 'likely_counterfeit' | null
  ip_risk_score: number | null
  ip_risk_tokens: { token: string; kind?: string; source?: string }[] | null
  ip_risk_reasons: string | null
  ip_classified_at: string | null
  alias_count: number
  has_overseas_supplier: boolean
  supplier_sources: string[] | null
  risk_band: 'stop_risk' | 'caution' | 'safe_generic' | 'unrated'
}

interface AliasRow {
  product_id: string
  alias: string
  source: string | null
}

interface EnrichedRow extends BoardRow {
  aliases: AliasRow[]
  detectedTokens: DetectedToken[]
}

const OVERSEAS = new Set(['1688', 'aliexpress', 'taobao', 'temu'])

async function fetchBoard() {
  const sb = createAdminClient()

  // 뷰는 타입 미생성 → as any
  const { data: board } = await (sb as any)
    .from('jimscanner_trends_ip_risk_board')
    .select(
      'id, canonical_name, category_top, category_mid, brand, ip_risk_label, ip_risk_score, ip_risk_tokens, ip_risk_reasons, ip_classified_at, alias_count, has_overseas_supplier, supplier_sources, risk_band',
    )
    .order('ip_risk_score', { ascending: false, nullsFirst: false })
    .limit(1000)

  const rows = (board ?? []) as BoardRow[]
  const ids = rows.map((r) => r.id)
  if (ids.length === 0) return { rows: [] as EnrichedRow[] }

  // 근거 칩용 alias (브랜드 토큰이 어디서 왔는지 보여주기 위함)
  const { data: aliasData } = await sb
    .from('jimscanner_trends_aliases')
    .select('product_id, alias, source')
    .in('product_id', ids)

  const aliasByProduct = new Map<string, AliasRow[]>()
  for (const a of (aliasData ?? []) as AliasRow[]) {
    const list = aliasByProduct.get(a.product_id) ?? []
    list.push(a)
    aliasByProduct.set(a.product_id, list)
  }

  const enriched: EnrichedRow[] = rows.map((r) => {
    const aliases = aliasByProduct.get(r.id) ?? []
    // alias + 상품명에서 룰 기반 브랜드 토큰 탐지 (근거 하이라이트 / unrated 보조 판정)
    const tokenSet = new Map<string, DetectedToken>()
    for (const t of detectBrandTokens(r.canonical_name)) tokenSet.set(t.token, t)
    for (const a of aliases) for (const t of detectBrandTokens(a.alias)) tokenSet.set(t.token, t)
    if (r.brand) for (const t of detectBrandTokens(r.brand)) tokenSet.set(t.token, t)
    return { ...r, aliases, detectedTokens: [...tokenSet.values()] }
  })

  return { rows: enriched }
}

function effectiveBand(r: EnrichedRow): BoardRow['risk_band'] {
  // LLM 라벨이 있으면 그대로. 없으면(unrated) 룰 기반 토큰으로 보조 판정.
  if (r.risk_band !== 'unrated') return r.risk_band
  if (r.detectedTokens.length === 0) return 'unrated'
  // 토큰 탐지됨 + 해외 소싱 → 정지위험, 아니면 주의
  return r.has_overseas_supplier ? 'stop_risk' : 'caution'
}

const BANDS = [
  {
    key: 'stop_risk' as const,
    title: '🛑 정지위험',
    sub: '가품 의심 / 브랜드 토큰 + 해외 도매 동시 충족 — 등록 보류',
    border: 'border-red-300',
    head: 'bg-red-50 text-red-700',
    chip: 'bg-red-100 text-red-700',
  },
  {
    key: 'caution' as const,
    title: '⚠️ 주의',
    sub: '브랜드 언급 있음 — 제네릭 재명명 후 등록 권장',
    border: 'border-amber-300',
    head: 'bg-amber-50 text-amber-700',
    chip: 'bg-amber-100 text-amber-700',
  },
  {
    key: 'safe_generic' as const,
    title: '✅ 안전 제네릭',
    sub: '상표 토큰 미검출 — 위탁 등록 적합',
    border: 'border-emerald-300',
    head: 'bg-emerald-50 text-emerald-700',
    chip: 'bg-emerald-100 text-emerald-700',
  },
]

export default async function IpRiskPage() {
  const { rows } = await fetchBoard()

  const grouped: Record<string, EnrichedRow[]> = {
    stop_risk: [],
    caution: [],
    safe_generic: [],
    unrated: [],
  }
  for (const r of rows) grouped[effectiveBand(r)].push(r)

  // 같은 category_top 의 안전 제네릭 후보 (위험 상품 대체 추천용)
  const safeByCategory = new Map<string, EnrichedRow[]>()
  for (const r of grouped.safe_generic) {
    const list = safeByCategory.get(r.category_top) ?? []
    if (list.length < 5) list.push(r)
    safeByCategory.set(r.category_top, list)
  }

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold">가품·상표권 리스크 게이트</h1>
          <p className="text-sm text-gray-500 mt-1">
            위탁 계정정지 1순위(가품·상표권)를 발굴 단계에서 차단. 라벨 = classify-trends-llm,
            해외 도매(1688·알리·타오바오) 소싱과 결합 시 정지위험으로 승급.
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      {/* 요약 카운트 */}
      <section className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <CountCard label="🛑 정지위험" value={grouped.stop_risk.length} tone="text-red-600" />
        <CountCard label="⚠️ 주의" value={grouped.caution.length} tone="text-amber-600" />
        <CountCard label="✅ 안전 제네릭" value={grouped.safe_generic.length} tone="text-emerald-600" />
        <CountCard label="· 미분류" value={grouped.unrated.length} tone="text-gray-400" />
      </section>

      {rows.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500">
          아직 데이터 없음. cron 누적 + IP 분류(classify-trends-llm) 후 다시 방문.
        </div>
      ) : (
        BANDS.map((band) => (
          <BandTable
            key={band.key}
            band={band}
            rows={grouped[band.key]}
            safeByCategory={band.key !== 'safe_generic' ? safeByCategory : undefined}
          />
        ))
      )}

      {grouped.unrated.length > 0 && (
        <section className="text-xs text-gray-400">
          미분류 {grouped.unrated.length}건 — classify-trends-llm 의 IP 라벨 백필 대기 중
          (룰 기반 토큰 미검출 상품).
        </section>
      )}
    </div>
  )
}

function CountCard({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <div className="rounded border border-gray-200 p-3 text-center">
      <div className="text-xs text-gray-500">{label}</div>
      <div className={`mt-1 text-3xl font-bold ${tone}`}>{value}</div>
    </div>
  )
}

function BandTable({
  band,
  rows,
  safeByCategory,
}: {
  band: (typeof BANDS)[number]
  rows: EnrichedRow[]
  safeByCategory?: Map<string, EnrichedRow[]>
}) {
  if (rows.length === 0) return null
  return (
    <section className={`rounded border ${band.border} overflow-hidden`}>
      <div className={`px-4 py-2 ${band.head}`}>
        <div className="font-semibold">
          {band.title} <span className="font-normal opacity-70">· {rows.length}건</span>
        </div>
        <div className="text-xs opacity-80">{band.sub}</div>
      </div>
      <div className="divide-y divide-gray-100">
        {rows.map((r) => {
          const alts = safeByCategory?.get(r.category_top)?.filter((a) => a.id !== r.id).slice(0, 3) ?? []
          return (
            <div key={r.id} className="px-4 py-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <Link
                    href={`/admin/trend-radar/products/${r.id}`}
                    className="font-medium hover:underline"
                  >
                    {r.canonical_name}
                  </Link>
                  <div className="text-xs text-gray-500 mt-0.5">
                    {r.category_top}
                    {r.category_mid ? ` / ${r.category_mid}` : ''}
                    {r.brand ? ` · 브랜드: ${r.brand}` : ''}
                    {r.has_overseas_supplier && (
                      <span className="ml-1 text-red-600 font-medium">· 해외도매</span>
                    )}
                    {r.supplier_sources?.length ? (
                      <span className="ml-1 text-gray-400">({r.supplier_sources.join(', ')})</span>
                    ) : null}
                  </div>
                </div>
                <div className="text-right shrink-0">
                  {r.ip_risk_label && (
                    <span className={`text-xs px-2 py-0.5 rounded ${band.chip} font-medium`}>
                      {r.ip_risk_label}
                    </span>
                  )}
                  {typeof r.ip_risk_score === 'number' && (
                    <div className="text-xs font-mono text-gray-500 mt-1">risk {r.ip_risk_score}</div>
                  )}
                </div>
              </div>

              {/* 근거: 탐지 토큰 칩 */}
              {(r.detectedTokens.length > 0 || (r.ip_risk_tokens?.length ?? 0) > 0) && (
                <div className="mt-2 flex flex-wrap gap-1">
                  {(r.ip_risk_tokens ?? []).map((t, i) => (
                    <span
                      key={`llm-${i}`}
                      className="text-[11px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-700 font-mono"
                      title={`LLM 탐지${t.source ? ` · ${t.source}` : ''}`}
                    >
                      🏷 {t.token}
                    </span>
                  ))}
                  {r.detectedTokens.map((t, i) => (
                    <span
                      key={`rule-${i}`}
                      className="text-[11px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-600 font-mono"
                      title={`룰 탐지 · ${t.kind}`}
                    >
                      {t.token}
                    </span>
                  ))}
                </div>
              )}

              {r.ip_risk_reasons && (
                <div className="mt-1 text-xs text-gray-600">사유: {r.ip_risk_reasons}</div>
              )}

              {/* 안전 제네릭 대체 추천 (같은 카테고리) */}
              {alts.length > 0 && (
                <div className="mt-2 text-xs text-emerald-700">
                  ✅ 안전 대체 후보:{' '}
                  {alts.map((a, i) => (
                    <span key={a.id}>
                      {i > 0 ? ', ' : ''}
                      <Link href={`/admin/trend-radar/products/${a.id}`} className="hover:underline">
                        {a.canonical_name}
                      </Link>
                    </span>
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </section>
  )
}
