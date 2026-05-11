import { Metadata } from 'next'
import { notFound } from 'next/navigation'
import Link from 'next/link'
import { supabase } from '@/lib/supabase'
import {
  Forwarder,
  ShippingRate,
  Center,
  MemberGradeDefinition,
  AdditionalService,
  COUNTRIES,
  type ForwarderReview,
  type ForwarderReviewSummary,
  type Country,
} from '@/types'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import MemberGradeTable from '@/components/forwarder/MemberGradeTable'
import ForwarderContentSections from '@/components/forwarder/ForwarderContentSections'
import ExternalLink from '@/components/analytics/ExternalLink'
import { MapView, type MapPin } from '@/components/map/MapView'
import { josa } from '@/lib/josa'
import type { ForwarderContent } from '@/lib/forwarder-content'
import { getCurrentRates, computeKrw } from '@/lib/current-rates'
import RealTimeRateBadge from '@/components/exchange/RealTimeRateBadge'
import ServiceCTA from '@/components/layout/ServiceCTA'
import LastVerifiedBadge from '@/components/forwarder/LastVerifiedBadge'
import { getLastVerifiedMap } from '@/lib/last-verified'
import RelatedPostsBox from '@/components/blog/RelatedPostsBox'
import { getRelatedBlogsForForwarder } from '@/lib/related-blog'
import ReportButton from '@/components/reports/ReportButton'
import ResolutionBadge from '@/components/reports/ResolutionBadge'
import ForwarderReviews from '@/components/forwarder/ForwarderReviews'

export const revalidate = 3600

interface Props {
  params: Promise<{ slug: string }>
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params
  const { data: forwarder } = await supabase
    .from('forwarders')
    .select('*')
    .eq('slug', slug)
    .single()

  if (!forwarder) return {}

  const { data: rates } = await supabase
    .from('shipping_rates')
    .select('country, weight_min, weight_max, price_krw, price_usd, price_jpy, price_cny, grade_level')
    .eq('forwarder_id', forwarder.id)
    .eq('grade_level', 1)
    .order('weight_min')
    .limit(10)

  const countries = [...new Set((rates ?? []).map((r) => r.country))]
  const countryNames: Record<string, string> = { US: '미국', JP: '일본', CN: '중국' }
  const countrySummary = countries.map((c) => countryNames[c] || c).join('·')

  const usRate = (rates ?? []).find((r) => r.country === 'US' && r.weight_min <= 1 && r.weight_max >= 1)
  const jpRate = (rates ?? []).find((r) => r.country === 'JP' && r.weight_min <= 1 && r.weight_max >= 1)
  const cnRate = (rates ?? []).find((r) => r.country === 'CN' && r.weight_min <= 1 && r.weight_max >= 1)

  // 요금 숫자를 title에 직접 노출 → 클릭률 향상
  const priceParts: string[] = []
  if (usRate?.price_krw) priceParts.push(`미국 1kg ${usRate.price_krw.toLocaleString()}원`)
  else if (usRate?.price_usd) priceParts.push(`미국 1kg $${usRate.price_usd}`)
  if (jpRate?.price_krw) priceParts.push(`일본 1kg ${jpRate.price_krw.toLocaleString()}원`)
  else if (jpRate?.price_usd) priceParts.push(`일본 1kg $${jpRate.price_usd}`)
  if (cnRate?.price_krw) priceParts.push(`중국 1kg ${cnRate.price_krw.toLocaleString()}원`)

  const priceInTitle = priceParts.length > 0 ? ` | ${priceParts[0]}` : ''
  const priceSummary = priceParts.length > 0 ? ` ${priceParts.join(', ')}부터.` : ''

  // 주요 활동 국가 식별 (요금 데이터가 가장 많은 국가)
  const countryCount = (rates ?? []).reduce<Record<string, number>>((acc, r) => {
    acc[r.country] = (acc[r.country] ?? 0) + 1
    return acc
  }, {})
  const primaryCountry = Object.entries(countryCount).sort((a, b) => b[1] - a[1])[0]?.[0]
  const primaryCountryLabel = primaryCountry ? countryNames[primaryCountry] ?? primaryCountry : ''

  // 주요 국가 1kg 기준 랭킹 계산 (브랜드 검색자에게 비교 가치 제시)
  // 실시간 환율(한국수출입은행 매매기준율)로 환산
  const currentRatesForMeta = await getCurrentRates()
  let rankInfo: { total: number; cheaperCount: number } | null = null
  if (primaryCountry) {
    const { data: allRates } = await supabase
      .from('shipping_rates')
      .select('forwarder_id, price_krw, price_usd, price_jpy, price_cny')
      .eq('country', primaryCountry)
      .eq('grade_level', 1)
      .lte('weight_min', 1)
      .gte('weight_max', 1)

    const byForwarder = new Map<string, number>()
    for (const r of allRates ?? []) {
      if (!r.forwarder_id) continue
      const p = computeKrw(r, currentRatesForMeta)
      if (p === null) continue
      const prev = byForwarder.get(r.forwarder_id)
      if (prev === undefined || p < prev) byForwarder.set(r.forwarder_id, p)
    }
    const sorted = [...byForwarder.entries()].sort((a, b) => a[1] - b[1])
    const myIdx = sorted.findIndex(([id]) => id === forwarder.id)
    // 최소 3곳 비교 대상이 있을 때만 랭킹 문구 노출
    if (myIdx !== -1 && sorted.length >= 3) {
      rankInfo = { total: sorted.length, cheaperCount: myIdx }
    }
  }

