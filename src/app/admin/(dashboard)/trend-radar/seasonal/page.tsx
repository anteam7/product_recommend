import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import SeasonalBoard, { type SeasonalRow } from './SeasonalBoard'

export const dynamic = 'force-dynamic'

interface SeasonalDbRow {
  keyword: string
  month: number
  ratio: number | null
  seasonal_index: number | null
  sample_years: number
}
interface KeywordDbRow {
  keyword: string
  volume_relative: number | null
  collected_at: string
}

/** 현재 KST calendar month (1..12) */
function currentMonthKst(): number {
  const kst = new Date(Date.now() + 9 * 3600_000)
  return kst.getUTCMonth() + 1
}

async function fetchData() {
  const sb = createAdminClient()
  const curMonth = currentMonthKst()

  // 1) 계절 baseline (키워드 × 12개월)
  const { data: seasonal } = await (sb as any)
    .from('jimscanner_trends_seasonal')
    .select('keyword, month, ratio, seasonal_index, sample_years')
    .order('keyword')
    .limit(5000)
  const seasonalRows = (seasonal ?? []) as SeasonalDbRow[]

  // 2) 현재 30일 모멘텀 — 키워드별 최신 ratio
  const { data: kw } = await sb
    .from('jimscanner_trends_keywords')
    .select('keyword, volume_relative, collected_at')
    .eq('source', 'naver_search_trend')
    .order('collected_at', { ascending: false })
    .limit(4000)
  const latestByKw = new Map<string, number>()
  for (const r of (kw ?? []) as KeywordDbRow[]) {
    if (latestByKw.has(r.keyword)) continue
    if (r.volume_relative == null) continue
    latestByKw.set(r.keyword, r.volume_relative)
  }

  // 키워드별 묶기
  const byKw = new Map<string, SeasonalDbRow[]>()
  for (const r of seasonalRows) {
    const arr = byKw.get(r.keyword) ?? []
    arr.push(r)
    byKw.set(r.keyword, arr)
  }

  const rows: SeasonalRow[] = []
  for (const [keyword, months] of byKw.entries()) {
    const cur = months.find((m) => m.month === curMonth)
    const expected = cur?.seasonal_index ?? null // 100 = 연평균, >100 = 성수기
    const current = latestByKw.get(keyword) ?? null // 0~100 daily 모멘텀
    if (expected == null || current == null) continue

    // 잔차(residual surprise): 현재 모멘텀 − 계절 기대치.
    // 둘 다 0~100 스케일 근사. 양수 큰 = 달력으로 설명 안 되는 진짜 신규 수요.
    const residual = current - expected
    // 12개월 미니차트용 (month 순 정렬, seasonal_index)
    const spark = Array.from({ length: 12 }, (_, i) => {
      const mm = months.find((m) => m.month === i + 1)
      return mm?.seasonal_index ?? null
    })
    rows.push({
      keyword,
      expected: Math.round(expected),
      current: Math.round(current),
      residual: Math.round(residual),
      spark,
      curMonth,
    })
  }

  rows.sort((a, b) => b.residual - a.residual)
  return { rows, curMonth }
}

export default async function SeasonalPage() {
  const { rows, curMonth } = await fetchData()

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold">계절성 차감 잔차 보드</h1>
          <p className="text-sm text-gray-500 mt-1">
            X = 계절 기대치(100=연평균, →성수기) · Y = 잔차(현재 모멘텀 − 기대) · 이번 달:{' '}
            {curMonth}월 · 우상단↑잔차 = 달력이 못 설명하는 <b>진짜 브레이크아웃</b>
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      {rows.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500">
          아직 계절 baseline 없음. <code>POST /api/admin/trends/collect</code>{' '}
          <code>{`{ source: 'naver_seasonal' }`}</code> 로 36개월 monthly 적재 후 방문.
        </div>
      ) : (
        <SeasonalBoard rows={rows} />
      )}
    </div>
  )
}
