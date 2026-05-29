import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import ConcentrationScatter, { type CellRow } from './ConcentrationScatter'

export const dynamic = 'force-dynamic'

interface KeywordRow {
  keyword: string
  volume_relative: number | null
  collected_at: string
}

interface GgsanHit {
  goods_no: string
  title: string
  price_krw: number | null
  cate_label: string | null
  detail_url: string | null
  is_imminent: boolean
}

async function fetchCells(): Promise<CellRow[]> {
  const sb = createAdminClient()
  // 뷰는 generated types 에 없으므로 as any 캐스팅 (마이그레이션 후 상태 가정)
  const { data } = await (sb as any)
    .from('jimscanner_trends_category_concentration')
    .select(
      'category_top, keyword_count, total_volume, hhi, effective_keywords, top1_share_pct, top3_share_pct, hhi_delta, demand_momentum',
    )
  return ((data ?? []) as any[]).map((r) => ({
    category_top: r.category_top,
    keyword_count: Number(r.keyword_count),
    total_volume: Number(r.total_volume),
    hhi: Number(r.hhi),
    effective_keywords: Number(r.effective_keywords),
    top1_share_pct: Number(r.top1_share_pct),
    top3_share_pct: Number(r.top3_share_pct),
    hhi_delta: r.hhi_delta == null ? null : Number(r.hhi_delta),
    demand_momentum: r.demand_momentum == null ? null : Number(r.demand_momentum),
  }))
}

// 드릴다운: 선택 카테고리의 롱테일 키워드(낮은 volume) × ggsan 재고 교차
async function fetchDrilldown(category: string) {
  const sb = createAdminClient()
  const since = new Date(Date.now() - 30 * 86400_000).toISOString()

  const { data } = await sb
    .from('jimscanner_trends_keywords')
    .select('keyword, volume_relative, collected_at')
    .eq('category_top', category)
    .gte('collected_at', since)
    .not('volume_relative', 'is', null)
    .order('collected_at', { ascending: false })
    .limit(2000)

  // (keyword) 별 최신 1건만 → volume 오름차순(롱테일)
  const seen = new Set<string>()
  const latest: KeywordRow[] = []
  for (const k of (data ?? []) as KeywordRow[]) {
    if (seen.has(k.keyword)) continue
    seen.add(k.keyword)
    latest.push(k)
  }
  const longtail = latest
    .filter((k) => (k.volume_relative ?? 0) > 0)
    .sort((a, b) => (a.volume_relative ?? 0) - (b.volume_relative ?? 0))
    .slice(0, 15)

  // 각 롱테일 키워드를 ggsan 상품명에서 검색해 소싱 가능 후보 노출
  const hits = await Promise.all(
    longtail.map(async (k) => {
      const { data: g } = await sb
        .from('jimscanner_ggsan_products')
        .select('goods_no, title, price_krw, cate_label, detail_url, is_imminent')
        .ilike('title', `%${k.keyword}%`)
        .limit(3)
      return { keyword: k, ggsan: (g ?? []) as GgsanHit[] }
    }),
  )
  return hits
}

