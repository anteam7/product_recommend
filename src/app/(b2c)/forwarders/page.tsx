import { Metadata } from 'next'
import Link from 'next/link'
import { supabase } from '@/lib/supabase'
import { Forwarder, type ReviewSentiment } from '@/types'
import ForwarderCard from '@/components/forwarder/ForwarderCard'
import { getLastVerifiedMap } from '@/lib/last-verified'

type ForwarderMinRate = {
  forwarder_id: string
  country: string
  min_price_krw: number | null
}

type ReviewSummaryRow = {
  forwarder_id: string
  country: string
  review_count: number
  overall_sentiment: ReviewSentiment | null
}

export const revalidate = 3600

const BASE_URL = 'https://jimscanner.co.kr'

export const metadata: Metadata = {
  title: '배대지 목록 2026 | 미국·일본·중국 30개+ 배대지 업체 비교',
  description: '짐패스, 훗타운, 포스트고, 아라쿠 등 30개 이상 배대지 업체를 한눈에 비교하세요. 미국·일본·중국 배대지의 배송비, 서비스 특징, 장단점 2026년 최신 정보.',
  alternates: {
    canonical: `${BASE_URL}/forwarders`,
  },
  openGraph: {
    title: '배대지 목록 2026 | 30개+ 업체 비교',
    description: '짐패스, 훗타운, 포스트고, 아라쿠 등 30개 이상 배대지를 미국·일본·중국별로 비교. 배송비·서비스·장단점 한눈에.',
    url: `${BASE_URL}/forwarders`,
  },
}

async function getData() {
  const [forwardersResult, ratesResult, reviewSummariesResult] = await Promise.all([
    supabase.from('forwarders').select('*').eq('is_active', true).order('name'),
    supabase.from('forwarder_min_rates').select('*'),
    (supabase as unknown as { from: (t: string) => ReturnType<typeof supabase.from> })
      .from('jimscanner_forwarder_review_summary')
      .select('forwarder_id, country, review_count, overall_sentiment'),
  ])
  return {
    forwarders: (forwardersResult.data as Forwarder[]) || [],
    rates: (ratesResult.data as ForwarderMinRate[]) || [],
    reviewSummaries: ((reviewSummariesResult.data ?? []) as unknown as ReviewSummaryRow[]),
  }
}

