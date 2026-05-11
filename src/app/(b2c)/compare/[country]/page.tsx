import React from 'react'
import { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { supabase } from '@/lib/supabase'
import { Forwarder, ShippingRate, Country, COUNTRIES } from '@/types'
import ComparisonTable from '@/components/comparison/ComparisonTable'
import ForwarderCard from '@/components/forwarder/ForwarderCard'
import RelatedPostsBox from '@/components/blog/RelatedPostsBox'
import { getRelatedBlogsForCountry } from '@/lib/related-blog'

export const revalidate = 3600

interface Props {
  params: Promise<{ country: string }>
  searchParams?: Promise<{ [key: string]: string | string[] | undefined }>
}

const COUNTRY_META: Record<string, { competitors: string; shoppingMalls: string; faq: { q: string; a: string }[] }> = {
  JP: {
    competitors: '아라쿠·조이포스트·타배재팬·이랏샤이마세',
    shoppingMalls: '라쿠텐·야후옥션·조조타운',
    faq: [
      { q: '일본 배대지 배송비는 얼마인가요?', a: '일본 배대지 배송비는 1kg 기준 약 3,000~8,000원 수준입니다. 배대지마다 요금이 다르므로 짐스캐너에서 무게를 입력하면 20개 이상 배대지의 최저가를 즉시 비교할 수 있습니다.' },
      { q: '일본 배대지 추천은 어디인가요?', a: '2026년 기준 인기 일본 배대지로는 아라쿠, 조이포스트, 타배재팬, 이랏샤이마세, 바이니폰 등이 있습니다. 무게와 이용 빈도에 따라 최적 배대지가 달라지므로 짐스캐너에서 비교해보세요.' },
      { q: '일본 직구 배송 기간은 얼마나 걸리나요?', a: '항공 기준 통관 포함 3~7 영업일입니다. 골든위크·연말 시즌에는 1~2주 지연될 수 있습니다.' },
      { q: '일본 직구 면세 한도는 얼마인가요?', a: '일본발 상품은 $150 이하 목록통관으로 관세 면제입니다. $150 초과 시 품목별 관세율(의류 13%, 신발 13% 등)이 적용됩니다.' },
      { q: '야후옥션·메루카리도 배대지로 받을 수 있나요?', a: '네, 판매자가 배대지 주소로 발송하면 됩니다. 단 판매자가 해외 발송을 거부할 경우 구매대행 서비스를 이용해야 합니다.' },
    ],
  },
  US: {
    competitors: '짐패스·훗타운·포스트고·아이포터·몰테일',
    shoppingMalls: '아마존·나이키·이베이',
    faq: [
      { q: '미국 배대지 배송비는 얼마인가요?', a: '미국 배대지 배송비는 1kg 기준 약 10,000~18,000원 수준입니다. 배대지마다 요금이 다르므로 짐스캐너에서 무게를 입력하면 20개 이상 배대지의 최저가를 즉시 비교할 수 있습니다.' },
      { q: '미국 배대지 오리건 센터가 유리한 이유는?', a: '오리건주는 판매세(Sales Tax)가 없습니다. $200 상품 기준 타 주 대비 $10~20를 절약할 수 있습니다. 대부분의 배대지에서 오리건 센터를 제공합니다.' },
      { q: '미국 배대지 추천은 어디인가요?', a: '2026년 기준 인기 미국 배대지로는 짐패스, 훗타운, 포스트고, 아이포터, 몰테일 등이 있습니다. 무게와 발송 빈도에 따라 최적 배대지가 달라지므로 짐스캐너에서 비교해보세요.' },
      { q: '미국 직구 면세 한도는 얼마인가요?', a: '미국발 상품은 $200 이하 목록통관으로 관세 면제입니다. $200 초과 시 간이세율 또는 정식 수입신고가 필요합니다.' },
      { q: '미국 배대지 배송 기간은 얼마나 걸리나요?', a: '미국 내 배송 3~5일 + 한국 통관·배송 2~5일 = 총 5~10 영업일 소요됩니다. 블랙프라이데이·크리스마스 시즌에는 1~2주 추가될 수 있습니다.' },
    ],
  },
  CN: {
    competitors: '차이나로드·이지타오·포스트고·짐패스',
    shoppingMalls: '타오바오·1688·징동',
    faq: [
      { q: '중국 배대지 배송비는 얼마인가요?', a: '중국 배대지 배송비는 1kg 기준 약 5,000~12,000원 수준입니다. 짐스캐너에서 무게를 입력하면 실시간 최저가를 비교할 수 있습니다.' },
      { q: '중국 직구 면세 한도는 얼마인가요?', a: '$150 이하 목록통관으로 관세 면제입니다. $150 초과 시 품목별 관세가 부과됩니다.' },
      { q: '타오바오 주문 시 배대지만으로 가능한가요?', a: '타오바오는 배대지 주소로 발송이 가능합니다. 다만 판매자 교신이 중국어로 이루어지므로 구매대행 서비스를 함께 이용하는 것이 편리합니다.' },
    ],
  },
}

// 국가 특화 추가 hook (US만 해당)
const COUNTRY_HOOK: Record<string, string> = {
  US: ' (오리건 무세금 센터 포함)',
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { country } = await params
  const code = country.toUpperCase()
  const countryInfo = COUNTRIES.find((c) => c.code === code)
  if (!countryInfo) return {}
  const meta = COUNTRY_META[code]
  const cName = countryInfo.name

  // 데이터 기반 가격·배대지 수 (검색자에게 즉시 가치 신호)
  // 실시간 환율(한국수출입은행 매매기준율)로 원천 통화 환산
  const { getCurrentRates, computeKrw } = await import('@/lib/current-rates')
  const currentRates = await getCurrentRates()
  const { data: ratesData } = await supabase
    .from('shipping_rates')
    .select('forwarder_id, weight_min, weight_max, price_krw, price_usd, price_jpy, price_cny')
    .eq('country', code)
    .eq('grade_level', 1)

  const norm = (r: {
    price_krw: number | null
    price_usd: number | null
    price_jpy: number | null
    price_cny: number | null
  }) => computeKrw(r, currentRates)
  const pricesAt = (kg: number) =>
    (ratesData ?? [])
      .filter((r) => r.weight_min <= kg && r.weight_max >= kg)
      .map(norm)
      .filter((p): p is number => p !== null)

  const at1kg = pricesAt(1)
  const at5kg = pricesAt(5)
  const min1kg = at1kg.length > 0 ? Math.min(...at1kg) : null
  const min5kg = at5kg.length > 0 ? Math.min(...at5kg) : null
  const forwarderCount = new Set((ratesData ?? []).map((r) => r.forwarder_id)).size
  const countDisplay = forwarderCount >= 5 ? `${forwarderCount}곳` : '20곳+'
  const hook = COUNTRY_HOOK[code] ?? ''

  // 동적 title: 검색자 의도 직접 응답 ("얼마야?" → 최저가 숫자)
  const priceHook = min1kg ? ` — 1kg 최저 ${min1kg.toLocaleString()}원` : ''
  const title = `${cName} 배대지 ${countDisplay} 가격 비교 2026${priceHook}${hook}`

  // 동적 description: 숫자 + 경쟁사 + 쇼핑몰 + 행동
  const priceLine = min1kg
    ? `1kg 최저 ${min1kg.toLocaleString()}원${min5kg ? `, 5kg 최저 ${min5kg.toLocaleString()}원` : ''}부터.`
    : ''
  const competitors = meta?.competitors ?? ''
  const malls = meta?.shoppingMalls ?? ''
  const description = [
    `${cName} 배대지 ${countDisplay}을 무게별로 한 번에 비교.`,
    priceLine,
    competitors ? `${competitors} 등 2026년 최신 요금.` : '',
    malls ? `${malls} 직구 최적화.` : '',
    '무료 즉시 비교.',
  ]
    .filter(Boolean)
    .join(' ')

  return {
    title,
    description,
    alternates: {
      canonical: `https://www.jimscanner.co.kr/compare/${country.toLowerCase()}`,
    },
    openGraph: {
      title,
      description,
      url: `https://www.jimscanner.co.kr/compare/${country.toLowerCase()}`,
    },
  }
}

export function generateStaticParams() {
  return [{ country: 'us' }, { country: 'jp' }, { country: 'cn' }]
}

// ─────────────────────────────────────────────
// 국가별 SEO 가이드 컴포넌트
// ─────────────────────────────────────────────

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="text-2xl font-bold text-gray-900 mb-6 pb-2 border-b">{children}</h2>
  )
}

