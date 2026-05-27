import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

interface OverlapRow {
  listing_id: string
  competing_listing_id: string
  shared_keyword: string
  listing_rank: number | null
  competing_rank: number | null
  rank_gap: number | null
  estimated_share_loss: number
  detection_method: string
  computed_at: string
}

interface ListingMeta {
  id: string
  registered_title: string
  product_id: number | null
  status: string
}

interface RiskRow {
  listing_id: string
  overlapping_keywords: number
  competing_sku_count: number
  avg_share_loss: number
  risk_score: number
  last_computed_at: string
}

interface PinCandidate {
  id: string
  canonical_name: string
  category_top: string
}

async function fetchData() {
  const sb = createAdminClient() as unknown as {
    from: (t: string) => ReturnType<ReturnType<typeof createAdminClient>['from']>
  }

  const [overlapRes, listingsRes, riskRes, pinsRes] = await Promise.all([
    sb
      .from('jimscanner_self_cannibal_overlap')
      .select('*')
      .order('estimated_share_loss', { ascending: false })
      .limit(500),
    sb
      .from('jimscanner_coupang_listings')
      .select('id, registered_title, product_id, status')
      .in('status', ['SELLING', 'APPROVED', 'PENDING_APPROVAL']),
    sb.from('jimscanner_self_cannibal_risk').select('*').order('risk_score', { ascending: false }).limit(100),
    sb
      .from('jimscanner_trends_products')
      .select('id, canonical_name, category_top')
      .order('last_seen_at', { ascending: false })
      .limit(40),
  ])

  return {
    overlaps: (overlapRes.data ?? []) as unknown as OverlapRow[],
    listings: (listingsRes.data ?? []) as unknown as ListingMeta[],
    risks: (riskRes.data ?? []) as unknown as RiskRow[],
    pins: (pinsRes.data ?? []) as unknown as PinCandidate[],
    overlapErr: overlapRes.error?.message ?? null,
  }
}

const STOPWORDS = new Set([
  '정', '포', '개', '캡슐', '환', '병', '구', '팩', '박스',
  'mg', 'kg', 'g', 'ml', 'l',
  '대용량', '소용량', '국내산', '수입산',
  '무료배송', '쿠팡', '특가', '할인', '세일',
])

function extractKeywordsFromTitle(title: string): string[] {
  if (!title) return []
  const cleaned = title
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .toLowerCase()
  const tokens = cleaned
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t) && !/^\d+$/.test(t))
  const out = new Set<string>()
  for (const t of tokens) out.add(t)
  for (let i = 0; i < tokens.length - 1; i++) out.add(`${tokens[i]} ${tokens[i + 1]}`)
  return [...out]
}

function riskColor(score: number) {
  if (score >= 70) return 'bg-rose-100 text-rose-800 border-rose-300'
  if (score >= 40) return 'bg-amber-100 text-amber-800 border-amber-300'
  if (score > 0) return 'bg-yellow-50 text-yellow-700 border-yellow-200'
  return 'bg-green-50 text-green-700 border-green-200'
}

