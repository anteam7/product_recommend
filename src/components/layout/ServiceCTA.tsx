import Link from 'next/link'

/**
 * 블로그 상세 하단·배대지 상세 하단 등에 삽입하는 "지금 비교하기" 전환 CTA.
 * 글을 읽은 사용자를 곧바로 비교 흐름으로 유도.
 */
export default function ServiceCTA({
  variant = 'default',
  country,
}: {
  variant?: 'default' | 'blog' | 'forwarder'
  country?: 'us' | 'jp' | 'cn'
}) {
  const targetHref = country ? `/compare/${country}` : '/compare'

  const copy = {
    default: {
      title: '본인 무게로 직접 비교하기',
      sub: '33곳 미국·일본·중국 배대지 요금을 무게만 입력하면 1초에 최저가 순 정렬.',
      cta: '지금 비교하기',
    },
    blog: {
      title: '글 읽으셨으니 직접 비교도 한 번',
      sub: '이 글에서 인용된 요금은 실시간 환율로 계속 업데이트됩니다. 내 상황에 맞춘 결과는 비교 페이지에서.',
      cta: '내 무게로 비교하기',
    },
    forwarder: {
      title: '이 배대지 vs 나머지 32곳',
      sub: '같은 무게·등급으로 한 번에 비교해 실제로 저렴한지 확인.',
      cta: '전체 비교하기',
    },
  }[variant]

  return (
    <section className="mt-12 rounded-2xl bg-gradient-to-br from-blue-600 to-blue-700 p-6 sm:p-8 text-white shadow-lg">
      <div className="flex flex-col sm:flex-row sm:items-center gap-6 sm:gap-8">
        <div className="flex-1 min-w-0">
          <p className="text-xs uppercase tracking-wider text-blue-200 mb-2">짐스캐너</p>
          <h3 className="text-xl sm:text-2xl font-bold leading-tight">{copy.title}</h3>
          <p className="mt-2 text-sm sm:text-base text-blue-100 leading-relaxed">{copy.sub}</p>
        </div>
        <Link
          href={targetHref}
          className="inline-flex items-center justify-center whitespace-nowrap rounded-lg bg-white px-5 py-3 text-sm font-semibold text-blue-700 shadow-sm hover:bg-blue-50 transition-colors"
        >
          {copy.cta}
          <svg
            className="ml-2 h-4 w-4"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            aria-hidden="true"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 8l4 4m0 0l-4 4m4-4H3" />
          </svg>
        </Link>
      </div>
    </section>
  )
}
