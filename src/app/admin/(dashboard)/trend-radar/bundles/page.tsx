import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import BundleGraph from './BundleGraph'

export const dynamic = 'force-dynamic'

interface CooccRow {
  a_keyword: string
  b_keyword: string
  source: string
  window_days: number
  joint_count: number
  marginal_a: number
  marginal_b: number
  total_docs: number
  lift: number
  pmi: number | null
  extras: { sample_titles?: string[] } | null
  computed_at: string
}

interface PinHint {
  keyword: string
  pinned: boolean
  classified_intent: string | null
}

interface GgsanHint {
  alias: string
  product_id: string
}

const SOURCE_LABEL: Record<string, string> = {
  all: '전체 통합',
  naver_news: '네이버 뉴스',
  naver_blog: '네이버 블로그',
  quasarzone_sale: '퀘이사존 핫딜',
  naver_search_trend: '검색 트렌드',
}

const SOURCE_OPTIONS = ['all', 'naver_news', 'naver_blog', 'quasarzone_sale', 'naver_search_trend'] as const

const MIN_LIFT_UI = 1.5
const MIN_JOINT_UI = 5
const TOP_N = 80

function actionFor(joint: number, lift: number): { tag: string; tone: 'good' | 'warn' | 'info' } {
  if (lift >= 4 && joint >= 8) return { tag: '세트 광고', tone: 'good' }
  if (lift >= 2.5 && joint >= 6) return { tag: '연관상품 부착', tone: 'good' }
  if (joint >= MIN_JOINT_UI) return { tag: 'combo SKU 후보', tone: 'info' }
  return { tag: '관찰', tone: 'warn' }
}

async function fetchData(source: string) {
  const sb = createAdminClient()

  // 1) 동시검색 쌍
  const { data: rowsRaw } = (await sb
    .from('jimscanner_trends_cooccurrence' as never)
    .select(
      'a_keyword, b_keyword, source, window_days, joint_count, marginal_a, marginal_b, total_docs, lift, pmi, extras, computed_at',
    )
    .eq('source', source)
    .gte('lift', MIN_LIFT_UI)
    .gte('joint_count', MIN_JOINT_UI)
    .order('lift', { ascending: false })
    .order('joint_count', { ascending: false })
    .limit(TOP_N)) as { data: CooccRow[] | null }
  const rows = (rowsRaw ?? []) as CooccRow[]

  // 2) 모든 키워드 수집
  const keywords = new Set<string>()
  for (const r of rows) {
    keywords.add(r.a_keyword)
    keywords.add(r.b_keyword)
  }
  const kwList = Array.from(keywords)

  // 3) 핀 / classified_intent 조회 (latest per keyword)
  const pinByKw = new Map<string, PinHint>()
  if (kwList.length > 0) {
    const { data: pinsRaw } = (await sb
      .from('jimscanner_trends_keywords')
      .select('keyword, pinned, classified_intent, collected_at')
      .in('keyword', kwList)
      .order('collected_at', { ascending: false })
      .limit(5000)) as { data: { keyword: string; pinned: boolean; classified_intent: string | null }[] | null }
    for (const p of pinsRaw ?? []) {
      if (!pinByKw.has(p.keyword)) {
        pinByKw.set(p.keyword, {
          keyword: p.keyword,
          pinned: !!p.pinned,
          classified_intent: p.classified_intent,
        })
      }
    }
  }

  // 4) ggsan alias 매칭 — keyword 가 jimscanner_trends_aliases.alias 에 있으면 매칭.
  const ggsanByKw = new Map<string, GgsanHint>()
  if (kwList.length > 0) {
    const { data: aliasesRaw } = (await sb
      .from('jimscanner_trends_aliases')
      .select('alias, product_id')
      .in('alias', kwList)) as { data: GgsanHint[] | null }
    for (const a of aliasesRaw ?? []) {
      ggsanByKw.set(a.alias, a)
    }
  }

  // KPI
  const kpi = {
    pairs: rows.length,
    keywords: kwList.length,
    bothGgsan: rows.filter((r) => ggsanByKw.has(r.a_keyword) && ggsanByKw.has(r.b_keyword)).length,
    bothPinned: rows.filter((r) => pinByKw.get(r.a_keyword)?.pinned && pinByKw.get(r.b_keyword)?.pinned).length,
    maxLift: rows.length > 0 ? Math.max(...rows.map((r) => r.lift)) : 0,
    lastComputedAt: rows[0]?.computed_at ?? null,
  }

  return { rows, pinByKw, ggsanByKw, kpi }
}

