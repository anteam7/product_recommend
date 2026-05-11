import { Metadata } from 'next'
import { supabase } from '@/lib/supabase'
import { Forwarder, ShippingRate } from '@/types'
import ComparisonTable from '@/components/comparison/ComparisonTable'
import { Badge } from '@/components/ui/badge'
import Link from 'next/link'
import { getCurrentRates } from '@/lib/current-rates'
import RelatedPostsBox from '@/components/blog/RelatedPostsBox'
import { getRelatedBlogsForCountry } from '@/lib/related-blog'

export const revalidate = 3600

export const metadata: Metadata = {
  title: '배대지 배송비 비교표 2026 | 미국·일본·중국 30개+ 배대지 무게별 요금',
  description: '미국, 일본, 중국 배대지 30개 이상의 배송비를 무게별로 한눈에 비교하세요. 짐패스, 훗타운, 포스트고, 아라쿠 등 2026년 최신 요금표. 무료 즉시 비교.',
  alternates: { canonical: 'https://jimscanner.co.kr/compare' },
  openGraph: {
    title: '배대지 배송비 비교표 2026 | 30개+ 배대지 무게별 요금',
    description: '미국·일본·중국 배대지 30개+ 배송비를 무게별로 한눈에 비교. 최저가 즉시 확인.',
    url: 'https://jimscanner.co.kr/compare',
  },
}

async function getData() {
  const [forwardersResult, ratesResult] = await Promise.all([
    supabase.from('forwarders').select('*').eq('is_active', true).order('name'),
    supabase.from('shipping_rates').select('*').order('weight_min'),
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
  }
}

export default async function ComparePage() {
  const [{ forwarders, rates, dataUpdatedAt }, currentRates, relatedPosts] =
    await Promise.all([getData(), getCurrentRates(), getRelatedBlogsForCountry(null, 3)])

  const usForwarders = forwarders.filter((f) =>
    rates.some((r) => r.forwarder_id === f.id && r.country === 'US')
  )
  const jpForwarders = forwarders.filter((f) =>
    rates.some((r) => r.forwarder_id === f.id && r.country === 'JP')
  )
  const cnForwarders = forwarders.filter((f) =>
    rates.some((r) => r.forwarder_id === f.id && r.country === 'CN')
  )

  return (
    <div className="py-12 px-4">
      <div className="container mx-auto max-w-6xl">
        <div className="mb-8">
          <h1 className="text-3xl font-bold text-gray-900">배대지 배송비 비교표</h1>
          <p className="text-gray-500 mt-2">
            미국, 일본, 중국 배대지 배송비를 무게별로 비교합니다. 초록색이 최저가입니다.
          </p>
        </div>

        <Link
          href="/calculator"
          className="group mb-8 flex items-center gap-4 rounded-2xl border border-emerald-100 bg-gradient-to-r from-emerald-50 via-teal-50 to-white p-5 transition-shadow hover:shadow-md sm:p-6"
        >
          <div className="hidden h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-emerald-600 text-white sm:flex">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-6 w-6">
              <rect x="4" y="3" width="16" height="18" rx="2" />
              <line x1="8" y1="7" x2="16" y2="7" />
              <line x1="8" y1="11" x2="10" y2="11" />
              <line x1="13" y1="11" x2="16" y2="11" />
              <line x1="8" y1="15" x2="10" y2="15" />
              <line x1="13" y1="15" x2="16" y2="15" />
            </svg>
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-emerald-700">
              운임 빠른 비교
            </p>
            <p className="mt-1 text-base font-semibold text-gray-900 sm:text-lg">
              무게만 알면 배대지별 운임 즉시 비교
            </p>
            <p className="mt-1 text-xs text-gray-600 sm:text-sm">
              카테고리에 없는 상품이거나 정확한 무게를 알고 있을 때, 빠르게 배대지별 운임만 비교합니다.
            </p>
          </div>
          <span className="hidden shrink-0 items-center gap-1 rounded-full bg-emerald-600 px-4 py-2 text-sm font-medium text-white transition-colors group-hover:bg-emerald-700 sm:inline-flex">
            계산기 열기 <span aria-hidden>→</span>
          </span>
          <span
            aria-hidden
            className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-emerald-600 text-white sm:hidden"
          >
            →
          </span>
        </Link>

        {/* Quick links */}
        <div className="flex flex-wrap gap-3 mb-8">
          <Link href="/compare/us">
            <Badge variant="outline" className="text-sm px-4 py-2 cursor-pointer hover:bg-blue-50">
              🇺🇸 미국 배대지 ({usForwarders.length}개)
            </Badge>
          </Link>
          <Link href="/compare/jp">
            <Badge variant="outline" className="text-sm px-4 py-2 cursor-pointer hover:bg-blue-50">
              🇯🇵 일본 배대지 ({jpForwarders.length}개)
            </Badge>
          </Link>
          <Link href="/compare/cn">
            <Badge variant="outline" className="text-sm px-4 py-2 cursor-pointer hover:bg-blue-50">
              🇨🇳 중국 배대지 ({cnForwarders.length}개)
            </Badge>
          </Link>
        </div>

        <div className="space-y-12">
          <section>
            <ComparisonTable forwarders={forwarders} rates={rates} defaultCountry="US" showFilter={false} currencyRates={currentRates} dataUpdatedAt={dataUpdatedAt} />
          </section>

          <div className="border-t pt-12">
            <ComparisonTable forwarders={forwarders} rates={rates} defaultCountry="JP" showFilter={false} currencyRates={currentRates} dataUpdatedAt={dataUpdatedAt} />
          </div>

          <div className="border-t pt-12">
            <ComparisonTable forwarders={forwarders} rates={rates} defaultCountry="CN" showFilter={false} currencyRates={currentRates} dataUpdatedAt={dataUpdatedAt} />
          </div>
        </div>

        <div className="mt-8">
          <RelatedPostsBox
            posts={relatedPosts}
            title="📘 배대지 선택·직구 가이드"
            subtitle="짐스캐너 블로그에서 실전 비교·팁 읽기"
          />
        </div>

        <div className="mt-8 p-4 bg-amber-50 border border-amber-200 rounded-lg">
          <p className="text-sm text-amber-800">
            <strong>주의사항:</strong> 표시된 요금은 참고용 데이터이며, 실제 요금과 다를 수 있습니다.
            부피 무게, 유류할증료, 세관 검사비 등 추가 비용이 발생할 수 있습니다.
            정확한 요금은 각 배대지 업체 공식 사이트에서 확인해 주세요.
          </p>
        </div>
      </div>
    </div>
  )
}
