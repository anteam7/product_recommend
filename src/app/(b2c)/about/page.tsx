import { Metadata } from 'next'
import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'

export const metadata: Metadata = {
  title: '짐스캐너 소개 · 왜 우리가 배대지 비교를 만들었나',
  description:
    '짐스캐너는 국내 35개 이상 배대지 요금을 실시간 비교하는 1인 개발 독립 서비스입니다. 어떤 업체와도 제휴하지 않고, 공개된 요금 데이터만으로 순위를 매깁니다.',
  alternates: {
    canonical: 'https://jimscanner.co.kr/about',
  },
  openGraph: {
    title: '짐스캐너 소개 · 왜 우리가 배대지 비교를 만들었나',
    description:
      '35개+ 배대지 요금을 한눈에 비교하는 독립 서비스. 제휴·광고 없이 공개 요금 데이터로만 순위를 제공합니다.',
    url: 'https://jimscanner.co.kr/about',
  },
}

const aboutSchema = {
  '@context': 'https://schema.org',
  '@type': 'AboutPage',
  name: '짐스캐너 소개',
  url: 'https://jimscanner.co.kr/about',
  description:
    '짐스캐너는 국내 35개 이상 해외 배송대행지의 요금을 실시간 비교하는 1인 개발 독립 서비스입니다.',
  mainEntity: {
    '@type': 'Organization',
    name: '짐스캐너',
    url: 'https://jimscanner.co.kr',
    email: 'somonday@gmail.com',
    foundingDate: '2026-03',
    description:
      '해외직구 배대지 배송비를 무게·국가 기준으로 실시간 비교하는 정보 제공 서비스',
  },
}

const services = [
  {
    icon: '📊',
    title: '35개+ 배대지 요금 한눈에 비교',
    desc: '미국 17개, 일본 20개, 중국 17개 — 총 35개 배대지의 실시간 요금을 무게별로 비교합니다.',
  },
  {
    icon: '⚡',
    title: '무게 입력 즉시 계산',
    desc: '0.5kg부터 10kg까지, 실무게·부피무게 모두 지원. 복잡한 요금 구조도 한 번에 정리해 보여드립니다.',
  },
  {
    icon: '💰',
    title: '최저가 자동 추천',
    desc: '회원 등급, 환율, 할인 조건을 반영한 현 시점 최저가 배대지를 1~3위로 제시합니다.',
  },
  {
    icon: '📚',
    title: '직구 가이드',
    desc: '배대지 선택부터 통관, 절세 팁까지 초보자도 이해할 수 있는 실용 정보를 정리해 제공합니다.',
  },
]

const promises = [
  {
    num: '1',
    title: '투명성',
    desc: '어떤 배대지 업체와도 독점 계약이나 숨은 제휴 관계를 맺지 않습니다. 순위는 오직 공개된 요금 데이터에 기반해 계산됩니다.',
  },
  {
    num: '2',
    title: '중립성',
    desc: '특정 업체를 편애하거나 비방하지 않습니다. 모든 비교는 동일한 기준으로 이루어지며, 최저가 업체가 바뀌면 순위도 함께 바뀝니다.',
  },
  {
    num: '3',
    title: '사용자 우선',
    desc: '광고·제휴 수익보다 정확한 정보가 우선입니다. 요금 오류를 발견하시면 언제든 제보해 주세요. 빠르게 검증하고 수정하겠습니다.',
  },
  {
    num: '4',
    title: '지속적 개선',
    desc: '35개 배대지에서 멈추지 않습니다. 새로운 업체, 더 나은 비교 기능, 실시간 알림 등 사용자에게 필요한 기능을 꾸준히 추가할 계획입니다.',
  },
]

