import type { Metadata } from 'next'
import AnalyticsApp from './AnalyticsApp'

export const metadata: Metadata = {
  title: '트래픽 분석 | 관리자',
  robots: { index: false, follow: false },
}

export const dynamic = 'force-dynamic'

export default function Page() {
  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-bold">📊 트래픽 분석 (GSC × GA4)</h1>
        <p className="mt-1 text-sm text-gray-600">
          페이지별 검색 노출(GSC)과 실제 방문(GA4)을 한 행에 매칭해, 어디가 클릭이 안 되는지·어디가
          이탈하는지를 한눈에 확인합니다.
        </p>
      </header>
      <AnalyticsApp />
    </div>
  )
}
