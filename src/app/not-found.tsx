import Link from 'next/link'
import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: '페이지를 찾을 수 없습니다',
  robots: { index: false, follow: false },
}

export default function NotFound() {
  return (
    <div className="py-20 px-4">
      <div className="container mx-auto max-w-xl text-center">
        <p className="text-sm font-semibold text-blue-600 mb-3">404</p>
        <h1 className="text-3xl sm:text-4xl font-bold text-gray-900 mb-3">
          찾으시는 페이지가 없습니다
        </h1>
        <p className="text-gray-600 leading-relaxed mb-8">
          주소가 변경되었거나 삭제된 페이지일 수 있어요. 아래 바로가기로 이동해 보세요.
        </p>

        <div className="grid sm:grid-cols-3 gap-3">
          <Link
            href="/"
            className="block border rounded-lg p-4 hover:border-blue-300 hover:shadow-sm transition-all"
          >
            <p className="text-sm font-semibold text-gray-900">홈</p>
            <p className="text-xs text-gray-500 mt-1">짐스캐너 메인</p>
          </Link>
          <Link
            href="/compare"
            className="block border rounded-lg p-4 hover:border-blue-300 hover:shadow-sm transition-all"
          >
            <p className="text-sm font-semibold text-gray-900">배송비 비교</p>
            <p className="text-xs text-gray-500 mt-1">30개+ 배대지 한눈에</p>
          </Link>
          <Link
            href="/forwarders"
            className="block border rounded-lg p-4 hover:border-blue-300 hover:shadow-sm transition-all"
          >
            <p className="text-sm font-semibold text-gray-900">배대지 목록</p>
            <p className="text-xs text-gray-500 mt-1">국가별 업체 리스트</p>
          </Link>
        </div>
      </div>
    </div>
  )
}
