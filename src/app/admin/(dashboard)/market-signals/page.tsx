import { headers } from 'next/headers'
import MarketSignalsDashboard, { type Overview } from './MarketSignalsDashboard'

export const dynamic = 'force-dynamic'

async function fetchOverview(): Promise<Overview | null> {
  const h = await headers()
  const host = h.get('host') ?? 'localhost:3000'
  const proto = h.get('x-forwarded-proto') ?? 'http'
  const cookie = h.get('cookie') ?? ''
  const res = await fetch(`${proto}://${host}/api/admin/market-signals/overview`, {
    cache: 'no-store',
    headers: { cookie },
  })
  if (!res.ok) return null
  return (await res.json()) as Overview
}

export default async function MarketSignalsPage() {
  const overview = await fetchOverview()

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">📡 시장 시그널</h1>
        <p className="text-sm text-gray-500 mt-1 max-w-3xl">
          매일 새벽 자동 수집되는 직구 외부 데이터(Google 자동완성·네이버 뉴스·블로그·커뮤니티·핫딜·정부 보도) 의 분석 화면입니다.
          키워드 추천·콘텐츠 기획에 사용하는 1차 신호.
        </p>
      </div>

      {!overview ? (
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 text-sm text-amber-900">
          데이터를 불러오지 못했습니다. 새로고침해 주세요.
        </div>
      ) : (
        <MarketSignalsDashboard initial={overview} />
      )}
    </div>
  )
}
