import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

interface KwRow {
  keyword: string
  category: string | null  // 시간 슬롯 (HH:MM)
  collected_at: string
}

const RANGE_DAYS = 30

async function fetchAll() {
  const sb = createAdminClient()
  const since = new Date(Date.now() - RANGE_DAYS * 86400_000).toISOString()
  const { data } = await sb
    .from('jimscanner_trends_keywords')
    .select('keyword, category, collected_at')
    .eq('source', 'naver_tvtime')
    .gte('collected_at', since)
    .order('collected_at', { ascending: false })
  return (data ?? []) as KwRow[]
}

interface KeywordAgg {
  keyword: string
  count: number
  slots: string[]
  firstSeen: string
  lastSeen: string
  perDay: Map<string, number>
}

function aggregate(rows: KwRow[]) {
  const map = new Map<string, KeywordAgg>()
  const slotHist = new Map<string, number>()
  const dayHist = new Map<string, number>()
  for (const r of rows) {
    let v = map.get(r.keyword)
    if (!v) {
      v = {
        keyword: r.keyword,
        count: 0,
        slots: [],
        firstSeen: r.collected_at,
        lastSeen: r.collected_at,
        perDay: new Map(),
      }
      map.set(r.keyword, v)
    }
    v.count++
    if (r.category && !v.slots.includes(r.category)) v.slots.push(r.category)
    if (r.collected_at < v.firstSeen) v.firstSeen = r.collected_at
    if (r.collected_at > v.lastSeen) v.lastSeen = r.collected_at
    const day = r.collected_at.slice(0, 10)
    v.perDay.set(day, (v.perDay.get(day) ?? 0) + 1)
    dayHist.set(day, (dayHist.get(day) ?? 0) + 1)

    // slot histogram (시간대 분포)
    if (r.category) {
      const hour = r.category.split(':')[0]
      slotHist.set(hour, (slotHist.get(hour) ?? 0) + 1)
    }
  }

  const ranked = [...map.values()]
    .sort((a, b) => b.count - a.count || b.lastSeen.localeCompare(a.lastSeen))
    .map((v) => ({ ...v, slots: v.slots.sort() }))

  // 시간대 분포 (00~23)
  const slotByHour = Array.from({ length: 24 }, (_, h) => ({
    hour: h,
    count: slotHist.get(String(h)) ?? slotHist.get(String(h).padStart(2, '0')) ?? 0,
  }))

  // 날짜 분포 (최근 N일)
  const days = [...dayHist.entries()].sort((a, b) => a[0].localeCompare(b[0]))

  return { ranked, slotByHour, days, totalKeywords: map.size, totalRows: rows.length }
}

// 카테고리·브랜드 단순 룰 추출 (LLM 없이) — 이름 안 키워드로
const CATEGORY_RULES: { label: string; pattern: RegExp; cat: string }[] = [
  { label: '건강식품', cat: 'health',  pattern: /(글루타치온|콜라겐|프로바이오틱|비타민|영양제|효소|루테인|오메가|밀크씨슬|매트리스|건강|관절|블루베리|효소|홍삼|비에날씬)/ },
  { label: '뷰티',     cat: 'living',  pattern: /(크림|세럼|토너|마스크팩|에센스|선크림|스킨|쿠션|파운데이션|립|아이|에스까다)/ },
  { label: '패션',     cat: 'living',  pattern: /(원피스|티셔츠|블라우스|니트|아우터|코트|재킷|바지|청바지|팬츠|언더웨어|의류|신발|가방|패션|언더웨어|언더|메리제인)/ },
  { label: '식품',     cat: 'health',  pattern: /(김치|반찬|만두|국|찌개|불고기|고기|수산|회|전복|새우|장어|쌀|곡류|과일|자몽|꿀|고추장|간장|된장|소금|설탕|꿀|꽈리|선식)/ },
  { label: '생활/리빙', cat: 'living',  pattern: /(매트|베개|침구|이불|쿠션|커튼|러그|수납|살림|주방|냄비|프라이팬|식기|컵|식탁|청소|세제|청소기|걸레)/ },
  { label: '디지털',   cat: 'digital', pattern: /(노트북|태블릿|폰|이어폰|헤드셋|충전|케이블|모니터|tv|티비|스피커|블루투스|드론|카메라)/i },
  { label: '가전',     cat: 'digital', pattern: /(냉장고|세탁기|에어컨|선풍기|공기청정기|믹서기|블렌더|토스터|커피머신|로봇청소기|건조기|식기세척기|전기|가전)/ },
]

