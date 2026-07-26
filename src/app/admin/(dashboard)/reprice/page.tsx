import Link from 'next/link'
import Reprice from './Reprice'

export const dynamic = 'force-dynamic'

export default function RepricePage() {
  return (
    <div className="space-y-4 p-4 sm:p-6 max-w-6xl">
      <header className="flex items-baseline justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-xl font-bold">💰 가격수정 승인</h1>
          <p className="text-sm text-gray-500 mt-1">
            <b>MSP를 지키면서 시세 이하로 내려 흑자로 아이템위너</b>가 될 수 있는 상품입니다. 근거를 보고 <b>승인</b>하면, 집 PC 스크립트가 <b>승인분만</b> 실제 가격을 조정합니다(쿠팡 IP 허용 문제로 웹에서 직접 변경 불가).
          </p>
        </div>
        <Link href="/admin/pricewatch" className="text-sm text-gray-700 hover:text-black underline">← 시세 모니터</Link>
      </header>
      <Reprice />
    </div>
  )
}
