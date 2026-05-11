'use client'

import { useEffect } from 'react'
import Link from 'next/link'

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error('App error:', error)
  }, [error])

  return (
    <div className="py-20 px-4">
      <div className="container mx-auto max-w-xl text-center">
        <p className="text-sm font-semibold text-red-600 mb-3">문제가 발생했어요</p>
        <h1 className="text-3xl sm:text-4xl font-bold text-gray-900 mb-3">
          페이지를 불러오지 못했습니다
        </h1>
        <p className="text-gray-600 leading-relaxed mb-8">
          일시적인 오류일 수 있어요. 잠시 후 다시 시도하거나 아래에서 원하는 페이지로 이동해 주세요.
        </p>

        <div className="flex flex-wrap gap-3 justify-center mb-8">
          <button
            onClick={() => reset()}
            className="inline-flex items-center justify-center rounded-md bg-blue-600 text-white px-5 py-2.5 text-sm font-medium hover:bg-blue-700 transition-colors"
          >
            다시 시도
          </button>
          <Link
            href="/"
            className="inline-flex items-center justify-center rounded-md border border-gray-300 bg-white text-gray-700 px-5 py-2.5 text-sm font-medium hover:bg-gray-50 transition-colors"
          >
            홈으로 이동
          </Link>
        </div>

        {error.digest && (
          <p className="text-xs text-gray-400">오류 ID: {error.digest}</p>
        )}
      </div>
    </div>
  )
}
