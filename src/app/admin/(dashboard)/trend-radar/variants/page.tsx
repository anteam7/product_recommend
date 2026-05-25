import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

interface VariantRow {
  keyword: string
  axis: string
  value: string
  listing_count: number
  avg_rank: number | null
  review_sum: number | null
  price_p50: number | null
  price_p10: number | null
  price_p90: number | null
  density_z: number | null
  captured_at: string
}

interface GgsanCandidate {
  goods_no: string
  title: string
  price_krw: number | null
  detail_url: string | null
  image_url: string | null
}

const AXIS_LABEL: Record<string, string> = {
  capacity: '용량',
  pack: '팩수',
  size: '사이즈',
  flavor: '맛·향',
  color: '색상',
  age: '연령',
  gender: '성별',
}

const AXIS_ORDER = ['capacity', 'pack', 'size', 'flavor', 'color', 'age', 'gender']

async function fetchLatestVariants(keyword: string | null): Promise<VariantRow[]> {
  const sb = createAdminClient()
  // 최신 captured_at 만 (keyword, axis, value)
  // RPC 없이 client-side에서 latest 추리기
  // 타입 생성 전 — as any 캐스팅
  const sbAny = sb as unknown as {
    from: (t: string) => {
      select: (s: string) => {
        order: (
          c: string,
          o: { ascending: boolean },
        ) => {
          limit: (n: number) => Promise<{ data: VariantRow[] | null; error: { message: string } | null }>
          eq: (c: string, v: string) => {
            order: (c: string, o: { ascending: boolean }) => {
              limit: (n: number) => Promise<{ data: VariantRow[] | null; error: { message: string } | null }>
            }
          }
        }
      }
    }
  }
  const q = sbAny.from('jimscanner_serp_variants').select(
    'keyword, axis, value, listing_count, avg_rank, review_sum, price_p50, price_p10, price_p90, density_z, captured_at',
  )
  const { data, error } = keyword
    ? await q.order('captured_at', { ascending: false }).eq('keyword', keyword).order('captured_at', { ascending: false }).limit(2000)
    : await q.order('captured_at', { ascending: false }).limit(4000)
  if (error) return []
  if (!data) return []

  // latest per (keyword, axis, value)
  const seen = new Set<string>()
  const latest: VariantRow[] = []
  for (const r of data) {
    const k = `${r.keyword}::${r.axis}::${r.value}`
    if (seen.has(k)) continue
    seen.add(k)
    latest.push(r)
  }
  return latest
}

async function fetchGgsanMatches(keyword: string, axis: string, value: string): Promise<GgsanCandidate[]> {
  const sb = createAdminClient()
  const sbAny = sb as unknown as {
    from: (t: string) => {
      select: (s: string) => {
        ilike: (
          c: string,
          v: string,
        ) => {
          limit: (n: number) => Promise<{ data: GgsanCandidate[] | null }>
        }
      }
    }
  }
  // ilike on title — value 와 keyword 둘 다 포함
  // 단순화를 위해 value 만 매칭 (keyword는 보통 일반어라 노이즈)
  const { data } = await sbAny
    .from('jimscanner_ggsan_products')
    .select('goods_no, title, price_krw, detail_url, image_url')
    .ilike('title', `%${value}%`)
    .limit(5)
  return data ?? []
}

function deficitScore(z: number | null): number {
  // 음수 z일수록 underserved. -1 미만이면 빨간 핀 후보.
  if (z == null) return 0
  return -z
}

