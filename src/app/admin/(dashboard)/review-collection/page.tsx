export const metadata = {
  title: '후기 정보 수집 · Admin',
}

export default function ReviewCollectionPage() {
  return (
    <div className="space-y-6">
      <div>
        <p className="text-sm text-gray-500">운영 준비</p>
        <h1 className="mt-1 text-2xl font-semibold text-gray-900">후기 정보 수집</h1>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-gray-600">
          배대지 후기 데이터 수집 기능을 위한 메뉴입니다. 실제 수집, 크롤링, 저장 로직은 아직
          연결하지 않았습니다.
        </p>
      </div>

      <section className="rounded-lg border bg-white p-6">
        <h2 className="text-base font-semibold text-gray-900">예정 범위</h2>
        <ul className="mt-4 space-y-2 text-sm text-gray-600">
          <li>후기 수집 대상 채널 관리</li>
          <li>배대지명·국가·감성·키워드 자동 분류</li>
          <li>메인/상세 페이지 노출 승인 워크플로우</li>
          <li>출처 URL과 수집 시각 이력 관리</li>
        </ul>
      </section>
    </div>
  )
}
