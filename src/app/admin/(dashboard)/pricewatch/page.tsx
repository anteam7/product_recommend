import Link from 'next/link'
import PriceWatch from './PriceWatch'

export const dynamic = 'force-dynamic'

export default function PriceWatchPage() {
  return (
    <div className="space-y-4 p-4 sm:p-6 max-w-5xl">
      <header className="flex items-baseline justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-xl font-bold">📉 내 상품 시세 모니터</h1>
          <p className="text-sm text-gray-500 mt-1">
            내 쿠팡 상품의 <b>아이템위너 시세 vs 내 판매가</b>를 스카우트 확장으로 안전하게 수집·비교합니다. <b>비쌈(LOSE)</b>·<b>구조적 적자</b>를 가려내 어디서 판매가 새는지 파악하세요.
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">← 대시보드</Link>
      </header>
      <PriceWatch />
    </div>
  )
}