export default function AboutPage() {
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(aboutSchema) }}
      />
      <div className="py-12 px-4">
        <div className="container mx-auto max-w-4xl">
          {/* Hero */}
          <div className="mb-12">
            <Badge className="mb-3">서비스 소개</Badge>
            <h1 className="text-4xl font-bold text-gray-900 mb-4">짐스캐너 소개</h1>
            <p className="text-xl text-gray-700 font-medium mb-4">
              해외직구, 더 이상 배송비로 고민하지 마세요
            </p>
            <p className="text-base text-gray-600 leading-relaxed">
              짐스캐너는 <strong className="text-gray-900">국내 35개 이상의 해외 배송대행지(배대지)의 요금을
              실시간으로 비교</strong>하는 정보 제공 서비스입니다. 무게와 국가만 입력하면 내 상황에 가장 유리한
              배대지를 즉시 찾을 수 있습니다.
            </p>
          </div>

          {/* Section 1 — Why */}
          <section className="mb-12">
            <h2 className="text-2xl font-bold text-gray-900 mb-4 pb-2 border-b">
              왜 짐스캐너를 만들었나요
            </h2>
            <div className="space-y-4 text-gray-600 leading-relaxed">
              <p>해외직구를 처음 시작하면 누구나 같은 벽에 부딪힙니다.</p>
              <div className="bg-gray-50 border-l-4 border-blue-400 rounded-r-lg p-5 space-y-2 text-sm text-gray-700">
                <p>&ldquo;몰테일이 유명하다던데 정말 저렴한 걸까?&rdquo;</p>
                <p>&ldquo;오리건 센터가 무세금이라는데 배송비는 더 비싸지 않을까?&rdquo;</p>
                <p>&ldquo;일본 배대지는 어디가 빠르고 싸지?&rdquo;</p>
              </div>
              <p>
                각 배대지 홈페이지를 일일이 방문해서 요금표를 확인하고, 등급별 할인을 계산하고, 환율을 적용해
                비교하는 일은 초보자에게는 물론 숙련 직구인에게도 번거로운 작업입니다.
              </p>
              <p className="text-lg font-semibold text-gray-900">
                &ldquo;한 번에 비교할 수 있는 곳이 있다면 얼마나 좋을까?&rdquo;
              </p>
              <p>
                이 질문에서 짐스캐너가 시작됐습니다. 실제로 직구를 하며 느낀 불편함을 해결하기 위해{' '}
                <strong className="text-gray-900">2026년 3월, 1인 개발자가 직접 만든</strong> 서비스입니다.
              </p>
            </div>
          </section>

          {/* Section 2 — What we offer */}
          <section className="mb-12">
            <h2 className="text-2xl font-bold text-gray-900 mb-4 pb-2 border-b">
              짐스캐너가 제공하는 것
            </h2>
            <div className="grid sm:grid-cols-2 gap-4">
              {services.map((s) => (
                <Card key={s.title}>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-base flex items-center gap-2">
                      <span className="text-2xl">{s.icon}</span>
                      <span>{s.title}</span>
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="text-sm text-gray-600 leading-relaxed">
                    {s.desc}
                  </CardContent>
                </Card>
              ))}
            </div>
          </section>

          {/* Section 3 — Data */}
          <section className="mb-12">
            <h2 className="text-2xl font-bold text-gray-900 mb-4 pb-2 border-b">
              데이터는 어떻게 관리하나요
            </h2>
            <div className="space-y-4 text-gray-600 leading-relaxed">
              <p>
                짐스캐너의 모든 요금 데이터는{' '}
                <strong className="text-gray-900">각 배대지의 공식 홈페이지에 공개된 요금표를 기준</strong>으로
                수집하고 있습니다.
              </p>
              <div className="grid sm:grid-cols-3 gap-3">
                <div className="border rounded-lg p-4">
                  <p className="text-xs text-gray-500 mb-1">업데이트 주기</p>
                  <p className="text-sm font-medium text-gray-900">월 1회 이상</p>
                  <p className="text-xs text-gray-500 mt-1">요금 변동 시 수시 반영</p>
                </div>
                <div className="border rounded-lg p-4">
                  <p className="text-xs text-gray-500 mb-1">환율 적용</p>
                  <p className="text-sm font-medium text-gray-900">네이버 금융 매매기준율</p>
                  <p className="text-xs text-gray-500 mt-1">매일 자동 갱신 · <a href="/exchange-rates" className="text-blue-600 hover:underline">동향 보기</a></p>
                </div>
                <div className="border rounded-lg p-4">
                  <p className="text-xs text-gray-500 mb-1">검증 방식</p>
                  <p className="text-sm font-medium text-gray-900">3단계 검증</p>
                  <p className="text-xs text-gray-500 mt-1">수집 → 검토 → 공식 재확인</p>
                </div>
              </div>
              <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 text-sm text-amber-900">
                표시된 요금은 참고 기준이며 실제 요금은 회원 등급, 프로모션, 환율 변동에 따라 달라질 수 있습니다.{' '}
                <strong>최종 요금은 반드시 각 배대지 공식 사이트에서 확인</strong>해 주세요.
              </div>
            </div>
          </section>

          {/* Section 4 — Operator */}
          <section className="mb-12">
            <h2 className="text-2xl font-bold text-gray-900 mb-4 pb-2 border-b">
              운영자 소개
            </h2>
            <div className="bg-blue-50 border border-blue-100 rounded-xl p-6">
              <p className="text-gray-700 mb-4">
                짐스캐너는 <strong className="text-gray-900">1인 개발자</strong>가 운영하는 독립 서비스입니다.
              </p>
              <ul className="space-y-2 text-sm text-gray-700">
                <li className="flex gap-2">
                  <span className="text-blue-600 shrink-0">·</span>
                  <span>국내 IT 업계에서 데이터·자동화 분야 실무 경험</span>
                </li>
                <li className="flex gap-2">
                  <span className="text-blue-600 shrink-0">·</span>
                  <span>해외직구를 직접 이용하면서 느낀 불편함을 해결하고자 시작</span>
                </li>
                <li className="flex gap-2">
                  <span className="text-blue-600 shrink-0">·</span>
                  <span>데이터 수집·분석·시각화를 통해 사용자에게 실질적 가치 제공</span>
                </li>
              </ul>
              <p className="text-sm text-gray-600 mt-4 leading-relaxed">
                현재 시간을 쪼개어 서비스를 꾸준히 개선하고 있으며, 사용자 피드백을 가장 중요한 나침반으로
                삼고 있습니다.
              </p>
            </div>
          </section>

          {/* Section 5 — Promises */}
          <section className="mb-12">
            <h2 className="text-2xl font-bold text-gray-900 mb-4 pb-2 border-b">
              우리의 약속
            </h2>
            <div className="grid sm:grid-cols-2 gap-4">
              {promises.map((p) => (
                <div key={p.title} className="border rounded-xl p-5 hover:border-blue-300 transition-colors">
                  <div className="flex items-center gap-3 mb-2">
                    <span className="bg-blue-600 text-white text-sm font-bold rounded-full w-7 h-7 flex items-center justify-center shrink-0">
                      {p.num}
                    </span>
                    <h3 className="text-base font-bold text-gray-900">{p.title}</h3>
                  </div>
                  <p className="text-sm text-gray-600 leading-relaxed">{p.desc}</p>
                </div>
              ))}
            </div>
          </section>

          {/* Section 6 — Contact */}
          <section className="mb-12">
            <h2 className="text-2xl font-bold text-gray-900 mb-4 pb-2 border-b">
              함께 만들어 주세요
            </h2>
            <div className="space-y-4 text-gray-600 leading-relaxed">
              <p>
                짐스캐너는 <strong className="text-gray-900">사용자의 제보와 피드백</strong>으로 성장합니다.
              </p>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
                {['요금 정보 오류 제보', '새로운 배대지 추가 요청', '기능 제안', '협업·제휴 문의'].map((item) => (
                  <div
                    key={item}
                    className="bg-gray-50 border border-gray-200 rounded-lg p-3 text-center text-gray-700"
                  >
                    {item}
                  </div>
                ))}
              </div>
              <p>
                무엇이든 아래 이메일로 편하게 연락 주세요. 모든 메일은 직접 확인하고 답변드립니다.
              </p>
              <a
                href="mailto:somonday@gmail.com"
                className="inline-flex items-center gap-2 bg-blue-600 text-white px-5 py-3 rounded-lg font-medium hover:bg-blue-700 transition-colors"
              >
                <span>📧</span>
                <span>somonday@gmail.com</span>
              </a>
            </div>
          </section>

          {/* Section 7 — Disclaimer */}
          <section className="mb-12">
            <h2 className="text-2xl font-bold text-gray-900 mb-4 pb-2 border-b">
              면책 안내
            </h2>
            <div className="bg-gray-50 border border-gray-200 rounded-lg p-5 text-sm text-gray-600 space-y-3 leading-relaxed">
              <p>
                짐스캐너는 배송대행 서비스를{' '}
                <strong className="text-gray-900">직접 제공하지 않습니다</strong>. 표시된 요금은 참고용이며,
                실제 배송 계약은 사용자와 해당 배대지 업체 간에 이루어집니다. 짐스캐너는 배송 사고, 분실, 지연,
                파손 등 배송 과정에서 발생하는 문제에 대해 책임지지 않습니다.
              </p>
              <p>정확한 서비스 내용과 요금은 각 배대지 공식 사이트에서 확인해 주세요.</p>
            </div>
          </section>

          <p className="text-xs text-gray-400 text-right mb-8">마지막 업데이트: 2026년 4월</p>

          {/* CTA */}
          <div className="bg-blue-600 rounded-xl p-8 text-white text-center">
            <h2 className="text-2xl font-bold mb-3">지금 바로 배대지 비교해보기</h2>
            <p className="text-blue-100 mb-6">무게를 입력하면 최저가 배대지를 즉시 찾아드립니다</p>
            <div className="flex justify-center gap-4 flex-wrap">
              <Button size="lg" className="bg-white text-blue-700 hover:bg-blue-50" asChild>
                <Link href="/#calculator">배송비 계산하기</Link>
              </Button>
              <Button
                size="lg"
                className="bg-transparent border-2 border-white text-white hover:bg-white/10"
                asChild
              >
                <Link href="/compare">비교표 보기</Link>
              </Button>
            </div>
          </div>
        </div>
      </div>
    </>
  )
}