export default async function VariantsPage({
  searchParams,
}: {
  searchParams: Promise<{ kw?: string; axis?: string; v?: string }>
}) {
  const sp = await searchParams
  const selectedKw = sp.kw ?? null
  const selectedAxis = sp.axis ?? null
  const selectedValue = sp.v ?? null

  const rows = await fetchLatestVariants(selectedKw)

  // 키워드 리스트 + 그룹화
  const keywords = Array.from(new Set(rows.map((r) => r.keyword))).sort()

  // 키워드별 → 축별 → value 리스트
  const byKwAxis: Record<string, Record<string, VariantRow[]>> = {}
  for (const r of rows) {
    if (!byKwAxis[r.keyword]) byKwAxis[r.keyword] = {}
    if (!byKwAxis[r.keyword][r.axis]) byKwAxis[r.keyword][r.axis] = []
    byKwAxis[r.keyword][r.axis].push(r)
  }
  for (const kw of Object.keys(byKwAxis)) {
    for (const ax of Object.keys(byKwAxis[kw])) {
      byKwAxis[kw][ax].sort((a, b) => b.listing_count - a.listing_count)
    }
  }

  // Whitespace 후보: density_z < -0.5 인 셀
  const whitespace = rows
    .filter((r) => r.density_z != null && r.density_z < -0.5)
    .sort((a, b) => (a.density_z ?? 0) - (b.density_z ?? 0))
    .slice(0, 30)

  // 선택된 셀의 ggsan 후보
  let ggsanCandidates: GgsanCandidate[] = []
  if (selectedKw && selectedAxis && selectedValue) {
    ggsanCandidates = await fetchGgsanMatches(selectedKw, selectedAxis, selectedValue)
  }

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold">🎯 SERP 변형 화이트스페이스</h1>
          <p className="text-sm text-gray-500 mt-1">
            키워드 × 변형 축(용량/팩수/사이즈/맛·향/색상/연령/성별) 매트릭스. underserved 셀 → ggsan SKU 매칭.
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      {/* V0 한계 */}
      <div className="rounded border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-900">
        <strong>V0 한계</strong> · raw SERP HTML 수집기는 별도 cron 필요. <code className="font-mono">scripts/extract-serp-variants.mjs</code>
        가 raw payload 없으면 ggsan 카탈로그 title 을 검증용 소스로 사용. density_z 는 (keyword, axis) 내 listing_count 분포의 z-score.
      </div>

      {/* 키워드 필터 */}
      {keywords.length > 0 && (
        <div className="rounded border border-gray-200 px-4 py-3">
          <div className="flex flex-wrap gap-1 items-center">
            <span className="text-xs text-gray-500 mr-2">키워드</span>
            <Link
              href="/admin/trend-radar/variants"
              className={`px-2 py-1 text-xs rounded ${
                !selectedKw ? 'bg-black text-white font-semibold' : 'text-gray-500 hover:text-black'
              }`}
            >
              전체
            </Link>
            {keywords.slice(0, 40).map((kw) => (
              <Link
                key={kw}
                href={`/admin/trend-radar/variants?kw=${encodeURIComponent(kw)}`}
                className={`px-2 py-1 text-xs rounded ${
                  selectedKw === kw ? 'bg-black text-white font-semibold' : 'text-gray-500 hover:text-black'
                }`}
              >
                {kw}
              </Link>
            ))}
          </div>
        </div>
      )}

      {rows.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500 space-y-2">
          <div className="text-base font-medium">아직 변형 데이터가 없음</div>
          <div className="text-xs text-gray-400">
            <code className="font-mono">node --env-file=.env.local scripts/extract-serp-variants.mjs</code> 실행 후 다시 방문.
          </div>
        </div>
      ) : (
        <>
          {/* Whitespace 후보 */}
          {whitespace.length > 0 && (
            <section className="space-y-2">
              <h2 className="text-sm font-semibold text-gray-700">
                🔥 Whitespace 후보 (density_z &lt; -0.5)
              </h2>
              <div className="overflow-x-auto">
                <table className="w-full text-xs border border-gray-200">
                  <thead className="bg-gray-50 text-gray-600">
                    <tr>
                      <th className="px-2 py-1.5 text-left">키워드</th>
                      <th className="px-2 py-1.5 text-left">축</th>
                      <th className="px-2 py-1.5 text-left">값</th>
                      <th className="px-2 py-1.5 text-right">리스팅</th>
                      <th className="px-2 py-1.5 text-right">avg_rank</th>
                      <th className="px-2 py-1.5 text-right">리뷰합</th>
                      <th className="px-2 py-1.5 text-right">가격 p50</th>
                      <th className="px-2 py-1.5 text-right">density_z</th>
                      <th className="px-2 py-1.5 text-right">ggsan</th>
                    </tr>
                  </thead>
                  <tbody>
                    {whitespace.map((r) => (
                      <tr key={`${r.keyword}-${r.axis}-${r.value}`} className="border-t border-gray-100 hover:bg-amber-50">
                        <td className="px-2 py-1.5 font-medium">{r.keyword}</td>
                        <td className="px-2 py-1.5 text-gray-600">{AXIS_LABEL[r.axis] ?? r.axis}</td>
                        <td className="px-2 py-1.5 font-mono">{r.value}</td>
                        <td className="px-2 py-1.5 text-right">{r.listing_count}</td>
                        <td className="px-2 py-1.5 text-right">{r.avg_rank?.toFixed(1) ?? '-'}</td>
                        <td className="px-2 py-1.5 text-right">{r.review_sum?.toLocaleString() ?? '-'}</td>
                        <td className="px-2 py-1.5 text-right">{r.price_p50 ? `${r.price_p50.toLocaleString()}원` : '-'}</td>
                        <td className="px-2 py-1.5 text-right font-mono text-red-700">{r.density_z?.toFixed(2)}</td>
                        <td className="px-2 py-1.5 text-right">
                          <Link
                            href={`/admin/trend-radar/variants?kw=${encodeURIComponent(r.keyword)}&axis=${r.axis}&v=${encodeURIComponent(r.value)}`}
                            className="text-blue-600 hover:underline"
                          >
                            SKU 찾기
                          </Link>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {/* 매트릭스: 선택된 키워드별 */}
          {selectedKw && byKwAxis[selectedKw] && (
            <section className="space-y-3">
              <h2 className="text-sm font-semibold text-gray-700">
                매트릭스 — {selectedKw}
              </h2>
              <div className="grid gap-3 md:grid-cols-2">
                {AXIS_ORDER.filter((ax) => byKwAxis[selectedKw][ax]).map((ax) => {
                  const cells = byKwAxis[selectedKw][ax]
                  const max = Math.max(...cells.map((c) => c.listing_count), 1)
                  return (
                    <div key={ax} className="rounded border border-gray-200 p-3">
                      <div className="text-xs text-gray-500 mb-2">{AXIS_LABEL[ax] ?? ax}</div>
                      <div className="space-y-1">
                        {cells.map((c) => {
                          const w = Math.round((c.listing_count / max) * 100)
                          const cold = (c.density_z ?? 0) < -0.5
                          return (
                            <Link
                              key={c.value}
                              href={`/admin/trend-radar/variants?kw=${encodeURIComponent(c.keyword)}&axis=${c.axis}&v=${encodeURIComponent(c.value)}`}
                              className="block group"
                            >
                              <div className="flex items-center gap-2 text-xs">
                                <div className="w-20 font-mono truncate" title={c.value}>{c.value}</div>
                                <div className="flex-1 h-4 bg-gray-100 rounded overflow-hidden">
                                  <div
                                    className={`h-full ${cold ? 'bg-red-300' : 'bg-amber-300'} group-hover:opacity-80`}
                                    style={{ width: `${w}%` }}
                                  />
                                </div>
                                <div className="w-10 text-right font-mono">{c.listing_count}</div>
                                <div className={`w-12 text-right font-mono ${cold ? 'text-red-700' : 'text-gray-500'}`}>
                                  {c.density_z?.toFixed(2) ?? '-'}
                                </div>
                              </div>
                            </Link>
                          )
                        })}
                      </div>
                    </div>
                  )
                })}
              </div>
            </section>
          )}

          {/* ggsan 후보 */}
          {selectedKw && selectedAxis && selectedValue && (
            <section className="space-y-3 border-t border-gray-200 pt-4">
              <h2 className="text-sm font-semibold text-gray-700">
                ggsan SKU 후보 — {selectedKw} / {AXIS_LABEL[selectedAxis] ?? selectedAxis} = <span className="font-mono">{selectedValue}</span>
              </h2>
              {ggsanCandidates.length === 0 ? (
                <div className="text-xs text-gray-500">매칭 SKU 없음. <code className="font-mono">{selectedValue}</code> 키워드로 ggsan 재수집 필요.</div>
              ) : (
                <div className="space-y-2">
                  {ggsanCandidates.map((g) => (
                    <a
                      key={g.goods_no}
                      href={g.detail_url ?? '#'}
                      target="_blank"
                      rel="noopener"
                      className="flex items-center gap-3 rounded border border-gray-200 p-2 hover:bg-gray-50"
                    >
                      <div className="w-12 h-12 bg-gray-100 rounded overflow-hidden flex-shrink-0">
                        {g.image_url && (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={g.image_url} alt="" loading="lazy" className="w-full h-full object-cover" />
                        )}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium truncate">{g.title}</div>
                        <div className="text-xs text-gray-500">{g.goods_no}</div>
                      </div>
                      <div className="text-sm font-mono">
                        {g.price_krw ? `${g.price_krw.toLocaleString()}원` : '-'}
                      </div>
                    </a>
                  ))}
                </div>
              )}
            </section>
          )}
        </>
      )}

      <section className="text-xs text-gray-500 border-t border-gray-200 pt-4 space-y-1">
        <div className="font-semibold text-gray-700">📐 deficit 점수</div>
        <code className="block bg-gray-50 px-3 py-2 rounded font-mono text-[11px] leading-relaxed">
          density_z = (listing_count - mean(axis내 listing_count)) / sd(axis내 listing_count)
          <br />
          deficit = -density_z (음수 z 일수록 underserved → 빈 칸 → ggsan SKU 로 즉시 진입 후보)
        </code>
      </section>
    </div>
  )
}

// suppress unused import warning when keywords list is empty path
export { deficitScore as _deficitScore }
