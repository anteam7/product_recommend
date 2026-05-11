import { Metadata } from 'next'
import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'

export const metadata: Metadata = {
  title: '해외직구 완벽 가이드 2026 | 배대지 추천·통관·절약 팁 총정리',
  description: '해외직구 초보자를 위한 2026년 최신 가이드. 미국·일본 배대지 추천, 관세 면세 기준 $150/$200, 배송비 절약 팁, 개인통관고유부호 발급까지 한 번에.',
  alternates: {
    canonical: 'https://jimscanner.co.kr/guide',
  },
}

const faqItems = [
  {
    q: '배대지를 처음 이용하는데 어렵지 않나요?',
    a: '생각보다 간단합니다. 배대지에 가입 후 발급되는 주소를 해외 쇼핑몰 배송지로 입력하면 됩니다. 이후 입고 알림을 받으면 배송 신청만 하면 됩니다.',
  },
  {
    q: '배송 기간은 얼마나 걸리나요?',
    a: '미국에서 한국까지 항공편 기준 5~10 영업일, 일본은 3~7 영업일이 일반적입니다. 시즌이나 검역 상황에 따라 달라질 수 있습니다.',
  },
  {
    q: '분실이나 파손 시 어떻게 하나요?',
    a: '대부분의 배대지는 배송 보험 서비스를 제공합니다. 배송 신청 시 보험에 가입하는 것을 권장합니다. 고가품은 반드시 보험에 가입하세요.',
  },
  {
    q: '부피 무게란 무엇인가요?',
    a: '실제 무게보다 부피가 큰 상품은 부피 무게(가로×세로×높이÷5000)로 계산됩니다. 상자나 쿠션이 큰 상품 주문 시 실제 배송비가 더 높을 수 있습니다.',
  },
  {
    q: '해외직구 관세 면세 기준은 얼마인가요?',
    a: '미국발은 $200 이하, 그 외 국가(일본, 중국 등)는 $150 이하일 경우 목록통관으로 관세가 면제됩니다. 단, 담배·주류·한약 등 일부 품목은 금액 무관 일반수입신고가 필요합니다.',
  },
  {
    q: '개인통관고유부호는 어디서 발급받나요?',
    a: '관세청 전자통관시스템(unipass.customs.go.kr)에서 무료로 발급받을 수 있습니다. 발급 시간은 1~2분이며, 한 번 발급하면 평생 사용 가능합니다.',
  },
  {
    q: '배대지 합포장이란 무엇인가요?',
    a: '여러 건의 주문을 하나의 박스로 묶어 함께 발송하는 서비스입니다. 배송비를 크게 절약할 수 있으며, 대부분의 배대지에서 유료 또는 무료로 제공합니다.',
  },
  {
    q: '오리건 센터를 이용하면 무엇이 좋은가요?',
    a: '미국 오리건주는 판매세(Sales Tax)가 없습니다. 오리건 센터가 있는 배대지를 이용하면 구매 단계에서 판매세를 아낄 수 있어 실질 절약 효과가 큽니다.',
  },
]

const faqSchema = {
  "@context": "https://schema.org",
  "@type": "FAQPage",
  mainEntity: faqItems.map((item) => ({
    "@type": "Question",
    name: item.q,
    acceptedAnswer: {
      "@type": "Answer",
      text: item.a,
    },
  })),
}

const howToSchema = {
  "@context": "https://schema.org",
  "@type": "HowTo",
  name: "배대지로 해외직구 하는 방법",
  description: "배대지를 이용해 미국·일본 해외 쇼핑몰에서 직구하는 단계별 방법",
  step: [
    {
      "@type": "HowToStep",
      position: 1,
      name: "배대지 선택 및 가입",
      text: "짐스캐너에서 배대지 배송비를 비교한 후 원하는 배대지에 가입합니다. 가입 시 개인 전용 해외 주소(미국/일본)가 발급됩니다."
    },
    {
      "@type": "HowToStep",
      position: 2,
      name: "해외 쇼핑몰에서 주문",
      text: "Amazon, eBay, Rakuten 등 해외 쇼핑몰에서 배대지 발급 주소를 배송지로 입력하여 주문합니다."
    },
    {
      "@type": "HowToStep",
      position: 3,
      name: "창고 입고 확인",
      text: "상품이 배대지 창고에 도착하면 문자·이메일로 입고 알림이 옵니다. 배대지 사이트에서 상태를 확인합니다."
    },
    {
      "@type": "HowToStep",
      position: 4,
      name: "한국으로 배송 신청",
      text: "배대지 사이트에서 배송 신청 후 세관 신고서(품명, 가격)를 작성하고 개인통관고유부호를 입력합니다."
    },
    {
      "@type": "HowToStep",
      position: 5,
      name: "통관 및 수령",
      text: "$150(미국 $200) 이하는 목록통관으로 자동 통관됩니다. 5~10 영업일 내 집으로 배송됩니다."
    },
  ]
}

