import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import { computeAlphaRanking, type AlphaRow } from '@/lib/trend-radar/alpha'

export const dynamic = 'force-dynamic'

const CATEGORIES = ['all', 'health', 'living', 'digital'] as const
type Category = (typeof CATEGORIES)[number]
const CATEGORY_LABEL: Record<Category, string> = {
  all: '전체',
  health: '건강식품',
  living: '생활/리빙',
  digital: '디지털/가전',
}
const WINDOWS = [7, 14, 30] as const

export default async function AlphaBoardPage({
  searchParams,
}: {
  searchParams: Promise<{ cat?: string; days?: string }>
}) {
  const sp = await searchParams
  const category = (CATEGORIES.includes(sp.cat as Category) ? sp.cat : 'all') as Category
  const days = WINDOWS.includes(Number(sp.days) as (typeof WINDOWS)[number])
    ? Number(sp.days)
    : 7

  const sb = createAdminClient()
  const { rows, categories } = await computeAlphaRanking(sb, { days, category })

  const alphaCount = rows.filter((r) => r.label === 'alpha').length
  const betaCount = rows.filter((r) => r.label === 'beta').length
  // 막대 스케일 정규화용 최대 진폭
  const maxAmp = Math.max(
    1,
    ...rows.map((r) => Math.abs(r.beta) + Math.abs(r.alpha)),
  )

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between flex-wrap gap-2">
        <div>
          <Link href="/admin/trend-radar" className="text-sm text-gray-500 hover:text-black">
            ← 대시보드
          </Link>
          <h1 className="text-2xl font-bold mt-1">고유알파 분해 보드</h1>
          <p className="text-sm text-gray-500 mt-1">
            카테고리 공통 추세(<b>베타</b>)를 빼낸 <b>단독 상승(알파)</b> 내림차순 · 최근 {days}일
            <br />
            <span className="text-gray-400">
              총상승 = 베타(시장 동조) + 알파(잔차). 카테고리 거품에 묻혀 같이 뜬 제품이 아니라, 제
              카테고리보다 빠르게 단독으로 뜬 제품만 좁혀줍니다.
            </span>
          </p>
        </div>
      </header>

      {/* KPI */}
      <section className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Kpi label="분해 대상" value={rows.length} hint={`${days}일 내 2일+ 데이터`} />
        <Kpi label="고유 상승(알파)" value={alphaCount} hint="단독으로 뜬 후보" tone="green" />
        <Kpi label="베타 의존" value={betaCount} hint="카테고리 동조" tone="amber" />
        <Kpi label="카테고리 인덱스" value={Object.keys(categories).length} hint="공통추세 산출" />
      </section>

      {/* 카테고리 인덱스 (베타) 요약 */}
      <section className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {Object.values(categories)
          .sort((a, b) => b.beta - a.beta)
          .map((c) => (
            <div key={c.category} className="rounded border border-gray-200 p-3">
              <div className="text-xs text-gray-500">{c.category} 인덱스 (베타)</div>
              <div
                className={`text-2xl font-bold mt-1 ${
                  c.beta > 0 ? 'text-amber-600' : c.beta < 0 ? 'text-blue-600' : 'text-gray-700'
                }`}
              >
                {c.beta > 0 ? '+' : ''}
                {c.beta}
              </div>
              <div className="text-xs text-gray-400 mt-1">{c.memberCount}개 제품 중앙값</div>
            </div>
          ))}
      </section>

      {/* 필터 */}
      <div className="flex flex-wrap items-center gap-4">
        <nav className="flex gap-2 border-b border-gray-200">
          {CATEGORIES.map((c) => (
            <Link
              key={c}
              href={`/admin/trend-radar/alpha?cat=${c}&days=${days}`}
              className={`px-3 py-2 text-sm ${
                category === c
                  ? 'border-b-2 border-black font-semibold text-black'
                  : 'text-gray-500 hover:text-black'
              }`}
            >
              {CATEGORY_LABEL[c]}
            </Link>
          ))}
        </nav>
        <nav className="flex gap-2">
          {WINDOWS.map((w) => (
            <Link
              key={w}
              href={`/admin/trend-radar/alpha?cat=${category}&days=${w}`}
              className={`px-2 py-1 text-xs rounded border ${
                days === w
                  ? 'border-black bg-black text-white'
                  : 'border-gray-300 text-gray-600 hover:bg-gray-50'
              }`}
            >
              {w}일
            </Link>
          ))}
        </nav>
      </div>

      {/* 랭킹 */}
      <section>
        {rows.length === 0 ? (
          <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500">
            <p className="text-base font-medium">분해할 시계열이 부족합니다</p>
            <p className="text-sm mt-2">
              최근 {days}일 안에 2일 이상 점수가 쌓인 제품이 필요합니다. 매일 recompute 누적 후 다시
              확인하세요.
            </p>
          </div>
        ) : (
          <div className="grid gap-2">
            <div className="grid grid-cols-12 text-xs text-gray-500 px-3 py-1">
              <div className="col-span-1">#</div>
              <div className="col-span-4">상품명</div>
              <div className="col-span-1 text-right">알파</div>
              <div className="col-span-1 text-right">베타</div>
              <div className="col-span-1 text-right">총상승</div>
              <div className="col-span-4">분해 (베타 ▸ 알파)</div>
            </div>
            {rows.slice(0, 80).map((r, i) => (
              <Link
                key={r.id}
                href={`/admin/trend-radar/products/${r.id}`}
                className="grid grid-cols-12 items-center px-3 py-2 rounded border border-gray-200 hover:bg-gray-50 transition-colors"
              >
                <div className="col-span-1 text-gray-400 font-mono">{i + 1}</div>
                <div className="col-span-4 min-w-0">
                  <div className="font-medium truncate flex items-center gap-2">
                    {r.canonical_name}
                    <LabelBadge label={r.label} />
                  </div>
                  <div className="text-xs text-gray-500">
                    {r.category_top} · {r.firstScore} → {r.lastScore}
                  </div>
                </div>
                <div
                  className={`col-span-1 text-right font-mono font-bold ${
                    r.alpha > 0 ? 'text-green-600' : r.alpha < 0 ? 'text-red-500' : 'text-gray-500'
                  }`}
                >
                  {r.alpha > 0 ? '+' : ''}
                  {r.alpha}
                </div>
                <div className="col-span-1 text-right font-mono text-amber-600">
                  {r.beta > 0 ? '+' : ''}
                  {r.beta}
                </div>
                <div className="col-span-1 text-right font-mono text-gray-700">
                  {r.totalDelta > 0 ? '+' : ''}
                  {r.totalDelta}
                </div>
                <div className="col-span-4">
                  <DecompBar beta={r.beta} alpha={r.alpha} maxAmp={maxAmp} />
                </div>
              </Link>
            ))}
            {rows.length > 80 && (
              <div className="text-xs text-gray-400 text-center py-2">
                상위 80개 표시 · 전체 {rows.length}개
              </div>
            )}
          </div>
        )}
      </section>
    </div>
  )
}