function FaqItem({ q, a }: { q: string; a: string }) {
  return (
    <div className="border rounded-lg p-4">
      <p className="font-medium text-gray-900 mb-2">Q. {q}</p>
      <p className="text-sm text-gray-600 leading-relaxed">A. {a}</p>
    </div>
  )
}

function JpGuideSection() {
  return (
    <div className="space-y-10">
      {/* 일본 직구 인기 쇼핑몰 */}
      <section>
        <SectionTitle>일본 직구 인기 쇼핑몰</SectionTitle>
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {[
            {
              name: 'Amazon Japan',
              url: 'amazon.co.jp',
              desc: '아마존 재팬. 전자제품·도서·일용품. 한국 직배송 가능 상품도 있으나 대부분 배대지 필요.',
            },
            {
              name: 'Rakuten',
              url: 'rakuten.co.jp',
              desc: '라쿠텐 이치바. 일본 최대 오픈마켓. 식품·패션·브랜드 상품 다양. 포인트 적립 강점.',
            },
            {
              name: 'Yahoo! Japan Auction',
              url: 'auctions.yahoo.co.jp',
              desc: '야후 재팬 옥션. 빈티지·피규어·중고 명품·한정판 상품 강점. 구매대행 서비스 활용 추천.',
            },
            {
              name: 'Mercari Japan',
              url: 'mercari.com/jp',
              desc: '메루카리. 일본판 당근마켓. 중고 의류·잡화·게임. 개인 간 거래라 배대지+구매대행 필요.',
            },
            {
              name: 'ZOZOTOWN',
              url: 'zozo.jp',
              desc: '조조타운. 일본 최대 패션 플랫폼. 국내 미출시 브랜드, 사이즈 다양. 해외 배송 불가 → 배대지 필수.',
            },
            {
              name: 'Qoo10 Japan',
              url: 'qoo10.jp',
              desc: 'Q10 재팬. 한국·일본 상품 혼재. 코스메틱·식품·패션. 일부 상품 한국 직배 가능.',
            },
          ].map((site) => (
            <div key={site.name} className="border rounded-lg p-4 bg-gray-50">
              <p className="font-semibold text-gray-900 text-sm">{site.name}</p>
              <p className="text-xs text-blue-600 mb-2">{site.url}</p>
              <p className="text-xs text-gray-600 leading-relaxed">{site.desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* 일본 배대지 선택 기준 */}
      <section>
        <SectionTitle>일본 배대지 선택 기준</SectionTitle>
        <div className="grid sm:grid-cols-2 gap-4 text-sm text-gray-600">
          {[
            {
              title: '📍 센터 위치',
              desc: '도쿄(東京), 오사카(大阪), 사이타마(埼玉) 등 주요 센터 위치 확인. 센터가 구매 예정 쇼핑몰과 가까울수록 국내 배송비 절약.',
            },
            {
              title: '⚖️ 무게 계산 방식',
              desc: '실무게 vs 부피무게 중 큰 값 적용. 부피가 큰 상품(쿠션, 가전 등)은 부피무게가 더 나올 수 있음. 배대지별 계산 방식 사전 확인 필요.',
            },
            {
              title: '📦 합포장 서비스',
              desc: '여러 건의 주문을 하나로 묶어 배송. 일본 배송 시 가장 효과적인 절약 방법. 합포장 가능 박스 수와 무료 여부 확인.',
            },
            {
              title: '🔍 검수 서비스',
              desc: '제품 상태 사진 촬영·확인 서비스. 중고품, 한정판 구매 시 중요. 유료/무료 여부와 촬영 장수 확인.',
            },
            {
              title: '🛡️ 무료 보관 기간',
              desc: '입고 후 배송 신청 전까지 무료 보관 가능 기간. 30~60일이 일반적. 합포장 대기 시 중요한 요소.',
            },
            {
              title: '💰 엔화 결제 여부',
              desc: '일본 배대지 이용 시 배송비를 원화로 결제. 일부 배대지는 엔화 기반 요금표로 환율 영향 받음.',
            },
          ].map((item) => (
            <div key={item.title} className="border rounded-lg p-4">
              <p className="font-medium text-gray-900 mb-1">{item.title}</p>
              <p className="leading-relaxed">{item.desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* 일본 배대지 FAQ */}
      <section>
        <SectionTitle>일본 배대지 자주 묻는 질문</SectionTitle>
        <div className="space-y-3">
          <FaqItem
            q="일본 배대지 배송 기간은 얼마나 걸리나요?"
            a="항공(에어) 기준 통관 포함 3~7 영업일이 일반적입니다. 시즌(연말·골든위크 등)이나 검역 상황에 따라 지연될 수 있습니다. 선박(EMS/SAL) 이용 시 2~4주 소요됩니다."
          />
          <FaqItem
            q="야후옥션 같은 개인 간 거래 상품도 배대지로 받을 수 있나요?"
            a="야후옥션·메루카리 등 개인 간 거래 플랫폼은 낙찰 후 판매자가 배대지 주소로 발송하면 됩니다. 단, 판매자가 해외 발송을 거부하는 경우 구매대행 서비스를 함께 이용해야 합니다."
          />
          <FaqItem
            q="일본 배대지 배송비는 어떻게 계산되나요?"
            a="실무게(kg)와 부피무게(가로×세로×높이÷5000) 중 더 무거운 값으로 계산됩니다. 대부분 500g 단위로 요금이 올라가며, 짐스캐너에서 무게 입력 시 실시간으로 비교할 수 있습니다."
          />
          <FaqItem
            q="일본 직구 관세 면세 기준은 얼마인가요?"
            a="일본발 상품은 물품 가격이 $150(미화) 이하이면 목록통관으로 관세가 면제됩니다. 단, 담배·주류·한약재는 금액과 무관하게 일반수입신고가 필요합니다. $150 초과 시 품목별 관세율이 적용됩니다(의류 13%, 신발 13%, 전자제품 0~8%)."
          />
          <FaqItem
            q="ZOZOTOWN 구매 시 주의사항이 있나요?"
            a="조조타운은 해외 직배송을 지원하지 않습니다. 배대지 주소로 주문 후 한국으로 재발송해야 합니다. 사이즈는 일본 기준이므로 한국 사이즈보다 1~2 사이즈 큰 것을 선택하는 경우가 많습니다."
          />
          <FaqItem
            q="일본 배대지와 미국 배대지 중 어느 게 더 저렴한가요?"
            a="일반적으로 일본이 더 저렴합니다. 거리가 가까워 kg당 배송비가 낮고, 1kg 미만 소형 상품의 경우 일본이 더욱 유리합니다. 다만 상품 가격 자체는 미국 아마존이 저렴한 경우도 많으므로 총 비용을 비교해보세요."
          />
        </div>
      </section>
    </div>
  )
}

function UsGuideSection() {
  return (
    <div className="space-y-10">
      {/* 미국 직구 인기 쇼핑몰 */}
      <section>
        <SectionTitle>미국 직구 인기 쇼핑몰</SectionTitle>
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {[
            {
              name: 'Amazon US',
              url: 'amazon.com',
              desc: '아마존 미국. 가장 많이 이용하는 직구 쇼핑몰. 프라임 회원은 미국 내 배송 무료. 일부 상품만 한국 직배 가능.',
            },
            {
              name: 'eBay',
              url: 'ebay.com',
              desc: '이베이. 새 상품·중고·빈티지·한정판. 경매와 즉시구매 방식. 한국 직배 상품도 일부 있음.',
            },
            {
              name: 'Nike / Adidas US',
              url: 'nike.com / adidas.com',
              desc: '나이키·아디다스 미국 공홈. 한국 미출시 색상·사이즈 구매 가능. 멤버십 할인 적용.',
            },
            {
              name: 'Best Buy',
              url: 'bestbuy.com',
              desc: '베스트바이. 전자제품·가전·게임. 미국 가격이 국내 대비 30~50% 저렴한 경우 많음.',
            },
            {
              name: 'Costco US',
              url: 'costco.com',
              desc: '코스트코 미국. 건강식품·보충제·생활용품 대량 구매. 멤버십 없어도 일부 온라인 주문 가능.',
            },
            {
              name: 'iHerb',
              url: 'iherb.com',
              desc: '아이허브. 건강보조식품·비타민·유기농 제품 전문. 한국 직배송 지원 (배대지 불필요).',
            },
          ].map((site) => (
            <div key={site.name} className="border rounded-lg p-4 bg-gray-50">
              <p className="font-semibold text-gray-900 text-sm">{site.name}</p>
              <p className="text-xs text-blue-600 mb-2">{site.url}</p>
              <p className="text-xs text-gray-600 leading-relaxed">{site.desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* 미국 배대지 센터별 차이 */}
      <section>
        <SectionTitle>미국 배대지 센터 위치별 특징</SectionTitle>
        <div className="grid sm:grid-cols-2 gap-4 text-sm">
          {[
            {
              state: '오리건 (Oregon, OR)',
              badge: '무세금',
              badgeColor: 'bg-green-100 text-green-700',
              desc: '주 판매세(Sales Tax) 없음. 고가 상품 구매 시 5~10% 절약 가능. 대부분의 배대지에서 지원.',
            },
            {
              state: '델라웨어 (Delaware, DE)',
              badge: '무세금',
              badgeColor: 'bg-green-100 text-green-700',
              desc: '주 판매세 없음. 동부 기반 쇼핑몰(이베이, 브랜드 직영몰) 이용 시 빠른 배송.',
            },
            {
              state: '뉴저지 (New Jersey, NJ)',
              badge: '동부 허브',
              badgeColor: 'bg-blue-100 text-blue-700',
              desc: '미국 동부 물류 허브. NYC 인접. 아마존·패션 브랜드 동부 창고와 가까워 내륙 배송 빠름.',
            },
            {
              state: '캘리포니아 (California, CA)',
              badge: '서부 허브',
              badgeColor: 'bg-orange-100 text-orange-700',
              desc: '서부 대형 쇼핑몰 물류 접근성 좋음. 판매세 있으나 특정 브랜드 직영몰 위치상 유리.',
            },
          ].map((item) => (
            <div key={item.state} className="border rounded-lg p-4">
              <div className="flex items-center gap-2 mb-2">
                <p className="font-medium text-gray-900">{item.state}</p>
                <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${item.badgeColor}`}>{item.badge}</span>
              </div>
              <p className="text-gray-600 leading-relaxed">{item.desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* 미국 배대지 FAQ */}
      <section>
        <SectionTitle>미국 배대지 자주 묻는 질문</SectionTitle>
        <div className="space-y-3">
          <FaqItem
            q="미국 배대지 배송 기간은 얼마나 걸리나요?"
            a="항공 기준 미국 내 배송(3~5일) + 한국 통관 및 배송(2~5일) = 총 5~10 영업일 소요됩니다. 블랙프라이데이·크리스마스 시즌에는 미국 내 배송 지연으로 추가 1~2주 걸릴 수 있습니다."
          />
          <FaqItem
            q="오리건 센터를 이용하면 세금을 얼마나 절약하나요?"
            a="미국 판매세는 주마다 다르며 평균 6~10% 수준입니다. 예를 들어 $200 상품을 캘리포니아(판매세 7.25%)로 주문하면 $14.5 세금이 붙지만, 오리건 센터 이용 시 이 세금이 면제됩니다. 고가 상품일수록 절약 효과가 큽니다."
          />
          <FaqItem
            q="미국 직구 면세 한도는 얼마인가요?"
            a="미국발 상품은 $200 이하이면 목록통관으로 관세가 면제됩니다(2024년 기준). $200~$2,000는 간이세율 적용, $2,000 초과는 정식 수입신고가 필요합니다. 단, 담배·주류는 별도 규정이 적용됩니다."
          />
          <FaqItem
            q="합포장 시 실제로 얼마나 절약되나요?"
            a="예를 들어 500g 상품 3개를 각각 배송하면 약 4만~6만원이 들지만, 합포장하면 1.5kg 1박스로 묶어 2만~3만원으로 줄일 수 있습니다. 상품 수가 많을수록 절약폭이 커집니다."
          />
        </div>
      </section>
    </div>
  )
}

function CnGuideSection() {
  return (
    <div className="space-y-10">
      {/* 중국 직구 인기 쇼핑몰 */}
      <section>
        <SectionTitle>중국 직구 인기 쇼핑몰</SectionTitle>
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {[
            {
              name: '타오바오 (淘宝)',
              url: 'taobao.com',
              desc: '중국 최대 C2C 오픈마켓. 저렴한 의류·잡화. 개인 간 거래로 구매대행 서비스 활용 추천.',
            },
            {
              name: '1688',
              url: '1688.com',
              desc: '알리바바 B2B 도매 플랫폼. 최저가 대량 구매 가능. 소량 구매 시 구매대행 필요.',
            },
            {
              name: '징동 (京东, JD)',
              url: 'jd.com',
              desc: '징동닷컴. 정품 전자제품·가전 전문. 신속한 배송. 정품 보장이 강점.',
            },
            {
              name: '알리익스프레스',
              url: 'aliexpress.com',
              desc: '알리익스프레스. 한국 직배송 지원. 배대지 없이 이용 가능. 배송 기간 2~4주.',
            },
            {
              name: '핀둬둬 (拼多多)',
              url: 'pinduoduo.com',
              desc: '공동구매 기반 초저가 플랫폼. 중국 현지 주소 필요 → 배대지 또는 구매대행 필수.',
            },
            {
              name: '테무 (Temu)',
              url: 'temu.com',
              desc: '테무. 한국 직배송 지원. 배대지 불필요하나, 반품·교환은 배대지 경유 가능.',
            },
          ].map((site) => (
            <div key={site.name} className="border rounded-lg p-4 bg-gray-50">
              <p className="font-semibold text-gray-900 text-sm">{site.name}</p>
              <p className="text-xs text-blue-600 mb-2">{site.url}</p>
              <p className="text-xs text-gray-600 leading-relaxed">{site.desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* 중국 배대지 FAQ */}
      <section>
        <SectionTitle>중국 배대지 자주 묻는 질문</SectionTitle>
        <div className="space-y-3">
          <FaqItem
            q="중국 배대지 배송 기간은 얼마나 걸리나요?"
            a="항공 기준 3~7 영업일입니다. 중국은 한국과 가까워 일본보다 빠른 경우도 있습니다. 해상 배송 이용 시 2~4주 걸리지만 대량 구매 시 비용이 크게 줄어듭니다."
          />
          <FaqItem
            q="중국 직구 면세 한도는 얼마인가요?"
            a="중국발 상품도 $150 이하는 목록통관으로 관세 면제입니다. $150 초과 시 품목별 관세 + 부가세가 부과됩니다. 타오바오·1688 이용 시 가격 신고를 정확히 해야 통관 지연을 방지할 수 있습니다."
          />
          <FaqItem
            q="타오바오 주문 시 배대지만으로 가능한가요?"
            a="타오바오는 중국 내 주소(배대지 주소)로 발송이 가능합니다. 다만 판매자 선택·교신·반품 처리 등이 중국어로 이루어져 구매대행 서비스를 함께 이용하는 것이 편리합니다."
          />
        </div>
      </section>
    </div>
  )
}

type CompareReviewSummaryRow = {
  forwarder_id: string
  review_count: number
  overall_sentiment: import('@/types').ReviewSentiment | null
}

async function getData(country: Country) {
  const [forwardersResult, ratesResult, reviewSummariesResult] = await Promise.all([
    supabase.from('forwarders').select('*').eq('is_active', true).order('name'),
    supabase.from('shipping_rates').select('*').eq('country', country).order('weight_min'),
    (supabase as unknown as { from: (t: string) => ReturnType<typeof supabase.from> })
      .from('jimscanner_forwarder_review_summary')
      .select('forwarder_id, review_count, overall_sentiment')
      .eq('country', country),
  ])
  const rateRows = (ratesResult.data as ShippingRate[]) || []
  let dataUpdatedAt: string | null = null
  for (const r of rateRows) {
    if (r.updated_at && (!dataUpdatedAt || r.updated_at > dataUpdatedAt)) dataUpdatedAt = r.updated_at
  }
  return {
    forwarders: (forwardersResult.data as Forwarder[]) || [],
    rates: rateRows,
    dataUpdatedAt,
    reviewSummaries: ((reviewSummariesResult.data ?? []) as unknown as CompareReviewSummaryRow[]),
  }
}

export default async function CountryComparePage({ params, searchParams }: Props) {
  const { country } = await params
  const sp = (await searchParams) ?? {}
  const countryCode = country.toUpperCase() as Country

  const rawGrade = Number(Array.isArray(sp.grade) ? sp.grade[0] : sp.grade)
  const initialGrade = rawGrade === 2 || rawGrade === 3 ? (rawGrade as 1 | 2 | 3) : 1
  const rawWeight = Number(Array.isArray(sp.weight) ? sp.weight[0] : sp.weight)
  const initialWeight = Number.isFinite(rawWeight) && rawWeight > 0 && rawWeight <= 30 ? rawWeight : 1

  if (!['US', 'JP', 'CN'].includes(countryCode)) {
    notFound()
  }

  const countryInfo = COUNTRIES.find((c) => c.code === countryCode)!
  const [{ forwarders, rates, dataUpdatedAt, reviewSummaries }, currentRates, relatedPosts] =
    await Promise.all([
      getData(countryCode),
      (await import('@/lib/current-rates')).getCurrentRates(),
      getRelatedBlogsForCountry(countryCode, 3),
    ])

  const getReviewMeta = (forwarderId: string) => {
    const row = reviewSummaries.find((r) => r.forwarder_id === forwarderId)
    return {
      sentiment: row?.overall_sentiment ?? null,
      count: row?.review_count ?? null,
    }
  }

  const activeForwarders = forwarders.filter((f) =>
    rates.some((r) => r.forwarder_id === f.id)
  )

  const { computeKrw } = await import('@/lib/current-rates')
  const getMinPrice = (forwarderId: string) => {
    const forwarderRates = rates.filter((r) => r.forwarder_id === forwarderId)
    if (forwarderRates.length === 0) return null
    const prices = forwarderRates
      .map((r) => computeKrw(r, currentRates))
      .filter((p): p is number => p !== null && p > 0)
    return prices.length > 0 ? Math.min(...prices) : null
  }

  const breadcrumbSchema = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "홈", item: "https://www.jimscanner.co.kr" },
      { "@type": "ListItem", position: 2, name: "배대지 비교", item: "https://www.jimscanner.co.kr/compare" },
      { "@type": "ListItem", position: 3, name: `${countryInfo.name} 배대지 비교`, item: `https://www.jimscanner.co.kr/compare/${country}` },
    ],
  }

  const metaFaq = COUNTRY_META[countryCode]?.faq ?? []
  const faqSchema = metaFaq.length > 0 ? {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: metaFaq.map((item) => ({
      "@type": "Question",
      name: item.q,
      acceptedAnswer: { "@type": "Answer", text: item.a },
    })),
  } : null

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(breadcrumbSchema) }}
      />
      {faqSchema && (
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(faqSchema) }}
        />
      )}
    <div className="py-12 px-4">
      <div className="container mx-auto max-w-6xl">
        <div className="mb-8">
          <div className="flex items-center gap-3 mb-2">
            <span className="text-4xl">{countryInfo.flag}</span>
            <h1 className="text-3xl font-bold text-gray-900">
              {countryInfo.name} 배대지 배송비 비교
            </h1>
          </div>
          <p className="text-gray-600 text-lg">
            {activeForwarders.length}개 배대지의 {countryInfo.name} 배송비를 무게별로 즉시 비교하세요.
            {countryCode === 'US' && ' 오리건·델라웨어 무세금 센터 포함.'}
            {countryCode === 'JP' && ' 합포장·검수 서비스 정보 포함.'}
            {countryCode === 'CN' && ' 타오바오·1688 직구 최적화.'}
          </p>
        </div>

        {/* Comparison Table */}
        <div className="mb-12">
          <ComparisonTable
            forwarders={forwarders}
            rates={rates}
            defaultCountry={countryCode}
            syncUrl
            initialGrade={initialGrade}
            initialWeight={initialWeight}
            currencyRates={currentRates}
            dataUpdatedAt={dataUpdatedAt}
          />
        </div>

        {/* Forwarder Cards */}
        <div>
          <h2 className="text-2xl font-bold text-gray-900 mb-6">
            {countryInfo.name} 배대지 목록
          </h2>
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-6">
            {activeForwarders.map((forwarder) => {
              const review = getReviewMeta(forwarder.id)
              return (
                <ForwarderCard
                  key={forwarder.id}
                  forwarder={forwarder}
                  minPrice={getMinPrice(forwarder.id)}
                  country={countryInfo.name}
                  reviewSentiment={review.sentiment}
                  reviewCount={review.count}
                />
              )
            })}
          </div>
        </div>

        {/* 관련 블로그 가이드 */}
        <div className="mt-12">
          <RelatedPostsBox
            posts={relatedPosts}
            title={`📘 ${countryInfo.name} 직구 · 배대지 가이드`}
            subtitle={`${countryInfo.name} 배대지 선택과 직구 실전 팁을 담은 짐스캐너 블로그`}
          />
        </div>

        {/* SEO Content — 국가별 상세 가이드 */}
        <div className="mt-16 space-y-10">
          {countryCode === 'JP' && <JpGuideSection />}
          {countryCode === 'US' && <UsGuideSection />}
          {countryCode === 'CN' && <CnGuideSection />}
        </div>
      </div>
    </div>
    </>
  )
}
