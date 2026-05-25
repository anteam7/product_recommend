import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

interface AspectRow {
  id: string
  category_top: string
  category_mid: string | null
  aspect_tag: string
  aspect_label: string | null
  severity_score: number
  mention_count: number
  product_count: number
  source_product_ids: string[]
  sample_quotes: Array<{ quote: string; source: string; rating: number | null }>
  last_seen_at: string
}

interface GgsanRow {
  goods_no: string
  title: string
  cate_label: string | null
  price_krw: number | null
  detail_url: string | null
  is_imminent: boolean
}

const CATEGORY_LABELS: Record<string, string> = {
  health: '건강·영양',
  living: '생활·뷰티',
  digital: '디지털·가전',
  other: '기타',
}

function severityColor(score: number, max: number): string {
  if (max <= 0) return 'bg-gray-50'
  const ratio = Math.min(1, score / max)
  if (ratio >= 0.85) return 'bg-red-600 text-white'
  if (ratio >= 0.7) return 'bg-red-500 text-white'
  if (ratio >= 0.55) return 'bg-orange-400 text-white'
  if (ratio >= 0.4) return 'bg-amber-300 text-gray-900'
  if (ratio >= 0.25) return 'bg-yellow-200 text-gray-800'
  if (ratio >= 0.1) return 'bg-yellow-100 text-gray-700'
  return 'bg-gray-100 text-gray-600'
}

async function fetchData(selectedCategory: string | null, focusedAspect: string | null) {
  const sb = createAdminClient()

  // 새 테이블이라 generated types 미반영 — as any 캐스팅.
  const sbAny = sb as any

  const { data: aspects } = await sbAny
    .from('jimscanner_trends_review_aspects')
    .select(
      'id, category_top, category_mid, aspect_tag, aspect_label, severity_score, mention_count, product_count, source_product_ids, sample_quotes, last_seen_at',
    )
    .order('severity_score', { ascending: false })
    .limit(500)

  const rows = ((aspects ?? []) as AspectRow[]).map((r) => ({
    ...r,
    source_product_ids: Array.isArray(r.source_product_ids) ? r.source_product_ids : [],
    sample_quotes: Array.isArray(r.sample_quotes) ? r.sample_quotes : [],
  }))

  // top-3 결함 (선택 카테고리 한정) 으로 ggsan SKU 매칭.
  const cat = selectedCategory ?? rows[0]?.category_top ?? 'health'
  const top3 = rows.filter((r) => r.category_top === cat).slice(0, 3)
  const focus = rows.find((r) => r.id === focusedAspect) ?? top3[0] ?? null

  let ggsanMatches: GgsanRow[] = []
  if (focus) {
    // ggsan 도매 카탈로그에서 동일 카테고리 (단순 매칭 — health → 건강 prefix) 상품 fetch.
    // 정교한 (category_top → ggsan cate_cd) 매핑은 후속.
    const { data: ggsan } = await sb
      .from('jimscanner_ggsan_products')
      .select('goods_no, title, cate_label, price_krw, detail_url, is_imminent')
      .order('last_seen_at', { ascending: false })
      .limit(30)
    ggsanMatches = (ggsan ?? []) as GgsanRow[]
  }

  return { rows, selectedCategory: cat, focus, top3, ggsanMatches }
}

