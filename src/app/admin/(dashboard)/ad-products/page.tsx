import Link from 'next/link'
import AdProducts from './AdProducts'

export const dynamic = 'force-dynamic'

export default function AdProductsPage() {
  return (
    <div className="space-y-4 p-4 sm:p-6 max-w-6xl">
      <header className="flex items-baseline justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-xl font-bold">📣 광고 상품 관리</h1>
          <p className="text-sm text-gray-500 mt-1">
            <b>가격경쟁 가능 + 마진 여유 + 수요 신호</b>가 있어 <b>광고를 붙이면 팔릴 가능성이 보이는</b> 상품 후보입니다. 시세 모니터 스윕이 자동 선별합니다 — 상태를 <b>광고중/제외/보류</b>로 관리하세요.
          </p>
        </div>
        <Link href="/admin/pricewatch" className="text-sm text-gray-700 hover:text-black underline">← 시세 모니터</Link>
      </header>
      <AdProducts />
    </div>
  )
}