export default function GuidePage() {
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(faqSchema) }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(howToSchema) }}
      />
    <div className="py-12 px-4">
      <div className="container mx-auto max-w-4xl">
        <div className="mb-10">
          <Badge className="mb-3">직구 가이드</Badge>
          <h1 className="text-4xl font-bold text-gray-900 mb-3">해외직구 완벽 가이드</h1>
          <p className="text-lg text-gray-500">
            배대지부터 통관까지, 해외직구의 모든 것을 알려드립니다
          </p>
        </div>

        {/* Table of Contents */}
        <Card className="mb-10 bg-blue-50 border-blue-100">
          <CardHeader>
            <CardTitle className="text-base text-blue-900">목차</CardTitle>
          </CardHeader>
          <CardContent>
            <ol className="space-y-2 text-sm text-blue-800">
              <li><a href="#what-is-baedaeji" className="hover:underline">1. 배대지란 무엇인가?</a></li>
              <li><a href="#how-to-use" className="hover:underline">2. 배대지 사용 방법</a></li>
              <li><a href="#recommend" className="hover:underline">3. 나라별 배대지 추천 & 비교</a></li>
              <li><a href="#customs" className="hover:underline">4. 통관 안내 및 세금</a></li>
              <li><a href="#tips" className="hover:underline">5. 배송비 절약 팁</a></li>
              <li><a href="#faq" className="hover:underline">6. 자주 묻는 질문</a></li>
            </ol>
          </CardContent>
        </Card>

        {/* Section 1 */}
        <section id="what-is-baedaeji" className="mb-12">
          <h2 className="text-2xl font-bold text-gray-900 mb-4 pb-2 border-b">
            1. 배대지란 무엇인가?
          </h2>
          <div className="prose max-w-none text-gray-600 space-y-4">
            <p>
              <strong>배대지(배송대행지)</strong>는 해외 현지에 위치한 물류 창고로, 해외 쇼핑몰에서 구매한 물건을
              받아 한국까지 배송해 주는 서비스입니다. 해외 직배송이 안 되거나 직배송 비용이 비쌀 때 배대지를 이용하면 편리합니다.
            </p>
            <div className="bg-gray-50 rounded-lg p-4">
              <p className="font-medium text-gray-900 mb-2">배대지 이용 과정</p>
              <div className="flex flex-col sm:flex-row items-center gap-2 text-sm flex-wrap">
                {['해외 쇼핑몰 주문', '배대지 주소로 배송', '창고 입고 확인', '한국으로 배송 신청', '한국 수령'].map((step, i, arr) => (
                  <div key={i} className="flex items-center gap-2">
                    <span className="bg-blue-600 text-white text-xs rounded-full w-6 h-6 flex items-center justify-center shrink-0">
                      {i + 1}
                    </span>
                    <span>{step}</span>
                    {i < arr.length - 1 && <span className="text-gray-400 hidden sm:inline">→</span>}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </section>

        {/* Section 2 */}
        <section id="how-to-use" className="mb-12">
          <h2 className="text-2xl font-bold text-gray-900 mb-4 pb-2 border-b">
            2. 배대지 사용 방법
          </h2>
          <div className="space-y-4 text-gray-600">
            <div className="grid sm:grid-cols-2 gap-4">
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-base">Step 1. 배대지 선택 및 가입</CardTitle>
                </CardHeader>
                <CardContent className="text-sm space-y-2">
                  <p>원하는 배대지에 가입하면 개인 전용 해외 주소를 받습니다.</p>
                  <p className="text-blue-600 text-xs">→ 짐패스 비교에서 배대지를 먼저 비교하세요!</p>
                </CardContent>
              </Card>
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-base">Step 2. 해외 쇼핑몰에서 주문</CardTitle>
                </CardHeader>
                <CardContent className="text-sm space-y-2">
                  <p>Amazon, eBay 등에서 배대지 주소를 배송지로 입력하여 주문합니다.</p>
                </CardContent>
              </Card>
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-base">Step 3. 입고 확인</CardTitle>
                </CardHeader>
                <CardContent className="text-sm space-y-2">
                  <p>상품이 배대지 창고에 입고되면 문자나 이메일로 알림이 옵니다.</p>
                </CardContent>
              </Card>
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-base">Step 4. 배송 신청</CardTitle>
                </CardHeader>
                <CardContent className="text-sm space-y-2">
                  <p>배대지 사이트에서 배송을 신청하고 세관 신고서를 작성합니다.</p>
                </CardContent>
              </Card>
            </div>
          </div>
        </section>

        {/* Section 3 — 나라별 배대지 추천 */}
        <section id="recommend" className="mb-12">
          <h2 className="text-2xl font-bold text-gray-900 mb-4 pb-2 border-b">
            3. 나라별 배대지 추천 & 비교
          </h2>
          <p className="text-gray-600 text-sm mb-6">
            배대지마다 지원 국가, 배송비, 서비스가 다릅니다. 짐스캐너에서 무게를 입력하면 현재 최저가 배대지를 즉시 찾아드립니다.
          </p>
          <div className="grid sm:grid-cols-3 gap-4 mb-6">
            {[
              {
                flag: '🇺🇸',
                country: '미국 배대지',
                href: '/compare/us',
                points: ['아마존·나이키·베스트바이', '오리건 센터 → 판매세 0%', '면세 한도 $200'],
                highlight: '오리건 무세금',
              },
              {
                flag: '🇯🇵',
                country: '일본 배대지',
                href: '/compare/jp',
                points: ['라쿠텐·야후옥션·조조타운', '빠른 배송 (3~7일)', '면세 한도 $150'],
                highlight: '가장 빠름',
              },
              {
                flag: '🇨🇳',
                country: '중국 배대지',
                href: '/compare/cn',
                points: ['타오바오·1688·징동', '저렴한 배송비', '면세 한도 $150'],
                highlight: '최저가',
              },
            ].map((item) => (
              <Link
                key={item.country}
                href={item.href}
                className="block border rounded-xl p-5 hover:border-blue-400 hover:shadow-sm transition-all group"
              >
                <div className="flex items-center gap-2 mb-3">
                  <span className="text-2xl">{item.flag}</span>
                  <span className="font-bold text-gray-900 group-hover:text-blue-600">{item.country}</span>
                </div>
                <ul className="text-xs text-gray-600 space-y-1 mb-3">
                  {item.points.map((p) => (
                    <li key={p} className="flex items-center gap-1">
                      <span className="text-gray-400">·</span>{p}
                    </li>
                  ))}
                </ul>
                <span className="inline-block text-xs bg-blue-50 text-blue-700 px-2 py-1 rounded-full font-medium">
                  {item.highlight}
                </span>
                <p className="text-xs text-blue-600 mt-2 font-medium group-hover:underline">배송비 비교 →</p>
              </Link>
            ))}
          </div>
          <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 text-sm text-amber-900">
            <strong>TIP.</strong> 같은 배대지라도 회원 등급에 따라 최대 15% 할인이 적용됩니다. 장기 이용 예정이라면 등급별 혜택도 함께 비교하세요.
          </div>
        </section>

        {/* Section 4 (구 3) */}
        <section id="customs" className="mb-12">
          <h2 className="text-2xl font-bold text-gray-900 mb-4 pb-2 border-b">
            4. 통관 안내 및 세금
          </h2>
          <div className="space-y-4 text-gray-600">
            <div className="bg-amber-50 border border-amber-200 rounded-lg p-4">
              <p className="font-medium text-amber-900 mb-2">목록통관 vs 일반수입신고</p>
              <div className="grid sm:grid-cols-2 gap-4 text-sm">
                <div>
                  <p className="font-medium text-gray-900">목록통관</p>
                  <ul className="list-disc list-inside space-y-1 text-gray-600 mt-1">
                    <li>물품 가격 $150 이하</li>
                    <li>관세 면제</li>
                    <li>빠른 통관</li>
                    <li>미국발 $200 이하 (단, 담배/주류 제외)</li>
                  </ul>
                </div>
                <div>
                  <p className="font-medium text-gray-900">일반수입신고</p>
                  <ul className="list-disc list-inside space-y-1 text-gray-600 mt-1">
                    <li>$150 초과 시</li>
                    <li>관세 + 부가세 부과</li>
                    <li>품목별 관세율 상이</li>
                    <li>의류 13%, 전자제품 0~8%</li>
                  </ul>
                </div>
              </div>
            </div>

            <div className="text-sm space-y-2">
              <p><strong>자가사용 인정 기준:</strong> 동일 물품 6개 이하, 전체 금액 $600 이하</p>
              <p><strong>개인통관고유부호:</strong> 관세청 사이트에서 발급 (무료, 1~2분 소요)</p>
            </div>
          </div>
        </section>

        {/* Section 4 */}
        <section id="tips" className="mb-12">
          <h2 className="text-2xl font-bold text-gray-900 mb-4 pb-2 border-b">
            5. 배송비 절약 팁
          </h2>
          <div className="grid sm:grid-cols-2 gap-4">
            {[
              {
                title: '합포장 이용',
                desc: '여러 상품을 하나로 합쳐 배송하면 배송비를 크게 절약할 수 있습니다. 배대지마다 합포장 가능 박스 수를 확인하세요.',
              },
              {
                title: '오리건 센터 활용',
                desc: '미국 오리건주는 판매세(Sales Tax)가 없습니다. 오리건 센터가 있는 배대지를 이용하면 구매 단계에서 세금을 아낄 수 있습니다.',
              },
              {
                title: '무게 최적화',
                desc: '불필요한 포장재를 제거하는 재포장 서비스를 제공하는 배대지를 이용하면 실제 배송 무게를 줄일 수 있습니다.',
              },
              {
                title: '이벤트·할인 쿠폰 활용',
                desc: '각 배대지는 정기적으로 할인 이벤트를 진행합니다. 회원가입 쿠폰, 첫 배송 할인 등을 활용하세요.',
              },
            ].map((tip) => (
              <Card key={tip.title}>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm text-blue-700">💡 {tip.title}</CardTitle>
                </CardHeader>
                <CardContent className="text-sm text-gray-600">
                  {tip.desc}
                </CardContent>
              </Card>
            ))}
          </div>
        </section>

        {/* Section 5 */}
        <section id="faq" className="mb-12">
          <h2 className="text-2xl font-bold text-gray-900 mb-4 pb-2 border-b">
            6. 자주 묻는 질문
          </h2>
          <div className="space-y-4">
            {faqItems.map((item, i) => (
              <div key={i} className="border rounded-lg p-4">
                <p className="font-medium text-gray-900 mb-2">Q. {item.q}</p>
                <p className="text-sm text-gray-600">A. {item.a}</p>
              </div>
            ))}
          </div>
        </section>

        {/* CTA */}
        <div className="bg-blue-600 rounded-xl p-8 text-white text-center">
          <h2 className="text-2xl font-bold mb-3">배대지 바로 비교해보기</h2>
          <p className="text-blue-100 mb-6">무게를 입력하면 최저가 배대지를 즉시 찾아드립니다</p>
          <div className="flex justify-center gap-4 flex-wrap">
            <Button size="lg" className="bg-white text-blue-700 hover:bg-blue-50" asChild>
              <Link href="/#calculator">배송비 계산하기</Link>
            </Button>
            <Button size="lg" className="bg-transparent border-2 border-white text-white hover:bg-white/10" asChild>
              <Link href="/compare">비교표 보기</Link>
            </Button>
          </div>
        </div>
      </div>
    </div>
    </>
  )
}
