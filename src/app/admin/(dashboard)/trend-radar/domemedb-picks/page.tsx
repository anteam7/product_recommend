import Link from 'next/link'
import DomemedbPicks from './DomemedbPicks'

export const dynamic = 'force-dynamic'

export default function DomemedbPicksPage() {
  return (
    <div className="space-y-4 p-4 sm:p-6 max-w-3xl">
      <header className="flex items-baseline justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-xl font-bold">💰 도매매 흑자 후보</h1>
          <p className="text-sm text-gray-500 mt-1">
            도매매 신규·인기·기획전 상품을 쿠팡 판매가와 비교해 <b>흑자 + 판매검증(후기)</b> 되는 것만 추렸습니다. (확정 공급가 기준)
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">← 대시보드</Link>
      </header>
      <DomemedbPicks />
    </div>
  )
}