const ALL_CATEGORIES = ['전체', ...CATEGORY_RULES.map((r) => r.label), '기타'] as const

function classifyByRule(name: string): { label: string; cat: string } | null {
  for (const r of CATEGORY_RULES) {
    if (r.pattern.test(name)) return { label: r.label, cat: r.cat }
  }
  return null
}

function categoryOf(name: string): string {
  return classifyByRule(name)?.label ?? '기타'
}

export default async function TvPushesPage({
  searchParams,
}: {
  searchParams: Promise<{ cat?: string }>
}) {
  const sp = await searchParams
  const selectedCat = (ALL_CATEGORIES.includes(sp.cat as any) ? sp.cat : '전체') as string

  const allRows = await fetchAll()

  // 전체 데이터로 카테고리 분포 (탭 카운트 표기)
  const catHistAll = new Map<string, number>()
  for (const r of allRows) {
    const c = categoryOf(r.keyword)
    catHistAll.set(c, (catHistAll.get(c) ?? 0) + 1)
  }

  // 선택된 카테고리로 필터
  const filteredRows =
    selectedCat === '전체'
      ? allRows
      : allRows.filter((r) => categoryOf(r.keyword) === selectedCat)

  const { ranked, slotByHour, days, totalKeywords, totalRows } = aggregate(filteredRows)

  // 표시용 카테고리 분포 (전체 모드에선 전체, 카테고리 선택 시도 동일하게 보여줘 비교 가능)
  const catRanked = [...catHistAll.entries()].sort((a, b) => b[1] - a[1])

  const maxSlot = Math.max(1, ...slotByHour.map((s) => s.count))
  const maxDay = Math.max(1, ...days.map(([, c]) => c))

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold">TV 편성 push 분석</h1>
          <p className="text-sm text-gray-500 mt-1">
            네이버 SERP `홈쇼핑 편성표` 위젯 통합 9사 (CJ·현대·NS·롯데·공영·신세계·온스타일·SK스토아·쇼핑엔티)
            · {RANGE_DAYS}일 누적
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      {/* 카테고리 필터 탭 */}
      <nav className="flex flex-wrap gap-1 border-b border-gray-200">
        {ALL_CATEGORIES.map((c) => {
          const count = c === '전체' ? allRows.length : (catHistAll.get(c) ?? 0)
          const active = c === selectedCat
          const href = c === '전체' ? '/admin/trend-radar/tv-pushes' : `/admin/trend-radar/tv-pushes?cat=${encodeURIComponent(c)}`
          return (
            <Link
              key={c}
              href={href}
              className={`px-3 py-2 text-sm border-b-2 ${
                active
                  ? 'border-amber-500 font-semibold text-black'
                  : 'border-transparent text-gray-500 hover:text-black'
              }`}
            >
              {c}
              <span className={`ml-1 text-xs ${active ? 'text-amber-600' : 'text-gray-400'}`}>
                {count}
              </span>
            </Link>
          )
        })}
      </nav>

      {/* KPI */}
      <section className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Kpi label="누적 편성 row" value={totalRows} />
        <Kpi label="unique 상품" value={totalKeywords} />
        <Kpi label="누적 일수" value={days.length} />
        <Kpi
          label="평균 편성/일"
          value={days.length > 0 ? Math.round(totalRows / days.length) : 0}
        />
      </section>

      {/* 카테고리 분포 */}
      <section>
        <h2 className="text-sm font-semibold mb-2">
          카테고리 분포 <span className="text-xs font-normal text-gray-500">(룰 기반 · 전체 데이터)</span>
        </h2>
        <div className="rounded border border-gray-200 p-4">
          {catRanked.length === 0 ? (
            <div className="text-sm text-gray-500 text-center py-4">데이터 없음</div>
          ) : (
            <div className="space-y-2">
              {catRanked.map(([label, count]) => {
                const pct = (count / totalRows) * 100
                return (
                  <div key={label} className="flex items-center gap-3 text-sm">
                    <div className="w-20 text-gray-700">{label}</div>
                    <div className="flex-1 h-5 bg-gray-100 rounded relative overflow-hidden">
                      <div
                        className="h-full bg-amber-400"
                        style={{ width: `${Math.max(2, pct)}%` }}
                      />
                    </div>
                    <div className="w-20 text-right font-mono text-xs">
                      {count} ({pct.toFixed(1)}%)
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </section>

      {/* 시간대 분포 */}
      <section>
        <h2 className="text-sm font-semibold mb-2">
          시간대 분포 <span className="text-xs font-normal text-gray-500">(선택 카테고리: {selectedCat})</span>
        </h2>
        <div className="rounded border border-gray-200 p-4">
          <div className="flex items-end gap-1 h-32">
            {slotByHour.map((s) => (
              <div key={s.hour} className="flex-1 flex flex-col items-center justify-end gap-1">
                <div
                  className="w-full bg-amber-400 rounded-t"
                  style={{ height: `${(s.count / maxSlot) * 100}%`, minHeight: s.count > 0 ? '2px' : '0' }}
                  title={`${s.hour}시: ${s.count}회`}
                />
                <div className="text-[10px] text-gray-400">{s.hour}</div>
              </div>
            ))}
          </div>
          <div className="text-xs text-gray-500 mt-2">시간 (24h) · 막대 = 편성 횟수</div>
        </div>
      </section>

      {/* 날짜 분포 */}
      <section>
        <h2 className="text-sm font-semibold mb-2">날짜별 누적 편성</h2>
        <div className="rounded border border-gray-200 p-4">
          {days.length === 0 ? (
            <div className="text-sm text-gray-500 text-center py-4">데이터 없음</div>
          ) : (
            <div className="flex items-end gap-1 h-24">
              {days.map(([day, count]) => (
                <div key={day} className="flex-1 flex flex-col items-center justify-end gap-1">
                  <div
                    className="w-full bg-amber-300 rounded-t"
                    style={{ height: `${(count / maxDay) * 100}%`, minHeight: '2px' }}
                    title={`${day}: ${count}회`}
                  />
                  <div className="text-[10px] text-gray-400">{day.slice(5)}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>

      {/* 빈도 랭킹 */}
      <section>
        <h2 className="text-sm font-semibold mb-2">
          편성 빈도 랭킹 <span className="text-xs font-normal text-gray-500">({selectedCat} · {ranked.length}개)</span>
        </h2>
        <div className="rounded border border-gray-200 divide-y divide-gray-100">
          <div className="grid grid-cols-12 text-xs text-gray-500 px-3 py-2 bg-gray-50">
            <div className="col-span-1">#</div>
            <div className="col-span-5">상품명</div>
            <div className="col-span-1 text-right">편성</div>
            <div className="col-span-2 text-right">시간 슬롯</div>
            <div className="col-span-2 text-right">range</div>
            <div className="col-span-1 text-right">cat</div>
          </div>
          {ranked.slice(0, 100).map((r, i) => {
            const cat = classifyByRule(r.keyword)
            const range =
              r.firstSeen.slice(5, 10) === r.lastSeen.slice(5, 10)
                ? r.lastSeen.slice(5, 10)
                : `${r.firstSeen.slice(5, 10)}~${r.lastSeen.slice(5, 10)}`
            return (
              <div key={r.keyword} className="grid grid-cols-12 px-3 py-2 text-sm">
                <div className="col-span-1 font-mono text-gray-400">{i + 1}</div>
                <div className="col-span-5 truncate">{r.keyword}</div>
                <div className="col-span-1 text-right font-mono font-bold">{r.count}</div>
                <div className="col-span-2 text-right text-xs text-gray-500">
                  {r.slots.length <= 3 ? r.slots.join(', ') : `${r.slots[0]}…${r.slots.slice(-1)[0]} (${r.slots.length})`}
                </div>
                <div className="col-span-2 text-right text-xs text-gray-500">{range}</div>
                <div className="col-span-1 text-right text-xs">
                  {cat ? <span className="px-2 py-0.5 rounded bg-amber-100 text-amber-700">{cat.label}</span> : <span className="text-gray-300">—</span>}
                </div>
              </div>
            )
          })}
        </div>
      </section>

      <section className="text-xs text-gray-500 border-t border-gray-200 pt-4">
        매일 KST <strong>04:10</strong> + <strong>17:10</strong> (황금시간) 2회 자동 수집.
        각 시점의 *직후 ~12시간* 편성을 잡음. 카테고리 분류는 단순 룰 기반 (LLM 적용 시 정확도 ↑).
      </section>
    </div>
  )
}

function Kpi({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded border border-gray-200 p-3">
      <div className="text-xs text-gray-500">{label}</div>
      <div className="text-2xl font-bold mt-1">{value.toLocaleString()}</div>
    </div>
  )
}
