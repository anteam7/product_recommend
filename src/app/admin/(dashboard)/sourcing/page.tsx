import Link from 'next/link'
import SourcingCompare from './SourcingCompare'

export const dynamic = 'force-dynamic'

export default function SourcingPage() {
  return (
    <div className="space-y-4 p-4 sm:p-6 max-w-6xl">
      <header className="flex items-baseline justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-xl font-bold">🛒 소싱 매입 후보</h1>
          <p className="text-sm text-gray-500 mt-1">
            쿠팡 수요 후보 중 <b>국내 도매(도매꾹) 소싱 + 로켓그로스 흑자</b>로 좁힌 후보. 도매꾹·쿠팡 이미지·링크로 실물 대조 후 매입하세요. 모바일에서도 확인 가능합니다.
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">← 대시보드</Link>
      </header>
      <SourcingCompare />
    </div>
  )
}