  // 차별화 문구 (기존 브랜드 검색 캡처 유지 + 비교 가치 hook 추가)
  let differentiator = ''
  let descHook = ''
  if (rankInfo) {
    if (rankInfo.cheaperCount === 0) {
      differentiator = ` · 배대지 ${rankInfo.total}곳 중 최저가`
      descHook = ` ${forwarder.name} 요금이 ${primaryCountryLabel} 1kg 기준 배대지 ${rankInfo.total}곳 중 최저가입니다.`
    } else {
      differentiator = ` · 더 싼 배대지 ${rankInfo.cheaperCount}곳`
      descHook = ` ${forwarder.name}보다 저렴한 ${primaryCountryLabel} 배대지 ${rankInfo.cheaperCount}곳을 같은 조건에서 비교 가능합니다.`
    }
  } else {
    // 랭킹 산출 불가 시 기존 패턴 유지
    descHook =
      countries.includes('US') && countries.includes('JP')
        ? ' 짐패스·훗타운·포스트고 등과 비교.'
        : countries.includes('US')
        ? ' 짐패스·훗타운·포스트고와 비교.'
        : countries.includes('JP')
        ? ' 아라쿠·조이포스트·타배재팬과 비교.'
        : ' 다른 배대지와 비교.'
  }

  const BASE_URL = 'https://jimscanner.co.kr'

  return {
    title: `${forwarder.name} 배송비 2026${differentiator}${priceInTitle}`,
    description: `${forwarder.name} ${countrySummary} 배송비를 무게별로 한눈에 확인하세요.${priceSummary}${descHook} 짐스캐너에서 30개+ 배대지 무료 즉시 비교.`,
    alternates: {
      canonical: `${BASE_URL}/forwarders/${slug}`,
    },
    openGraph: {
      title: `${forwarder.name} 배송비 2026${differentiator}`,
      description: `${forwarder.name} ${countrySummary} 배송비를 무게별로 비교하세요.${priceSummary}${descHook}`,
      url: `${BASE_URL}/forwarders/${slug}`,
    },
  }
}

export async function generateStaticParams() {
  const { data } = await supabase.from('forwarders').select('slug').eq('is_active', true)
  return (data ?? []).map((f) => ({ slug: f.slug }))
}

async function getData(slug: string) {
  const { data: forwarder, error } = await supabase
    .from('forwarders')
    .select('*')
    .eq('slug', slug)
    .single()

  if (error || !forwarder) return null

  const [ratesResult, centersResult, gradeDefsResult, allForwardersResult, allRatesResult, contentResult, servicesResult, reviewSummariesResult, reviewsResult] = await Promise.all([
    supabase
      .from('shipping_rates')
      .select('*')
      .eq('forwarder_id', forwarder.id)
      .order('country')
      .order('grade_level')
      .order('weight_min'),
    supabase
      .from('centers')
      .select('*')
      .eq('forwarder_id', forwarder.id),
    supabase
      .from('member_grade_definitions')
      .select('*')
      .eq('forwarder_id', forwarder.id)
      .order('grade_level'),
    // 관련 배대지 비교 섹션용
    supabase
      .from('forwarders')
      .select('id, name, slug, description')
      .eq('is_active', true)
      .neq('id', forwarder.id),
    supabase
      .from('shipping_rates')
      .select('forwarder_id, country, weight_min, weight_max, price_krw, price_usd, price_jpy, price_cny, service_label, grade_level')
      .eq('grade_level', 1)
      .order('weight_min'),
    supabase
      .from('jimscanner_forwarder_content')
      .select('*')
      .eq('forwarder_id', forwarder.id)
      .eq('status', 'published')
      .maybeSingle(),
    supabase
      .from('forwarder_additional_services')
      .select('*')
      .eq('forwarder_id', forwarder.id)
      .eq('is_active', true)
      .order('category')
      .order('display_order'),
    // 후기 요약/개별 — generated supabase 타입에 신규 테이블이 없어 from(any) 캐스트
    (supabase as unknown as { from: (t: string) => ReturnType<typeof supabase.from> })
      .from('jimscanner_forwarder_review_summary')
      .select('*')
      .eq('forwarder_id', forwarder.id),
    (supabase as unknown as { from: (t: string) => ReturnType<typeof supabase.from> })
      .from('jimscanner_forwarder_reviews')
      .select('*')
      .eq('forwarder_id', forwarder.id)
      .eq('is_hidden', false),
  ])

  return {
    forwarder: forwarder as Forwarder,
    rates: (ratesResult.data as ShippingRate[]) || [],
    centers: (centersResult.data as Center[]) || [],
    gradeDefinitions: (gradeDefsResult.data as MemberGradeDefinition[]) || [],
    allForwarders: (allForwardersResult.data as Pick<Forwarder, 'id' | 'name' | 'slug' | 'description'>[]) || [],
    allRates: (allRatesResult.data as ShippingRate[]) || [],
    content: (contentResult.data as ForwarderContent | null) ?? null,
    services: (servicesResult.data as AdditionalService[]) || [],
    reviewSummaries: ((reviewSummariesResult.data ?? []) as unknown as ForwarderReviewSummary[]),
    reviews: ((reviewsResult.data ?? []) as unknown as ForwarderReview[]),
  }
}