export default async function ForwardersPage() {
  const [{ forwarders, rates, reviewSummaries }, lastVerifiedMap] = await Promise.all([
    getData(),
    getLastVerifiedMap(),
  ])

  const getMinPrice = (forwarderId: string, country: string) => {
    const row = rates.find(
      (r) => r.forwarder_id === forwarderId && r.country === country
    )
    return row?.min_price_krw ?? null
  }

  const getReviewMeta = (forwarderId: string, country: string) => {
    const row = reviewSummaries.find(
      (r) => r.forwarder_id === forwarderId && r.country === country
    )
    return {
      sentiment: row?.overall_sentiment ?? null,
      count: row?.review_count ?? null,
    }
  }

  const usForwarders = forwarders.filter((f) =>
    rates.some((r) => r.forwarder_id === f.id && r.country === 'US')
  )
  const jpForwarders = forwarders.filter((f) =>
    rates.some((r) => r.forwarder_id === f.id && r.country === 'JP')
  )
  const cnForwarders = forwarders.filter((f) =>
    rates.some((r) => r.forwarder_id === f.id && r.country === 'CN')
  )

  const itemListSchema = {
    "@context": "https://schema.org",
    "@type": "ItemList",
    name: "배대지 업체 목록",
    description: "미국·일본·중국 배대지 업체 비교 목록",
    numberOfItems: forwarders.length,
    itemListElement: forwarders.map((f, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: f.name,
      url: `${BASE_URL}/forwarders/${f.slug}`,
      description: f.description || undefined,
    })),
  }

  const breadcrumbSchema = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "홈", item: BASE_URL },
      { "@type": "ListItem", position: 2, name: "배대지 목록", item: `${BASE_URL}/forwarders` },
    ],
  }

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(itemListSchema) }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(breadcrumbSchema) }}
      />
    <div className="py-12 px-4">
      <div className="container mx-auto max-w-6xl">
        <div className="mb-8">
          <h1 className="text-3xl font-bold text-gray-900">배대지 목록</h1>
          <p className="text-gray-500 mt-2">
            총 {forwarders.length}개 배대지 업체의 서비스를 비교해 보세요
          </p>
        </div>

        <Link
          href="/compare"
          className="group mb-10 flex items-center gap-4 rounded-2xl border border-blue-100 bg-gradient-to-r from-blue-50 via-sky-50 to-white p-5 transition-shadow hover:shadow-md sm:p-6"
        >
          <div className="hidden h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-blue-600 text-white sm:flex">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-6 w-6">
              <rect x="3" y="4" width="7" height="16" rx="1.5" />
              <rect x="14" y="4" width="7" height="10" rx="1.5" />
            </svg>
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-blue-700">
              한눈에 비교
            </p>
            <p className="mt-1 text-base font-semibold text-gray-900 sm:text-lg">
              미국·일본·중국 배대지 요금을 한 표에서 비교하기
            </p>
            <p className="mt-1 text-xs text-gray-600 sm:text-sm">
              무게별 최저가 · FTA 면세한도 · 배송 옵션을 한눈에 확인하세요.
            </p>
          </div>
          <span className="hidden shrink-0 items-center gap-1 rounded-full bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors group-hover:bg-blue-700 sm:inline-flex">
            전체 비교표 <span aria-hidden>→</span>
          </span>
          <span
            aria-hidden
            className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-blue-600 text-white sm:hidden"
          >
            →
          </span>
        </Link>

        {usForwarders.length > 0 && (
          <section className="mb-12">
            <h2 className="text-xl font-bold text-gray-900 mb-4 flex items-center gap-2">
              🇺🇸 미국 배대지
              <span className="text-sm font-normal text-gray-500">({usForwarders.length}개)</span>
            </h2>
            <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-6">
              {usForwarders.map((forwarder) => {
                const review = getReviewMeta(forwarder.id, 'US')
                return (
                  <ForwarderCard
                    key={forwarder.id}
                    forwarder={forwarder}
                    minPrice={getMinPrice(forwarder.id, 'US')}
                    country="미국"
                    lastVerifiedAt={lastVerifiedMap.get(forwarder.id) ?? null}
                    reviewSentiment={review.sentiment}
                    reviewCount={review.count}
                  />
                )
              })}
            </div>
          </section>
        )}

        {jpForwarders.length > 0 && (
          <section className="mb-12">
            <h2 className="text-xl font-bold text-gray-900 mb-4 flex items-center gap-2">
              🇯🇵 일본 배대지
              <span className="text-sm font-normal text-gray-500">({jpForwarders.length}개)</span>
            </h2>
            <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-6">
              {jpForwarders.map((forwarder) => {
                const review = getReviewMeta(forwarder.id, 'JP')
                return (
                  <ForwarderCard
                    key={forwarder.id}
                    forwarder={forwarder}
                    minPrice={getMinPrice(forwarder.id, 'JP')}
                    country="일본"
                    lastVerifiedAt={lastVerifiedMap.get(forwarder.id) ?? null}
                    reviewSentiment={review.sentiment}
                    reviewCount={review.count}
                  />
                )
              })}
            </div>
          </section>
        )}

        {cnForwarders.length > 0 && (
          <section>
            <h2 className="text-xl font-bold text-gray-900 mb-4 flex items-center gap-2">
              🇨🇳 중국 배대지
              <span className="text-sm font-normal text-gray-500">({cnForwarders.length}개)</span>
            </h2>
            <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-6">
              {cnForwarders.map((forwarder) => {
                const review = getReviewMeta(forwarder.id, 'CN')
                return (
                  <ForwarderCard
                    key={forwarder.id}
                    forwarder={forwarder}
                    minPrice={getMinPrice(forwarder.id, 'CN')}
                    country="중국"
                    lastVerifiedAt={lastVerifiedMap.get(forwarder.id) ?? null}
                    reviewSentiment={review.sentiment}
                    reviewCount={review.count}
                  />
                )
              })}
            </div>
          </section>
        )}

        {forwarders.length === 0 && (
          <div className="text-center py-16 text-gray-500">
            <p className="text-xl">배대지 정보를 불러오는 중입니다...</p>
            <p className="text-sm mt-2">Supabase DB에 데이터를 입력해 주세요.</p>
          </div>
        )}
      </div>
    </div>
    </>
  )
}