export default async function BundlesPage({
  searchParams,
}: {
  searchParams: Promise<{ source?: string }>
}) {
  const sp = await searchParams
  const source = SOURCE_OPTIONS.includes(sp.source as (typeof SOURCE_OPTIONS)[number])
    ? (sp.source as string)
    : 'all'
  const { rows, pinByKw, ggsanByKw, kpi } = await fetchData(source)

  const graphPairs = rows.slice(0, 40).map((r) => ({
    a: r.a_keyword,
    b: r.b_keyword,
    lift: r.lift,
    joint: r.joint_count,
    aGgsan: ggsanByKw.has(r.a_keyword),
    bGgsan: ggsanByKw.has(r.b_keyword),
  }))

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold">Co-Search Bundle Network</h1>
          <p className="mt-1 text-sm text-gray-500">
            동반검색 묶음판매 발굴 보드 — lift ≥ {MIN_LIFT_UI} & joint ≥ {MIN_JOINT_UI} 인 쌍만 노출 ·
            연관상품/세트 광고 SKU 후보 탐색
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      {/* KPI 카드 */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <KpiCard label="유의 쌍" value={kpi.pairs} hint={`Top ${TOP_N}`} />
        <KpiCard label="키워드 수" value={kpi.keywords} />
        <KpiCard label="둘 다 ggsan 매칭" value={kpi.bothGgsan} hint="즉시 세트 후보" />
        <KpiCard label="둘 다 핀 등록" value={kpi.bothPinned} />
        <KpiCard
          label="최대 lift"
          value={kpi.maxLift > 0 ? kpi.maxLift.toFixed(2) : '—'}
          hint={kpi.lastComputedAt ? new Date(kpi.lastComputedAt).toLocaleString('ko-KR') : '미계산'}
        />
      </div>

      {/* 소스 필터 */}
      <nav className="flex flex-wrap gap-2 text-sm">
        {SOURCE_OPTIONS.map((s) => {
          const active = s === source
          const href =
            s === 'all'
              ? '/admin/trend-radar/bundles'
              : `/admin/trend-radar/bundles?source=${encodeURIComponent(s)}`
          return (
            <Link
              key={s}
              href={href}
              className={`rounded-full border px-3 py-1 ${
                active
                  ? 'border-black bg-black text-white'
                  : 'border-gray-300 bg-white text-gray-700 hover:border-gray-500'
              }`}
            >
              {SOURCE_LABEL[s]}
            </Link>
          )
        })}
      </nav>

      {rows.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500">
          {kpi.lastComputedAt
            ? '필터 조건에 맞는 쌍이 없음. 다른 소스를 선택하거나 cron 누적을 기다리세요.'
            : 'compute-cooccurrence cron 실행 전. scripts/run-crons.mjs compute-cooccurrence 로 첫 빌드.'}
        </div>
      ) : (
        <>
          {/* 그래프 */}
          <section className="rounded border border-gray-200 bg-white p-4">
            <h2 className="mb-3 text-sm font-semibold text-gray-700">
              Force-directed Co-Search Graph (Top 40 쌍)
            </h2>
            <BundleGraph pairs={graphPairs} />
            <p className="mt-2 text-xs text-gray-500">
              녹색 노드 = ggsan 매칭 키워드 · 선 굵기 = lift · 마우스 오버로 상세
            </p>
          </section>

          {/* Top-N 테이블 */}
          <section className="rounded border border-gray-200 bg-white">
            <h2 className="border-b border-gray-200 px-4 py-3 text-sm font-semibold text-gray-700">
              Top-N 동시검색 쌍 · 추천 액션
            </h2>
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead className="bg-gray-50 text-left text-xs text-gray-500">
                  <tr>
                    <th className="px-3 py-2">#</th>
                    <th className="px-3 py-2">키워드 A</th>
                    <th className="px-3 py-2">키워드 B</th>
                    <th className="px-3 py-2 text-right">joint</th>
                    <th className="px-3 py-2 text-right">lift</th>
                    <th className="px-3 py-2 text-right">PMI</th>
                    <th className="px-3 py-2">핀</th>
                    <th className="px-3 py-2">ggsan</th>
                    <th className="px-3 py-2">추천 액션</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {rows.map((r, i) => {
                    const aPin = pinByKw.get(r.a_keyword)
                    const bPin = pinByKw.get(r.b_keyword)
                    const aGg = ggsanByKw.get(r.a_keyword)
                    const bGg = ggsanByKw.get(r.b_keyword)
                    const action = actionFor(r.joint_count, r.lift)
                    return (
                      <tr key={`${r.a_keyword}::${r.b_keyword}`} className="hover:bg-gray-50">
                        <td className="px-3 py-2 text-xs text-gray-400">{i + 1}</td>
                        <td className="px-3 py-2 font-medium text-gray-900">
                          {r.a_keyword}
                          <div className="text-xs text-gray-400">{r.marginal_a}회</div>
                        </td>
                        <td className="px-3 py-2 font-medium text-gray-900">
                          {r.b_keyword}
                          <div className="text-xs text-gray-400">{r.marginal_b}회</div>
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">{r.joint_count}</td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          <span className={r.lift >= 3 ? 'font-bold text-emerald-600' : ''}>{r.lift.toFixed(2)}</span>
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums text-gray-500">
                          {r.pmi == null ? '—' : r.pmi.toFixed(2)}
                        </td>
                        <td className="px-3 py-2 text-xs">
                          <span className={aPin?.pinned ? 'text-emerald-600' : 'text-gray-300'}>●</span>
                          <span className={bPin?.pinned ? 'text-emerald-600' : 'text-gray-300'}>●</span>
                        </td>
                        <td className="px-3 py-2 text-xs">
                          <span className={aGg ? 'text-blue-600' : 'text-gray-300'}>●</span>
                          <span className={bGg ? 'text-blue-600' : 'text-gray-300'}>●</span>
                        </td>
                        <td className="px-3 py-2">
                          <span
                            className={`rounded px-2 py-0.5 text-xs font-medium ${
                              action.tone === 'good'
                                ? 'bg-emerald-50 text-emerald-700'
                                : action.tone === 'info'
                                  ? 'bg-blue-50 text-blue-700'
                                  : 'bg-amber-50 text-amber-700'
                            }`}
                          >
                            {action.tag}
                          </span>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </div>
  )
}

function KpiCard({ label, value, hint }: { label: string; value: string | number; hint?: string }) {
  return (
    <div className="rounded border border-gray-200 bg-white p-3">
      <div className="text-xs text-gray-500">{label}</div>
      <div className="mt-1 text-xl font-semibold tabular-nums text-gray-900">{value}</div>
      {hint && <div className="mt-1 text-xs text-gray-400">{hint}</div>}
    </div>
  )
}