function LabelBadge({ label }: { label: AlphaRow['label'] }) {
  if (label === 'alpha')
    return (
      <span className="text-[10px] px-1.5 py-0.5 rounded bg-green-100 text-green-700 font-semibold">
        고유 상승
      </span>
    )
  if (label === 'beta')
    return (
      <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 font-semibold">
        베타 의존
      </span>
    )
  return null
}

/** 베타(주황) ▸ 알파(초록/빨강) 누적 막대. 0 을 중심으로 양/음 표현. */
function DecompBar({ beta, alpha, maxAmp }: { beta: number; alpha: number; maxAmp: number }) {
  const pct = (v: number) => `${Math.min(100, (Math.abs(v) / maxAmp) * 100)}%`
  return (
    <div className="flex items-center h-3 w-full bg-gray-100 rounded overflow-hidden">
      <div
        className={beta >= 0 ? 'bg-amber-400 h-full' : 'bg-amber-200 h-full'}
        style={{ width: pct(beta) }}
        title={`베타 ${beta}`}
      />
      <div
        className={alpha >= 0 ? 'bg-green-500 h-full' : 'bg-red-400 h-full'}
        style={{ width: pct(alpha) }}
        title={`알파 ${alpha}`}
      />
    </div>
  )
}

function Kpi({
  label,
  value,
  hint,
  tone,
}: {
  label: string
  value: number
  hint: string
  tone?: 'green' | 'amber'
}) {
  const color = tone === 'green' ? 'text-green-600' : tone === 'amber' ? 'text-amber-600' : ''
  return (
    <div className="rounded border border-gray-200 p-4">
      <div className="text-xs text-gray-500">{label}</div>
      <div className={`text-3xl font-bold mt-1 ${color}`}>{value.toLocaleString()}</div>
      <div className="text-xs text-gray-400 mt-1">{hint}</div>
    </div>
  )
}