export default async function DefectAspectsPage({
  searchParams,
}: {
  searchParams: Promise<{ cat?: string; aspect?: string }>
}) {
  const sp = await searchParams
  const { rows, selectedCategory, focus, top3, ggsanMatches } = await fetchData(
    sp.cat ?? null,
    sp.aspect ?? null,
  )

  // 히트맵 축 구성: 행 = category_top, 열 = 자주 등장하는 aspect_tag (severity 합산 상위 N)
  const categories = Array.from(new Set(rows.map((r) => r.category_top)))
  const aspectAgg = new Map<string, number>()
  for (const r of rows) {
    aspectAgg.set(r.aspect_tag, (aspectAgg.get(r.aspect_tag) ?? 0) + r.severity_score * r.mention_count)
  }
  const topAspects = Array.from(aspectAgg.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 14)
    .map(([t]) => t)

  const cellLookup = new Map<string, AspectRow>()
  for (const r of rows) cellLookup.set(`${r.category_top}::${r.aspect_tag}`, r)
  const maxSeverity = Math.max(0.001, ...rows.map((r) => r.severity_score))

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold">결함 Aspect 보드</h1>
          <p className="text-sm text-gray-500 mt-1">
            카테고리 × 결함 aspect 히트맵. 클릭하면 sample quote 와 ggsan 매칭 후보가 우측에 표시.
            <br />
            데이터 소스: <code className="font-mono text-xs">jimscanner_trends_review_aspects</code> · 갱신:
            cron <code className="font-mono text-xs">scripts/mine-review-aspects.mjs</code>
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      {rows.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500">
          <p className="text-base font-medium">아직 결함 aspect 누적 없음</p>
          <p className="text-sm mt-2">
            로컬에서 <code className="font-mono text-xs">node --env-file=.env.local scripts/mine-review-aspects.mjs</code> 실행 →
            <code className="font-mono text-xs">jimscanner_trends_review_aspects</code> 에 누적되면 자동 표시.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* 좌측 2/3: 히트맵 */}
          <div className="lg:col-span-2 overflow-x-auto rounded border border-gray-200">
            <table className="min-w-full text-xs">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-3 py-2 text-left font-semibold text-gray-700 sticky left-0 bg-gray-50">
                    카테고리 ↓ · 결함 →
                  </th>
                  {topAspects.map((tag) => (
                    <th key={tag} className="px-2 py-2 text-center font-medium text-gray-600 whitespace-nowrap">
                      {tag}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {categories.map((cat) => (
                  <tr key={cat} className="border-t border-gray-100">
                    <td className="px-3 py-2 font-medium text-gray-700 sticky left-0 bg-white">
                      <Link
                        href={`/admin/trend-radar/defect-aspects?cat=${cat}`}
                        className={cat === selectedCategory ? 'underline text-black' : 'hover:underline'}
                      >
                        {CATEGORY_LABELS[cat] ?? cat}
                      </Link>
                    </td>
                    {topAspects.map((tag) => {
                      const cell = cellLookup.get(`${cat}::${tag}`)
                      if (!cell) {
                        return (
                          <td key={tag} className="px-2 py-2 text-center bg-gray-50 text-gray-300">
                            ·
                          </td>
                        )
                      }
                      return (
                        <td
                          key={tag}
                          className={`px-2 py-2 text-center ${severityColor(cell.severity_score, maxSeverity)}`}
                        >
                          <Link
                            href={`/admin/trend-radar/defect-aspects?cat=${cat}&aspect=${cell.id}`}
                            className="block hover:opacity-80"
                          >
                            <div className="font-mono font-semibold">
                              {(cell.severity_score * 100).toFixed(0)}
                            </div>
                            <div className="text-[10px] opacity-80">×{cell.mention_count}</div>
                          </Link>
                        </td>
                      )
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="px-3 py-2 text-[11px] text-gray-500 border-t border-gray-100 bg-gray-50">
              셀 = severity (0~100) · ×N = 누적 부정 리뷰 언급 수 · 색상이 진할수록 차별화 잠재력 큼
            </div>
          </div>

          {/* 우측 1/3: focus + ggsan 매칭 */}
          <aside className="space-y-4">
            <div className="rounded border border-gray-200 p-4">
              <h2 className="text-sm font-semibold text-gray-700">
                {CATEGORY_LABELS[selectedCategory] ?? selectedCategory} · Top 3 결함
              </h2>
              <ol className="mt-2 space-y-1 text-sm">
                {top3.map((r, i) => (
                  <li key={r.id} className="flex items-baseline gap-2">
                    <span className="text-xs text-gray-400 font-mono">{i + 1}.</span>
                    <Link
                      href={`/admin/trend-radar/defect-aspects?cat=${selectedCategory}&aspect=${r.id}`}
                      className={focus?.id === r.id ? 'font-semibold underline' : 'hover:underline'}
                    >
                      {r.aspect_tag}
                    </Link>
                    <span className="text-xs text-gray-500 font-mono">
                      {(r.severity_score * 100).toFixed(0)} · ×{r.mention_count}
                    </span>
                  </li>
                ))}
                {top3.length === 0 && <li className="text-xs text-gray-400">데이터 없음</li>}
              </ol>
            </div>

            {focus && (
              <div className="rounded border border-gray-200 p-4 space-y-3">
                <div>
                  <div className="text-xs uppercase tracking-wider text-gray-500">선택 결함</div>
                  <div className="text-base font-semibold">{focus.aspect_tag}</div>
                  {focus.aspect_label && (
                    <div className="text-xs text-gray-600 mt-1">{focus.aspect_label}</div>
                  )}
                  <div className="text-xs text-gray-500 font-mono mt-1">
                    severity {(focus.severity_score * 100).toFixed(0)} · 언급 {focus.mention_count} ·
                    {focus.product_count}개 상품
                  </div>
                </div>

                {focus.sample_quotes.length > 0 && (
                  <div>
                    <div className="text-xs uppercase tracking-wider text-gray-500">대표 리뷰</div>
                    <ul className="mt-1 space-y-2 text-xs">
                      {focus.sample_quotes.slice(0, 3).map((q, i) => (
                        <li key={i} className="border-l-2 border-red-300 pl-2 text-gray-700">
                          <div>"{q.quote}"</div>
                          <div className="text-[10px] text-gray-400 mt-0.5">
                            {q.source} · ★{q.rating ?? '?'}
                          </div>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                <div>
                  <div className="text-xs uppercase tracking-wider text-gray-500">
                    이 결함을 해소할 ggsan SKU 후보 (top 5)
                  </div>
                  <ul className="mt-1 space-y-1 text-xs">
                    {ggsanMatches.slice(0, 5).map((g) => (
                      <li key={g.goods_no} className="flex items-baseline justify-between gap-2">
                        <a
                          href={g.detail_url ?? '#'}
                          target="_blank"
                          rel="noreferrer"
                          className="truncate hover:underline"
                          title={g.title}
                        >
                          {g.title}
                        </a>
                        <span className="text-[11px] text-gray-500 font-mono whitespace-nowrap">
                          {g.price_krw?.toLocaleString() ?? '-'}원
                        </span>
                      </li>
                    ))}
                    {ggsanMatches.length === 0 && (
                      <li className="text-gray-400">매칭 후보 없음 — ggsan 카탈로그 동기화 필요</li>
                    )}
                  </ul>
                  <div className="mt-2 text-[11px] text-gray-500">
                    매칭 규칙은 v1 (카테고리 광역). 차별화 액션 (예: 리유저블 캡 동봉) 은
                    핀 등록 시 <code className="font-mono">differentiation_aspects</code> 컬럼에 저장.
                  </div>
                </div>
              </div>
            )}
          </aside>
        </div>
      )}
    </div>
  )
}