export default async function SelfCannibalPage({
  searchParams,
}: {
  searchParams: Promise<{ pin?: string }>
}) {
  const sp = await searchParams
  const selectedPinId = sp.pin ?? ''
  const data = await fetchData()
  const { overlaps, listings, risks, pins } = data

  const listingMap = new Map<string, ListingMeta>(listings.map((l) => [l.id, l]))

  // SKU × SKU 매트릭스: pair → shared keyword count
  type PairKey = string
  const pairMap = new Map<
    PairKey,
    { a: string; b: string; keywords: string[]; avgLoss: number }
  >()
  for (const o of overlaps) {
    const [a, b] = [o.listing_id, o.competing_listing_id].sort()
    const key = `${a}|${b}`
    const cur = pairMap.get(key)
    if (cur) {
      cur.keywords.push(o.shared_keyword)
      cur.avgLoss = (cur.avgLoss * (cur.keywords.length - 1) + o.estimated_share_loss) / cur.keywords.length
    } else {
      pairMap.set(key, { a, b, keywords: [o.shared_keyword], avgLoss: o.estimated_share_loss })
    }
  }
  const pairs = [...pairMap.values()].sort((x, y) => y.keywords.length - x.keywords.length)

  // 시뮬레이션: 선택된 핀의 canonical_name 으로 키워드 추출 → 기존 SKU 키워드와 교집합
  let simulation: {
    pin: PinCandidate | null
    impactedListings: { listing: ListingMeta; overlap: string[] }[]
    totalKeywords: number
  } = { pin: null, impactedListings: [], totalKeywords: 0 }

  if (selectedPinId) {
    const pin = pins.find((p) => p.id === selectedPinId) ?? null
    if (pin) {
      const pinKws = new Set(extractKeywordsFromTitle(pin.canonical_name))
      const impacted: { listing: ListingMeta; overlap: string[] }[] = []
      for (const l of listings) {
        const lkws = extractKeywordsFromTitle(l.registered_title)
        const inter = lkws.filter((k) => pinKws.has(k))
        if (inter.length > 0) impacted.push({ listing: l, overlap: inter })
      }
      impacted.sort((a, b) => b.overlap.length - a.overlap.length)
      simulation = { pin, impactedListings: impacted.slice(0, 20), totalKeywords: pinKws.size }
    }
  }

  return (
    <div className="space-y-6 p-6">
      <header>
        <h1 className="text-2xl font-bold">자기 발행 SKU 카니발리제이션 게이트</h1>
        <p className="text-sm text-gray-500 mt-1">
          발행한 자기 SKU 들이 동일 쿠팡 SERP 키워드를 두고 잠식하는 정도를 정량화 — 신규 핀 발행 전 시뮬레이션
          가능. 일배치:{' '}
          <code className="bg-gray-100 px-1.5 py-0.5 rounded text-[11px]">scripts/scan-self-cannibal.mjs</code>
        </p>
      </header>

      {data.overlapErr && (
        <div className="rounded border border-rose-300 bg-rose-50 p-3 text-sm text-rose-800">
          오버랩 테이블 조회 실패 — 마이그레이션이 아직 적용되지 않았을 수 있습니다.
          <br />
          <code className="text-[11px]">supabase/self_cannibal_overlap.sql</code> 적용 필요.
          <div className="text-[11px] mt-1">{data.overlapErr}</div>
        </div>
      )}

      {/* 신규 핀 시뮬레이션 */}
      <section className="rounded border border-blue-200 bg-blue-50/50 p-4">
        <h2 className="text-lg font-semibold mb-3">신규 핀 발행 전 잠식 시뮬레이션</h2>
        <form action="/admin/trend-radar/self-cannibal" className="flex flex-wrap gap-2 items-center mb-3">
          <label className="text-sm text-gray-700">발행 후보 핀:</label>
          <select
            name="pin"
            defaultValue={selectedPinId}
            className="px-2 py-1 text-sm border border-gray-300 rounded bg-white"
          >
            <option value="">— 선택 —</option>
            {pins.map((p) => (
              <option key={p.id} value={p.id}>
                [{p.category_top}] {p.canonical_name}
              </option>
            ))}
          </select>
          <button
            type="submit"
            className="px-3 py-1 text-sm bg-blue-600 text-white rounded hover:bg-blue-700"
          >
            시뮬레이션
          </button>
        </form>

        {simulation.pin && (
          <div className="text-sm">
            <div className="mb-2">
              <strong>{simulation.pin.canonical_name}</strong> 발행 시{' '}
              <span className="text-rose-700 font-semibold">{simulation.impactedListings.length}</span>개 기존 SKU 와
              잠식 가능 (추출 키워드 {simulation.totalKeywords}개)
            </div>
            {simulation.impactedListings.length === 0 ? (
              <div className="text-emerald-700 bg-emerald-50 p-3 rounded border border-emerald-200">
                ✓ 잠식 위험 없음 — 발행 진행 가능
              </div>
            ) : (
              <div className="overflow-x-auto bg-white rounded border">
                <table className="w-full text-xs">
                  <thead className="bg-gray-50 text-gray-600">
                    <tr>
                      <th className="px-2 py-1 text-left">기존 SKU</th>
                      <th className="px-2 py-1 text-center">겹치는 키워드</th>
                      <th className="px-2 py-1 text-left">키워드</th>
                    </tr>
                  </thead>
                  <tbody>
                    {simulation.impactedListings.map((it) => (
                      <tr key={it.listing.id} className="border-t">
                        <td className="px-2 py-1 line-clamp-1">{it.listing.registered_title}</td>
                        <td className="px-2 py-1 text-center font-semibold text-rose-700">
                          {it.overlap.length}
                        </td>
                        <td className="px-2 py-1 text-gray-600">{it.overlap.slice(0, 6).join(', ')}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </section>

      {/* SKU 별 risk score */}
      <section>
        <h2 className="text-lg font-semibold mb-3">SKU 별 Cannibalization Risk Score</h2>
        {risks.length === 0 ? (
          <div className="text-sm text-gray-500 p-4 bg-gray-50 rounded border">
            아직 잠식 데이터가 없습니다.{' '}
            <code className="bg-white px-1.5 py-0.5 rounded text-[11px] border">
              node scripts/scan-self-cannibal.mjs
            </code>{' '}
            실행 필요.
          </div>
        ) : (
          <div className="overflow-x-auto bg-white border rounded">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-gray-600 text-xs">
                <tr>
                  <th className="px-3 py-2 text-left font-semibold">SKU</th>
                  <th className="px-3 py-2 text-center font-semibold">Risk Score</th>
                  <th className="px-3 py-2 text-center font-semibold">겹치는 키워드</th>
                  <th className="px-3 py-2 text-center font-semibold">경쟁 SKU 수</th>
                  <th className="px-3 py-2 text-center font-semibold">평균 손실</th>
                </tr>
              </thead>
              <tbody>
                {risks.map((r) => {
                  const l = listingMap.get(r.listing_id)
                  return (
                    <tr key={r.listing_id} className="border-t hover:bg-amber-50/30">
                      <td className="px-3 py-2 text-xs">
                        <div className="line-clamp-2">{l?.registered_title ?? r.listing_id}</div>
                      </td>
                      <td className="px-3 py-2 text-center">
                        <span
                          className={`inline-block px-2 py-0.5 rounded text-xs font-semibold border ${riskColor(
                            r.risk_score,
                          )}`}
                        >
                          {r.risk_score}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-center tabular-nums">{r.overlapping_keywords}</td>
                      <td className="px-3 py-2 text-center tabular-nums">{r.competing_sku_count}</td>
                      <td className="px-3 py-2 text-center tabular-nums">
                        {(r.avg_share_loss * 100).toFixed(0)}%
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* SKU × SKU pair heatmap (top pairs) */}
      <section>
        <h2 className="text-lg font-semibold mb-3">SKU × SKU 잠식 매트릭스 (top {Math.min(pairs.length, 50)}쌍)</h2>
        {pairs.length === 0 ? (
          <div className="text-sm text-gray-500 p-4 bg-gray-50 rounded border">데이터 없음</div>
        ) : (
          <div className="overflow-x-auto bg-white border rounded">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-gray-600 text-xs">
                <tr>
                  <th className="px-3 py-2 text-left font-semibold">SKU A</th>
                  <th className="px-3 py-2 text-left font-semibold">SKU B</th>
                  <th className="px-3 py-2 text-center font-semibold">공유 키워드</th>
                  <th className="px-3 py-2 text-left font-semibold">키워드 샘플</th>
                  <th className="px-3 py-2 text-center font-semibold">평균 손실</th>
                </tr>
              </thead>
              <tbody>
                {pairs.slice(0, 50).map((p) => {
                  const a = listingMap.get(p.a)
                  const b = listingMap.get(p.b)
                  return (
                    <tr key={`${p.a}|${p.b}`} className="border-t">
                      <td className="px-3 py-2 text-xs max-w-[260px]">
                        <div className="line-clamp-2">{a?.registered_title ?? p.a}</div>
                      </td>
                      <td className="px-3 py-2 text-xs max-w-[260px]">
                        <div className="line-clamp-2">{b?.registered_title ?? p.b}</div>
                      </td>
                      <td className="px-3 py-2 text-center font-semibold text-rose-700">{p.keywords.length}</td>
                      <td className="px-3 py-2 text-xs text-gray-600">{p.keywords.slice(0, 5).join(', ')}</td>
                      <td className="px-3 py-2 text-center tabular-nums">
                        {(p.avgLoss * 100).toFixed(0)}%
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <div className="text-xs text-gray-400 pt-2 border-t">
        ← <Link href="/admin/trend-radar" className="hover:underline">트렌드 레이더 대시보드로</Link>
      </div>
    </div>
  )
}
