import type { Metadata } from 'next'
import Link from 'next/link'
import { supabase } from '@/lib/supabase'
import type { Forwarder, ShippingRate } from '@/types'
import ShippingCalculator from '@/components/calculator/ShippingCalculator'
import { getCurrentRates } from '@/lib/current-rates'
import RealTimeRateBadge from '@/components/exchange/RealTimeRateBadge'

const BASE_URL = 'https://jimscanner.co.kr'
const PAGE_URL = `${BASE_URL}/calculator`

export const metadata: Metadata = {
  title: '배송비 계산기 — 짐스캐너',
  description:
    '국가와 무게만 입력하면 배대지별 배송비를 즉시 비교합니다. 카테고리·브랜드 기반 무게 자동 추정이 어려울 때 사용하는 보조 도구.',
  alternates: { canonical: PAGE_URL },
  openGraph: {
    title: '배송비 계산기 — 짐스캐너',
    description: '국가·무게 입력 → 배대지별 배송비를 즉시 비교.',
    url: PAGE_URL,
  },
}

export const revalidate = 3600

async function getForwardersAndRates() {
  const [forwardersResult, ratesResult] = await Promise.all([
    supabase.from('forwarders').select('*').eq('is_active', true).order('name'),
    supabase.from('shipping_rates').select('*').order('weight_min'),
  ])
  return {
    forwarders: (forwardersResult.data as Forwarder[]) || [],
    rates: (ratesResult.data as ShippingRate[]) || [],
  }
}

export default async function CalculatorPage() {
  const [{ forwarders, rates }, currentRates] = await Promise.all([
    getForwardersAndRates(),
    getCurrentRates(),
  ])

  return (
    <main className="bg-[var(--jim-bg-primary)] text-[var(--jim-text-primary)]">
      <section className="px-5 pb-20 pt-16 sm:px-8">
        <div className="mx-auto max-w-[1200px]">
          <header className="mb-10 max-w-2xl">
            <p className="mb-4 text-[11px] font-medium tracking-[0.18em] text-[var(--jim-text-tertiary)]">
              SHIPPING CALCULATOR
            </p>
            <h1 className="text-[34px] font-medium leading-[1.12] tracking-tight sm:text-[40px]">
              무게를 직접 알 때<br />
              쓰는 계산기.
            </h1>
            <p className="mt-5 text-[15px] leading-7 text-[var(--jim-text-secondary)]">
              카테고리에 없는 상품이거나 정확한 무게를 알고 있을 때, 빠르게 배대지별 운임만 비교합니다.
              관부가세·면세한도 검사가 필요하면 직구 시뮬레이터를 이용하세요.
            </p>
            <div className="mt-6 flex flex-wrap gap-3">
              <Link
                href="/recommend"
                className="inline-flex h-10 items-center rounded-full bg-[var(--jim-bg-inverse)] px-5 text-sm font-medium text-white transition-opacity hover:opacity-90"
              >
                직구 시뮬레이터 →
              </Link>
              <Link
                href="/forwarders"
                className="inline-flex h-10 items-center rounded-full px-4 text-sm font-medium text-[var(--jim-text-secondary)] transition-colors hover:text-[var(--jim-text-primary)]"
              >
                배대지 목록
              </Link>
            </div>
          </header>

          <div className="rounded-[28px] bg-[var(--jim-bg-secondary)] p-5 sm:p-8 lg:p-10">
            <div className="mb-4">
              <RealTimeRateBadge rates={currentRates} variant="banner" />
            </div>
            <div className="rounded-[20px] bg-white p-4 sm:p-6">
              <ShippingCalculator forwarders={forwarders} rates={rates} currentRates={currentRates} />
            </div>
          </div>
        </div>
      </section>
    </main>
  )
}