export default async function ConcentrationPage({
  searchParams,
}: {
  searchParams: Promise<{ cat?: string }>
}) {
  const sp = await searchParams
  const selected = sp.cat ?? ''

  const [cells, drill] = await Promise.all([
    fetchCells(),
    selected ? fetchDrilldown(selected) : Promise.resolve(null),
  ])

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-2xl font-bold">카테고리 진입난이도 지도</h1>
          <p className="text-sm text-gray-500 mt-1">
            수요 집중도(HHI)로 측정한 카테고리 <strong>구조</strong> · 상품이 아닌 분포 형태 ·
            저집중 × 성장 = 1인 위탁 셀러 사냥터
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      {cells.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500">
          아직 집중도 표본 부족. category_top 가 채워진 키워드가 30일 누적되면 표시됩니다.
        </div>
      ) : (
        <>
          <ConcentrationScatter rows={cells} />

          {/* 전체 표 */}
          <section className="rounded border border-gray-200 p-4">
            <h2 className="text-sm font-semibold mb-3 text-gray-700">전체 카테고리 집중도</h2>
            <div className="grid grid-cols-12 text-xs text-gray-500 px-2 py-1">
              <div className="col-span-3">카테고리</div>
              <div className="col-span-1 text-right">키워드</div>
              <div className="col-span-2 text-right">총수요</div>
              <div className="col-span-1 text-right">HHI</div>
              <div className="col-span-1 text-right">유효</div>
              <div className="col-span-1 text-right">top1%</div>
              <div className="col-span-1 text-right">top3%</div>
              <div className="col-span-1 text-right">HHIΔ</div>
              <div className="col-span-1 text-right">모멘텀</div>
            </div>
            {cells.map((r) => {
              const trend =
                r.hhi_delta == null ? '' : r.hhi_delta > 0.005 ? '↑집중강화' : r.hhi_delta < -0.005 ? '↓파편화' : '→유지'
              return (
                <Link
                  key={r.category_top}
                  href={`/admin/trend-radar/concentration?cat=${encodeURIComponent(r.category_top)}`}
                  className={`grid grid-cols-12 px-2 py-1.5 text-sm rounded hover:bg-gray-50 ${
                    selected === r.category_top ? 'bg-amber-50' : ''
                  }`}
                >
                  <div className="col-span-3 font-medium truncate">{r.category_top}</div>
                  <div className="col-span-1 text-right font-mono text-gray-600">{r.keyword_count}</div>
                  <div className="col-span-2 text-right font-mono text-gray-600">{r.total_volume.toLocaleString()}</div>
                  <div className="col-span-1 text-right font-mono font-bold">{r.hhi.toFixed(3)}</div>
                  <div className="col-span-1 text-right font-mono text-gray-600">{r.effective_keywords.toFixed(1)}</div>
                  <div className="col-span-1 text-right font-mono text-gray-600">{r.top1_share_pct}</div>
                  <div className="col-span-1 text-right font-mono text-gray-600">{r.top3_share_pct}</div>
                  <div className="col-span-1 text-right text-xs text-gray-500">
                    {r.hhi_delta != null ? r.hhi_delta.toFixed(3) : '–'}
                  </div>
                  <div
                    className={`col-span-1 text-right text-xs font-medium ${
                      r.demand_momentum != null && r.demand_momentum > 0 ? 'text-emerald-600' : 'text-gray-400'
                    }`}
                  >
                    {r.demand_momentum != null ? `${(r.demand_momentum * 100).toFixed(0)}%` : '–'}
                    <span className="block text-[10px] text-gray-400 font-normal">{trend}</span>
                  </div>
                </Link>
              )
            })}
          </section>

          {/* 드릴다운: 롱테일 × ggsan 소싱 후보 */}
          {selected && drill && (
            <section className="rounded border border-amber-200 bg-amber-50/40 p-4">
              <div className="flex items-baseline justify-between mb-3">
                <h2 className="text-sm font-semibold text-gray-700">
                  🛒 <strong>{selected}</strong> 롱테일 키워드 × ggsan 소싱 후보{' '}
                  <span className="text-xs font-normal text-gray-500 ml-1">(저점유 키워드 = 저경쟁 틈새)</span>
                </h2>
                <Link
                  href="/admin/trend-radar/concentration"
                  className="text-xs text-gray-600 hover:text-black underline"
                >
                  드릴다운 닫기
                </Link>
              </div>
              <div className="space-y-2">
                {drill.map(({ keyword, ggsan }) => (
                  <div key={keyword.keyword} className="rounded border border-gray-200 bg-white px-3 py-2">
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-medium">{keyword.keyword}</span>
                      <span className="text-xs text-gray-400 font-mono">vol {keyword.volume_relative}</span>
                    </div>
                    {ggsan.length === 0 ? (
                      <div className="text-xs text-gray-400 mt-1">ggsan 도매 매칭 없음 · 다른 도매처 탐색 필요</div>
                    ) : (
                      <div className="mt-1.5 flex flex-wrap gap-2">
                        {ggsan.map((g) => (
                          <a
                            key={g.goods_no}
                            href={g.detail_url ?? '#'}
                            target="_blank"
                            rel="noopener"
                            className="text-xs rounded border border-emerald-200 bg-emerald-50 px-2 py-1 hover:bg-emerald-100"
                          >
                            {g.is_imminent && <span className="text-red-600 mr-1">⚡</span>}
                            {g.title.length > 28 ? g.title.slice(0, 28) + '…' : g.title}
                            {g.price_krw ? <span className="text-gray-500 ml-1">{g.price_krw.toLocaleString()}원</span> : null}
                          </a>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
                {drill.length === 0 && (
                  <div className="text-sm text-gray-400">롱테일 키워드 표본 없음.</div>
                )}
              </div>
            </section>
          )}
        </>
      )}
    </div>
  )
}
