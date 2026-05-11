import type { Metadata } from 'next'
import SearchConsoleApp from './SearchConsoleApp'

export const metadata: Metadata = {
  title: 'Search Console 분석 | 관리자',
  robots: { index: false, follow: false },
}

export const dynamic = 'force-dynamic'

export default function Page() {
  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-bold">🔍 Google Search Console</h1>
        <p className="mt-1 text-sm text-gray-600">
          짐스캐너에 유입된 검색 키워드와 페이지 성과를 확인하고, 글감으로 바로 활용합니다.
        </p>
      </header>
      <SearchConsoleApp />
    </div>
  )
}