const STATE_LABEL: Record<string, string> = {
  NJ: '뉴저지',
  OR: '오리건',
  CA: '캘리포니아',
  DE: '델라웨어',
}

export default async function ForwarderDetailPage({ params }: Props) {
  const { slug } = await params
  const data = await getData(slug)

  if (!data) notFound()

  const { forwarder, rates, centers, gradeDefinitions, allForwarders, allRates, content, services, reviewSummaries, reviews } = data

  const countries = [...new Set(rates.map((r) => r.country))]
  const currentRates = await getCurrentRates()
  const lastVerifiedMap = await getLastVerifiedMap()
  const lastVerifiedAt = lastVerifiedMap.get(forwarder.id) ?? null
  const relatedPosts = await getRelatedBlogsForForwarder(
    { slug: forwarder.slug, name: forwarder.name },
    countries,
    3,
  )

  // 국가별 1kg 순위·가격 계산 (Hero 요약 카드용) — 실시간 환율 기반
  const computeCountryRank = (country: string) => {
    const candidates = allRates.filter(
      (r) => r.country === country && r.weight_min <= 1 && r.weight_max >= 1
    )
    const byForwarder = new Map<string, number>()
    for (const r of candidates) {
      const p = computeKrw(r, currentRates)
      if (p === null) continue
      const prev = byForwarder.get(r.forwarder_id)
      if (prev === undefined || p < prev) byForwarder.set(r.forwarder_id, p)
    }
    const sorted = [...byForwarder.entries()].sort((a, b) => a[1] - b[1])
    const myIdx = sorted.findIndex(([id]) => id === forwarder.id)
    if (myIdx === -1) return null
    return { rank: myIdx + 1, total: sorted.length, myPrice: sorted[myIdx][1] }
  }
  const countryRanks = countries
    .map((c) => ({ country: c, ...computeCountryRank(c) }))
    .filter((x): x is { country: string; rank: number; total: number; myPrice: number } =>
      x.rank !== undefined && x.total !== undefined && x.myPrice !== undefined && x.total >= 3
    )
  const primaryCountryForCompare =
    [...countries].sort(
      (a, b) => rates.filter((r) => r.country === b).length - rates.filter((r) => r.country === a).length
    )[0] ?? countries[0]

  // 관련 배대지: 같은 국가를 지원하는 다른 배대지 (최대 6개, 1kg 요금 포함)
  const relatedForwarders = allForwarders
    .filter((f) => countries.some((c) => allRates.some((r) => r.forwarder_id === f.id && r.country === c)))
    .map((f) => {
      const priceByCountry: Record<string, string> = {}
      countries.forEach((c) => {
        const r = allRates.find((r) => r.forwarder_id === f.id && r.country === c && r.weight_min <= 1 && r.weight_max >= 1)
        if (r?.price_krw) priceByCountry[c] = `${r.price_krw.toLocaleString()}원`
        else if (r?.price_usd) priceByCountry[c] = `$${r.price_usd}`
      })
      return { ...f, priceByCountry }
    })
    .slice(0, 6)

  // Group centers by country
  const usCenters = centers.filter((c) => c.country === 'US')
  const jpCenters = centers.filter((c) => c.country === 'JP')
  const cnCenters = centers.filter((c) => c.country === 'CN')

  // Get rates per country per center
  const getRatesForCountryAndCenter = (country: string, centerName: string) =>
    rates.filter((r) => r.country === country && r.center_name === centerName)

  // Get unique center names for a country
  const getCenterNames = (country: string) =>
    [...new Set(rates.filter((r) => r.country === country).map((r) => r.center_name).filter(Boolean))] as string[]

  const countryNames: Record<string, string> = { US: '미국', JP: '일본', CN: '중국' }
  const countryFlags: Record<string, string> = { US: '🇺🇸', JP: '🇯🇵', CN: '🇨🇳' }

  // Representative 1kg rates per country for FAQ/summary text
  const baseRates = rates.filter((r) => r.grade_level === 1 && r.weight_min <= 1 && r.weight_max >= 1)
  const getRateSummary = (country: string) => {
    const r = baseRates.find((r) => r.country === country)
    if (!r) return null
    if (r.price_krw) return `${r.price_krw.toLocaleString()}원`
    if (r.price_usd) return `$${r.price_usd}`
    if (r.price_jpy) return `¥${r.price_jpy}`
    return null
  }

  const breadcrumbSchema = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "홈", item: "https://jimscanner.co.kr" },
      { "@type": "ListItem", position: 2, name: "배대지 목록", item: "https://jimscanner.co.kr/forwarders" },
      { "@type": "ListItem", position: 3, name: forwarder.name, item: `https://jimscanner.co.kr/forwarders/${slug}` },
    ],
  }

  const faqItems: { q: string; a: string }[] = []
  // Price FAQ per country
  countries.forEach((country) => {
    const summary = getRateSummary(country)
    const cName = countryNames[country] || country
    const centersForCountry = centers.filter((c) => c.country === country)
    if (summary) {
      faqItems.push({
        q: `${forwarder.name} ${cName} 배송비는 얼마인가요?`,
        a: `${forwarder.name} ${cName} 기본 배송비는 1kg 기준 ${summary}입니다. 회원 등급, 무게 구간, 센터 위치에 따라 달라질 수 있으며, 짐스캐너에서 무게를 입력하면 정확한 요금을 즉시 확인할 수 있습니다.`,
      })
    }
    if (centersForCountry.length > 0) {
      const addressList = centersForCountry
        .filter((c) => c.address)
        .map((c) => `${c.center_name || cName + ' 센터'}: ${c.address}`)
        .join(' / ')
      if (addressList) {
        faqItems.push({
          q: `${forwarder.name} ${cName} 창고 주소는 어디인가요?`,
          a: `${forwarder.name} ${cName} 센터 주소: ${addressList}`,
        })
      }
    }
  })
  if (gradeDefinitions.length > 0) {
    faqItems.push({
      q: `${forwarder.name} 회원 등급별 할인은 얼마나 되나요?`,
      a: `${forwarder.name}${josa(forwarder.name, '은/는')} 회원 등급에 따라 배송비 할인을 제공합니다. ${gradeDefinitions.map((g) => `${g.grade_name}(${g.discount_percent > 0 ? g.discount_percent + '% 할인' : '기본'})`).join(', ')}. 등급이 높을수록 배송비를 절약할 수 있습니다.`,
    })
  }
  faqItems.push({
    q: `${forwarder.name}${josa(forwarder.name, '과/와')} 다른 배대지를 비교하려면?`,
    a: `짐스캐너(jimscanner.co.kr)에서 ${forwarder.name}${josa(forwarder.name, '을/를')} 포함한 30개 이상의 배대지 배송비를 무게별로 무료로 비교할 수 있습니다.`,
  })

  // 편집 발행된 content.faq 가 있으면 그것을 단일 소스로 사용 (중복 FAQ 방지).
  // 없으면 page.tsx 에서 생성한 프로그래매틱 faqItems 를 사용.
  const contentFaq = content?.status === 'published' ? content.faq ?? [] : []
  const hasContentFaq = contentFaq.length > 0
  const effectiveFaqForSchema = hasContentFaq
    ? contentFaq.map((f) => ({ q: f.question, a: f.answer }))
    : faqItems

  const faqSchema = effectiveFaqForSchema.length > 0 ? {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: effectiveFaqForSchema.map((item) => ({
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
      <div className="container mx-auto max-w-4xl">
        {/* Breadcrumb */}
        <nav className="text-sm text-gray-500 mb-6">
          <Link href="/" className="hover:text-blue-600">홈</Link>
          {' > '}
          <Link href="/forwarders" className="hover:text-blue-600">배대지 목록</Link>
          {' > '}
          <span className="text-gray-900">{forwarder.name}</span>
        </nav>

        {/* Header */}
        <div className="mb-6">
          <h1 className="text-4xl font-bold text-gray-900">{forwarder.name}</h1>
          {forwarder.description && (
            <p className="text-gray-500 mt-3 text-lg leading-relaxed">{forwarder.description}</p>
          )}

          {/* Country Badges + 요금 확인일 */}
          <div className="flex flex-wrap gap-2 mt-4 items-center">
            {countries.map((country) => {
              const info = COUNTRIES.find((c) => c.code === country)
              return (
                <Badge key={country} variant="secondary" className="text-sm px-3 py-1">
                  {info?.flag} {info?.name || country}
                </Badge>
              )
            })}
            {lastVerifiedAt && <LastVerifiedBadge at={lastVerifiedAt} size="sm" />}
          </div>
        </div>

        {/* 가격·순위 요약 카드 (Above the fold 핵심 가치) */}
        {countryRanks.length > 0 && (
          <Card className="mb-8 border-blue-100 bg-gradient-to-br from-blue-50/40 to-white">
            <CardContent className="py-5 px-5">
              <div className={`grid gap-4 ${countryRanks.length === 1 ? 'sm:grid-cols-1' : countryRanks.length === 2 ? 'sm:grid-cols-2' : 'sm:grid-cols-3'}`}>
                {countryRanks.map(({ country, rank, total, myPrice }) => {
                  const info = COUNTRIES.find((c) => c.code === country)
                  const isBest = rank === 1
                  return (
                    <div key={country} className="flex items-center justify-between sm:flex-col sm:items-start sm:gap-2">
                      <div>
                        <div className="text-xs text-gray-500 mb-1">
                          {info?.flag} {info?.name || country} · 1kg 기준
                        </div>
                        <div className="text-2xl font-bold text-gray-900">
                          {myPrice.toLocaleString()}<span className="text-sm font-normal text-gray-500 ml-0.5">원</span>
                        </div>
                      </div>
                      {isBest ? (
                        <Badge className="bg-amber-100 text-amber-800 hover:bg-amber-100 border-amber-200">
                          🏆 {total}곳 중 최저가
                        </Badge>
                      ) : rank <= Math.ceil(total * 0.3) ? (
                        <Badge className="bg-green-100 text-green-800 hover:bg-green-100 border-green-200">
                          {total}곳 중 {rank}위
                        </Badge>
                      ) : (
                        <Badge variant="secondary">
                          {total}곳 중 {rank}위
                        </Badge>
                      )}
                    </div>
                  )
                })}
              </div>
              <div className="mt-5 pt-4 border-t border-blue-100/70 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                <span className="text-sm text-gray-600">
                  같은 무게로 30곳 배대지 한 번에 비교
                </span>
                <Button asChild size="sm" className="bg-blue-600 hover:bg-blue-700">
                  <Link href={`/compare/${primaryCountryForCompare.toLowerCase()}`}>
                    전체 비교표 보기 →
                  </Link>
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        {/* 공식 사이트 (보조 링크 — 외부 이탈 최소화) */}
        {forwarder.website && (
          <div className="mb-8 text-sm text-gray-500">
            <ExternalLink
              href={forwarder.website}
              context={forwarder.slug}
              source="forwarder_detail_official_site"
              className="hover:text-blue-600 hover:underline inline-flex items-center gap-1"
            >
              <span>{forwarder.name} 공식 사이트</span>
              <span className="text-xs">↗</span>
            </ExternalLink>
          </div>
        )}

        {/* 사용자 후기 (외부 블로그/커뮤니티 수집) — 국가가 여러 개면 카드 1장 + 탭 */}
        {(() => {
          const reviewByCountry = countries.map((country) => ({
            country: country as Country,
            summary: reviewSummaries.find((s) => s.country === country) ?? null,
            reviews: reviews
              .filter((r) => r.country === country)
              .sort((a, b) => (b.review_date ?? '').localeCompare(a.review_date ?? '')),
          }))
          const collectedAt = reviewSummaries.find((s) => s.collected_at)?.collected_at ?? null
          return (
            <ForwarderReviews
              forwarderName={forwarder.name}
              forwarderWebsite={forwarder.website}
              forwarderOfficialReviewsUrl={forwarder.official_reviews_url ?? null}
              collectedAt={collectedAt}
              byCountry={reviewByCountry}
            />
          )
        })()}

        {/* Pros & Cons */}
        {(forwarder.pros?.length || forwarder.cons?.length) && (
          <div className="grid sm:grid-cols-2 gap-6 mb-8">
            {forwarder.pros && forwarder.pros.length > 0 && (
              <Card className="border-green-100">
                <CardHeader className="pb-3">
                  <CardTitle className="text-green-700 text-base">장점</CardTitle>
                </CardHeader>
                <CardContent>
                  <ul className="space-y-2">
                    {forwarder.pros.map((pro, i) => (
                      <li key={i} className="flex items-start gap-2 text-sm text-gray-700">
                        <span className="text-green-500 mt-0.5">✓</span>
                        {pro}
                      </li>
                    ))}
                  </ul>
                </CardContent>
              </Card>
            )}
            {forwarder.cons && forwarder.cons.length > 0 && (
              <Card className="border-red-50">
                <CardHeader className="pb-3">
                  <CardTitle className="text-red-600 text-base">단점</CardTitle>
                </CardHeader>
                <CardContent>
                  <ul className="space-y-2">
                    {forwarder.cons.map((con, i) => (
                      <li key={i} className="flex items-start gap-2 text-sm text-gray-700">
                        <span className="text-red-400 mt-0.5">✗</span>
                        {con}
                      </li>
                    ))}
                  </ul>
                </CardContent>
              </Card>
            )}
          </div>
        )}

        {/* Features */}
        {forwarder.features && forwarder.features.length > 0 && (
          <Card className="mb-8">
            <CardHeader className="pb-3">
              <CardTitle className="text-base">주요 서비스</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex flex-wrap gap-2">
                {forwarder.features.map((feature, i) => (
                  <Badge key={i} variant="outline" className="text-sm">
                    {feature}
                  </Badge>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        {/* Centers */}
        {centers.length > 0 && (
          <Card className="mb-8">
            <CardHeader className="pb-3">
              <CardTitle className="text-base">창고 센터</CardTitle>
            </CardHeader>
            <CardContent>
              {(() => {
                const mapped: MapPin[] = centers
                  .filter((c) => c.lat != null && c.lng != null)
                  .map((c) => ({
                    id: c.id,
                    lat: Number(c.lat),
                    lng: Number(c.lng),
                    forwarderName: forwarder.name,
                    forwarderSlug: forwarder.slug,
                    centerName:
                      c.center_name ||
                      `${COUNTRIES.find((cc) => cc.code === c.country)?.name ?? c.country} 센터`,
                    country: c.country,
                    address: c.address,
                  }))
                return mapped.length > 0 ? (
                  <div className="mb-4">
                    <MapView pins={mapped} height={320} />
                  </div>
                ) : null
              })()}
              <div className="space-y-3">
                {[...usCenters, ...jpCenters, ...cnCenters].map((center) => {
                  const countryInfo = COUNTRIES.find((c) => c.code === center.country)
                  const mapsUrl = center.address
                    ? `https://maps.google.com/?q=${encodeURIComponent(center.address)}`
                    : null

                  return (
                    <div key={center.id} className="flex items-start gap-3 p-3 bg-gray-50 rounded-lg">
                      <span className="text-xl mt-0.5">{countryInfo?.flag || '🌍'}</span>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <p className="font-medium text-sm text-gray-900">
                            {center.center_name || `${countryInfo?.name} 센터`}
                          </p>
                          {center.state && (
                            <Badge variant="outline" className="text-xs px-1.5 py-0 font-mono">
                              {center.state}
                            </Badge>
                          )}
                          {center.state && STATE_LABEL[center.state] && (
                            <span className="text-xs text-gray-500">({STATE_LABEL[center.state]})</span>
                          )}
                          {center.is_tax_free && (
                            <Badge className="bg-green-100 text-green-700 border-green-200 text-xs px-1.5 py-0">
                              무세금
                            </Badge>
                          )}
                        </div>
                        {center.address && (
                          <div className="flex items-center gap-1 mt-0.5">
                            <p className="text-xs text-gray-500 truncate">{center.address}</p>
                            {mapsUrl && (
                              <a
                                href={mapsUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-xs text-blue-500 hover:text-blue-700 shrink-0"
                              >
                                지도
                              </a>
                            )}
                          </div>
                        )}
                        {center.special_benefit && (
                          <p className="text-xs text-blue-600 mt-0.5">{center.special_benefit}</p>
                        )}
                        {center.storage_days && (
                          <p className="text-xs text-gray-400 mt-0.5">무료 보관 {center.storage_days}일</p>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            </CardContent>
          </Card>
        )}

        {/* Member Grade Table (if grades defined) */}
        {gradeDefinitions.length > 0 && (
          <Card className="mb-8">
            <CardHeader className="pb-3">
              <CardTitle className="text-base">회원 등급 혜택</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b">
                      <th className="text-left py-2 px-3 font-semibold text-gray-700">등급</th>
                      <th className="text-center py-2 px-3 font-semibold text-gray-700">할인율</th>
                      <th className="text-center py-2 px-3 font-semibold text-gray-700">조건</th>
                      <th className="text-left py-2 px-3 font-semibold text-gray-700">설명</th>
                    </tr>
                  </thead>
                  <tbody>
                    {gradeDefinitions.map((grade) => (
                      <tr key={grade.id} className="border-b hover:bg-gray-50">
                        <td className="py-2 px-3 font-medium text-gray-800">
                          {grade.grade_name}
                          {grade.grade_level === 3 && (
                            <span className="ml-1.5 text-xs text-blue-600">★ VIP</span>
                          )}
                        </td>
                        <td className="py-2 px-3 text-center">
                          {grade.discount_percent > 0 ? (
                            <span className="text-green-600 font-medium">{grade.discount_percent}%</span>
                          ) : (
                            <span className="text-gray-400">-</span>
                          )}
                        </td>
                        <td className="py-2 px-3 text-center text-gray-500 text-xs">
                          {grade.min_shipments !== null && grade.min_shipments > 0
                            ? `${grade.min_shipments}회 이상`
                            : '-'}
                        </td>
                        <td className="py-2 px-3 text-gray-500 text-xs">
                          {grade.description || '-'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Shipping Rates — per country, 우선순위: service_label → center_name 탭 */}
        {countries.map((country) => {
          const countryInfo = COUNTRIES.find((c) => c.code === country)
          const countryRates = rates.filter((r) => r.country === country)
          const serviceLabels = [
            ...new Set(countryRates.map((r) => r.service_label).filter(Boolean)),
          ] as string[]
          const centerNames = getCenterNames(country)

          return (
            <Card key={country} className="mb-6">
              <CardHeader>
                <div className="flex items-start justify-between gap-2 flex-wrap">
                  <CardTitle className="text-base flex items-center gap-2">
                    {countryInfo?.flag} {countryInfo?.name || country} 배송 요금표
                    {gradeDefinitions.length > 0 && (
                      <span className="text-xs font-normal text-gray-400">
                        — 등급별 가격 비교 (기본가 대비 절약액 표시)
                      </span>
                    )}
                  </CardTitle>
                  <ReportButton
                    mode="inline"
                    targetType="rate"
                    targetSlug={forwarder.slug}
                    targetId={country}
                    label="요금 오류 신고"
                  />
                </div>
                <ResolutionBadge
                  targetType="rate"
                  targetSlug={forwarder.slug}
                  targetId={country}
                  className="inline-flex items-start gap-1.5 text-[11px] text-emerald-700 bg-emerald-50 border border-emerald-200 rounded px-2 py-1 mt-2"
                />
              </CardHeader>
              <CardContent>
                {serviceLabels.length > 1 ? (
                  <Tabs defaultValue={serviceLabels[0]}>
                    <TabsList className="mb-4 h-auto flex-wrap gap-1">
                      {serviceLabels.map((sl) => (
                        <TabsTrigger key={sl} value={sl} className="text-sm">
                          {sl}
                        </TabsTrigger>
                      ))}
                    </TabsList>
                    {serviceLabels.map((sl) => {
                      const slRates = countryRates.filter((r) => r.service_label === sl)
                      return (
                        <TabsContent key={sl} value={sl}>
                          {gradeDefinitions.length > 0 ? (
                            <MemberGradeTable
                              rates={slRates}
                              gradeDefinitions={gradeDefinitions}
                              currencyRates={currentRates}
                            />
                          ) : (
                            <SimpleRateTable rates={slRates} />
                          )}
                        </TabsContent>
                      )
                    })}
                  </Tabs>
                ) : centerNames.length > 1 ? (
                  <Tabs defaultValue={centerNames[0]}>
                    <TabsList className="mb-4 h-auto flex-wrap gap-1">
                      {centerNames.map((cn) => {
                        const center = centers.find(
                          (c) => c.center_name === cn && c.country === country
                        )
                        return (
                          <TabsTrigger key={cn} value={cn} className="text-sm">
                            {cn}
                            {center?.is_tax_free && (
                              <span className="ml-1 text-xs text-green-600">무세금</span>
                            )}
                          </TabsTrigger>
                        )
                      })}
                    </TabsList>
                    {centerNames.map((cn) => {
                      const centerRates = getRatesForCountryAndCenter(country, cn)
                      // 이 센터 안에 service_label이 여러 개면 서브탭으로 분리 (NULL=기본이 맨 앞)
                      const centerLabels = [
                        ...new Set(centerRates.map((r) => r.service_label)),
                      ].sort((a, b) => {
                        if (a === null) return -1
                        if (b === null) return 1
                        return String(a).localeCompare(String(b))
                      }) as (string | null)[]
                      const hasMixedLabels = centerLabels.length > 1
                      return (
                        <TabsContent key={cn} value={cn}>
                          {hasMixedLabels ? (
                            <Tabs defaultValue={String(centerLabels[0] ?? '기본')}>
                              <TabsList className="mb-3 h-auto flex-wrap gap-1">
                                {centerLabels.map((sl) => (
                                  <TabsTrigger key={String(sl ?? '기본')} value={String(sl ?? '기본')} className="text-xs">
                                    {sl ?? '기본'}
                                  </TabsTrigger>
                                ))}
                              </TabsList>
                              {centerLabels.map((sl) => {
                                const slRates = centerRates.filter((r) => r.service_label === sl)
                                return (
                                  <TabsContent key={String(sl ?? '기본')} value={String(sl ?? '기본')}>
                                    {gradeDefinitions.length > 0 ? (
                                      <MemberGradeTable
                                        rates={slRates}
                                        gradeDefinitions={gradeDefinitions}
                                        currencyRates={currentRates}
                                      />
                                    ) : (
                                      <SimpleRateTable rates={slRates} />
                                    )}
                                  </TabsContent>
                                )
                              })}
                            </Tabs>
                          ) : gradeDefinitions.length > 0 ? (
                            <MemberGradeTable
                              rates={centerRates}
                              gradeDefinitions={gradeDefinitions}
                              currencyRates={currentRates}
                            />
                          ) : (
                            <SimpleRateTable rates={centerRates} />
                          )}
                        </TabsContent>
                      )
                    })}
                  </Tabs>
                ) : (
                  <>
                    {gradeDefinitions.length > 0 ? (
                      <MemberGradeTable
                        rates={countryRates}
                        gradeDefinitions={gradeDefinitions}
                        currencyRates={currentRates}
                      />
                    ) : (
                      <SimpleRateTable rates={countryRates} />
                    )}
                  </>
                )}
                <p className="text-xs text-gray-400 mt-3">
                  * 표시 요금은 참고용이며 실제 요금과 다를 수 있습니다
                </p>
              </CardContent>
            </Card>
          )
        })}

        {/* 부가서비스 */}
        {services.length > 0 && (
          <Card className="mb-8">
            <CardHeader className="pb-3">
              <CardTitle className="text-base">부가서비스 요금</CardTitle>
            </CardHeader>
            <CardContent>
              {(() => {
                const grouped = new Map<string, AdditionalService[]>()
                for (const s of services) {
                  if (!grouped.has(s.category)) grouped.set(s.category, [])
                  grouped.get(s.category)!.push(s)
                }
                const CATEGORY_ORDER = ['검수', '포장', '합배송', '보관', '통관', '반송', '보험', '검역', '수출신고', '폐기', '구매대행', '배송변경', '알림', '기타']
                const categories = Array.from(grouped.keys()).sort((a, b) => {
                  const ai = CATEGORY_ORDER.indexOf(a)
                  const bi = CATEGORY_ORDER.indexOf(b)
                  return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi)
                })
                return (
                  <div className="space-y-5">
                    {categories.map((cat) => (
                      <div key={cat}>
                        <h3 className="text-sm font-semibold text-gray-800 mb-2 flex items-center gap-2">
                          <span className="inline-block bg-blue-100 text-blue-700 text-xs font-medium px-2 py-0.5 rounded">
                            {cat}
                          </span>
                          <span className="text-xs text-gray-400">({grouped.get(cat)!.length}개)</span>
                        </h3>
                        <div className="space-y-1.5">
                          {grouped.get(cat)!.map((s) => (
                            <div
                              key={s.id}
                              className="flex flex-col sm:flex-row sm:items-start gap-1 sm:gap-3 py-2 border-b border-gray-100 last:border-b-0"
                            >
                              <div className="sm:w-48 text-sm font-medium text-gray-800">{s.service_name}</div>
                              <div className="sm:w-40 text-sm text-gray-700 shrink-0">
                                {s.price_text || <span className="text-gray-400">—</span>}
                              </div>
                              {s.description && (
                                <div className="flex-1 text-xs text-gray-500 leading-relaxed">
                                  {s.description}
                                </div>
                              )}
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                )
              })()}
            </CardContent>
          </Card>
        )}

        {/* Shipping cost summary text (SEO) */}
        {countries.length > 0 && (
          <section className="mb-8 p-6 bg-blue-50 rounded-xl">
            <h2 className="text-lg font-bold text-gray-900 mb-3">
              {forwarder.name} 배송비 요약
            </h2>
            <ul className="space-y-2 text-sm text-gray-700">
              {countries.map((country) => {
                const summary = getRateSummary(country)
                const centersForCountry = centers.filter((c) => c.country === country)
                const taxFreeCenter = centersForCountry.find((c) => c.is_tax_free)
                return (
                  <li key={country} className="flex items-start gap-2">
                    <span>{countryFlags[country] || '🌍'}</span>
                    <span>
                      <strong>{countryNames[country] || country}</strong>
                      {summary ? ` 1kg 기준 ${summary}` : ''}
                      {taxFreeCenter ? ` · 무세금 센터 (${taxFreeCenter.state || taxFreeCenter.center_name}) 이용 가능` : ''}
                    </span>
                  </li>
                )
              })}
              {gradeDefinitions.length > 0 && (
                <li className="flex items-start gap-2">
                  <span>💳</span>
                  <span>회원 등급 할인 최대 {Math.max(...gradeDefinitions.map((g) => g.discount_percent))}% 적용 가능</span>
                </li>
              )}
            </ul>
          </section>
        )}

        {/* 편집된 콘텐츠 섹션 (관리자 승인 발행분) */}
        <div className="mb-8">
          <ForwarderContentSections content={content} forwarderName={forwarder.name} />
        </div>

        {/* 프로그래매틱 FAQ — ForwarderContentSections 의 편집 FAQ 가 없을 때만 렌더 (중복 방지) */}
        {!hasContentFaq && faqItems.length > 0 && (
          <section className="mb-8">
            <h2 className="text-xl font-bold text-gray-900 mb-4 pb-2 border-b">
              {forwarder.name} 자주 묻는 질문
            </h2>
            <div className="space-y-4">
              {faqItems.map((item, i) => (
                <div key={i} className="border rounded-lg p-4 bg-white">
                  <p className="font-semibold text-gray-900 mb-1 text-sm">Q. {item.q}</p>
                  <p className="text-sm text-gray-600">A. {item.a}</p>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* 관련 배대지 비교 섹션 */}
        {relatedForwarders.length > 0 && (
          <section className="mb-8">
            <h2 className="text-xl font-bold text-gray-900 mb-4 pb-2 border-b">
              {forwarder.name}{josa(forwarder.name, '과/와')} 함께 비교하는 배대지
            </h2>
            <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {relatedForwarders.map((f) => (
                <Link
                  key={f.id}
                  href={`/forwarders/${f.slug}`}
                  className="block border rounded-lg p-4 hover:border-blue-400 hover:shadow-sm transition-all group"
                >
                  <p className="font-semibold text-gray-900 group-hover:text-blue-600 text-sm mb-1">
                    {f.name}
                  </p>
                  <div className="flex flex-wrap gap-x-3 gap-y-0.5">
                    {countries.map((c) =>
                      f.priceByCountry[c] ? (
                        <span key={c} className="text-xs text-gray-500">
                          {countryFlags[c]} 1kg {f.priceByCountry[c]}
                        </span>
                      ) : null
                    )}
                  </div>
                  <p className="text-xs text-blue-500 mt-2 group-hover:underline">요금 비교 →</p>
                </Link>
              ))}
            </div>
            <div className="mt-4 text-center">
              <Link
                href={`/compare/${countries[0]?.toLowerCase() ?? ''}`}
                className="text-sm text-blue-600 hover:underline font-medium"
              >
                {countryNames[countries[0]] || ''} 배대지 전체 비교표 보기 →
              </Link>
            </div>
          </section>
        )}

        <RelatedPostsBox
          posts={relatedPosts}
          title={`📘 ${forwarder.name} 관련 가이드`}
          subtitle="이 배대지·국가에 대한 짐스캐너 블로그 글"
        />

        <ServiceCTA
          variant="forwarder"
          country={countries[0]?.toLowerCase() as 'us' | 'jp' | 'cn' | undefined}
        />

        {/* Navigation */}
        <div className="flex justify-between mt-8">
          <Button variant="outline" asChild>
            <Link href="/forwarders">← 배대지 목록</Link>
          </Button>
          <Button variant="outline" asChild>
            <Link href="/compare">배송비 비교표 →</Link>
          </Button>
        </div>
      </div>
    </div>
    </>
  )
}

// Fallback simple table for배대지 without grade data
function SimpleRateTable({ rates }: { rates: ShippingRate[] }) {
  const uniqueRates = rates.filter((r) => r.grade_level === 1)
  return (
    <table className="w-full text-sm border-collapse">
      <thead>
        <tr className="bg-gray-50">
          <th className="text-left py-2 px-3 font-semibold text-gray-700 border-b">무게 구간</th>
          <th className="text-left py-2 px-3 font-semibold text-gray-700 border-b">센터</th>
          <th className="text-right py-2 px-3 font-semibold text-gray-700 border-b">요금 (원)</th>
        </tr>
      </thead>
      <tbody>
        {uniqueRates.map((rate) => (
          <tr key={rate.id} className="border-b hover:bg-gray-50">
            <td className="py-2 px-3 text-sm text-gray-700">
              {rate.weight_min}kg ~ {rate.weight_max}kg
            </td>
            <td className="py-2 px-3 text-sm text-gray-500">{rate.center_name || '-'}</td>
            <td className="py-2 px-3 text-right font-medium">
              {rate.price_krw ? `${rate.price_krw.toLocaleString()}원` : '-'}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
