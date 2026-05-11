import type { ForwarderContent } from '@/lib/forwarder-content'

type Props = {
  content: ForwarderContent | null
  forwarderName: string
}

export default function ForwarderContentSections({ content, forwarderName }: Props) {
  if (!content || content.status !== 'published') return null

  const hasOverview = (content.overview ?? '').trim().length > 0
  const hasStrengths = (content.strengths ?? []).length > 0
  const hasWeaknesses = (content.weaknesses ?? []).length > 0
  const hasFeatures = (content.service_features ?? []).length > 0
  const hasPricing = (content.pricing_notes ?? '').trim().length > 0
  const hasRecommended = (content.recommended_for ?? '').trim().length > 0
  const hasTips = (content.usage_tips ?? []).length > 0
  const hasFaq = (content.faq ?? []).length > 0

  if (
    !hasOverview &&
    !hasStrengths &&
    !hasWeaknesses &&
    !hasFeatures &&
    !hasPricing &&
    !hasRecommended &&
    !hasTips &&
    !hasFaq
  ) {
    return null
  }

  return (
    <div className="space-y-10">
      {hasOverview && (
        <section>
          <h2 className="text-2xl font-bold text-gray-900 mb-4 pb-2 border-b">
            {forwarderName} 소개
          </h2>
          <div className="text-gray-700 leading-relaxed whitespace-pre-wrap">
            {content.overview}
          </div>
        </section>
      )}

      {(hasStrengths || hasWeaknesses) && (
        <section>
          <h2 className="text-2xl font-bold text-gray-900 mb-4 pb-2 border-b">
            강점과 주의점
          </h2>
          <div className="grid md:grid-cols-2 gap-4">
            {hasStrengths && (
              <div className="bg-green-50 border border-green-100 rounded-lg p-5">
                <h3 className="text-sm font-semibold text-green-900 mb-3">👍 강점</h3>
                <ul className="space-y-3">
                  {content.strengths.map((item, i) => (
                    <li key={i}>
                      <div className="font-medium text-gray-900 text-sm">{item.title}</div>
                      <div className="text-sm text-gray-700 mt-0.5 leading-relaxed">
                        {item.description}
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {hasWeaknesses && (
              <div className="bg-amber-50 border border-amber-100 rounded-lg p-5">
                <h3 className="text-sm font-semibold text-amber-900 mb-3">⚠️ 알아둘 점</h3>
                <ul className="space-y-3">
                  {content.weaknesses.map((item, i) => (
                    <li key={i}>
                      <div className="font-medium text-gray-900 text-sm">{item.title}</div>
                      <div className="text-sm text-gray-700 mt-0.5 leading-relaxed">
                        {item.description}
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </section>
      )}

      {hasFeatures && (
        <section>
          <h2 className="text-2xl font-bold text-gray-900 mb-4 pb-2 border-b">
            서비스 특징
          </h2>
          <div className="grid sm:grid-cols-2 gap-4">
            {content.service_features.map((item, i) => (
              <div key={i} className="border rounded-lg p-4">
                <h3 className="font-semibold text-gray-900 text-sm mb-1">{item.title}</h3>
                <p className="text-sm text-gray-600 leading-relaxed">{item.description}</p>
              </div>
            ))}
          </div>
        </section>
      )}

      {hasPricing && (
        <section>
          <h2 className="text-2xl font-bold text-gray-900 mb-4 pb-2 border-b">
            요금 체계 이해하기
          </h2>
          <div className="bg-blue-50 border border-blue-100 rounded-lg p-5 text-gray-700 leading-relaxed whitespace-pre-wrap">
            {content.pricing_notes}
          </div>
        </section>
      )}

      {hasRecommended && (
        <section>
          <h2 className="text-2xl font-bold text-gray-900 mb-4 pb-2 border-b">
            이 배대지는 어떤 분에게?
          </h2>
          <p className="text-gray-700 leading-relaxed whitespace-pre-wrap">
            {content.recommended_for}
          </p>
        </section>
      )}

      {hasTips && (
        <section>
          <h2 className="text-2xl font-bold text-gray-900 mb-4 pb-2 border-b">
            이용 팁
          </h2>
          <ol className="space-y-4">
            {content.usage_tips.map((item, i) => (
              <li key={i} className="flex gap-3">
                <span className="bg-blue-600 text-white text-xs font-bold rounded-full w-7 h-7 flex items-center justify-center shrink-0 mt-0.5">
                  {i + 1}
                </span>
                <div>
                  <div className="font-medium text-gray-900 text-sm">{item.title}</div>
                  <div className="text-sm text-gray-700 mt-1 leading-relaxed">
                    {item.description}
                  </div>
                </div>
              </li>
            ))}
          </ol>
        </section>
      )}

      {hasFaq && (
        <section>
          <h2 className="text-2xl font-bold text-gray-900 mb-4 pb-2 border-b">
            {forwarderName} 자주 묻는 질문
          </h2>
          <div className="space-y-3">
            {content.faq.map((item, i) => (
              <div key={i} className="border rounded-lg p-4">
                <p className="font-medium text-gray-900 text-sm mb-2">Q. {item.question}</p>
                <p className="text-sm text-gray-700 leading-relaxed whitespace-pre-wrap">
                  A. {item.answer}
                </p>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  )
}
