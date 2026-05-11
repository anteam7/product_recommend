import { Metadata } from 'next'
import Link from 'next/link'
import { supabase } from '@/lib/supabase'
import { Badge } from '@/components/ui/badge'
import { MapView, type MapPin } from '@/components/map/MapView'

export const revalidate = 3600

const BASE_URL = 'https://jimscanner.co.kr'

export const metadata: Metadata = {
  title: '배대지 창고 지도 | 미국·일본·중국 배송대행 센터 위치',
  description:
    '미국(캘리포니아·뉴저지·델라웨어·오리건), 일본(도쿄·오사카), 중국(상하이·광저우·선전·웨이하이) 배대지 창고 위치를 지도에서 한눈에 비교하세요.',
  alternates: { canonical: `${BASE_URL}/map` },
  openGraph: {
    title: '배대지 창고 지도 · 미국·일본·중국',
    description: '배대지 업체별 해외 창고 위치를 지도에서 비교',
    url: `${BASE_URL}/map`,
  },
}

const COUNTRY_META: Record<string, { flag: string; name: string }> = {
  US: { flag: '🇺🇸', name: '미국' },
  JP: { flag: '🇯🇵', name: '일본' },
  CN: { flag: '🇨🇳', name: '중국' },
}

type CenterRow = {
  id: string
  country: string
  center_name: string | null
  address: string | null
  state: string | null
  lat: number
  lng: number
  forwarder: { name: string; slug: string } | null
}

async function getPins(): Promise<MapPin[]> {
  const { data } = await supabase
    .from('centers')
    .select('id, country, center_name, address, state, lat, lng, forwarder:forwarders(name, slug, is_active)')
    .not('lat', 'is', null)
    .not('lng', 'is', null)

  const rows = (data ?? []) as unknown as (CenterRow & {
    forwarder: { name: string; slug: string; is_active: boolean } | null
  })[]

  return rows
    .filter((r) => r.forwarder?.is_active)
    .map((r) => ({
      id: r.id,
      lat: Number(r.lat),
      lng: Number(r.lng),
      forwarderName: r.forwarder!.name,
      forwarderSlug: r.forwarder!.slug,
      centerName: r.center_name ?? '',
      country: r.country,
      address: r.address,
    }))
}

export default async function MapPage() {
  const pins = await getPins()

  const byCountry = new Map<string, MapPin[]>()
  for (const p of pins) {
    const list = byCountry.get(p.country) ?? []
    list.push(p)
    byCountry.set(p.country, list)
  }
  const countries = Array.from(byCountry.keys()).sort()

  const distinctForwarders = new Set(pins.map((p) => p.forwarderSlug)).size

  const breadcrumbSchema = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: '홈', item: BASE_URL },
      { '@type': 'ListItem', position: 2, name: '배대지 지도', item: `${BASE_URL}/map` },
    ],
  }

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(breadcrumbSchema) }}
      />
      <div className="py-12 px-4">
        <div className="container mx-auto max-w-6xl">
          <div className="mb-8">
            <Badge className="mb-3">배대지 지도</Badge>
            <h1 className="text-3xl sm:text-4xl font-bold text-gray-900 mb-3">
              배대지 창고 위치 지도
            </h1>
            <p className="text-base text-gray-600 leading-relaxed max-w-3xl">
              배대지 {distinctForwarders}개 업체의 해외 창고 {pins.length}곳을 지도에서 비교할 수 있습니다.
              창고 위치는 배송 속도·환적·면세주 선택에 직접 영향을 미치는 핵심 요소입니다.
            </p>
            <p className="text-xs text-gray-500 mt-2">
              일부 센터는 정확한 번지수 대신 도시·구 단위로 표시됩니다. 정확한 주소는 각 업체의 상세 페이지를 참고하세요.
            </p>
          </div>

          {/* 전체 지도 */}
          <section className="mb-10">
            <MapView pins={pins} height={560} />
          </section>

          {/* 국가별 요약 */}
          <section className="grid gap-4 sm:grid-cols-3 mb-10">
            {countries.map((c) => {
              const list = byCountry.get(c) ?? []
              const forwarders = new Set(list.map((p) => p.forwarderSlug))
              return (
                <div key={c} className="border rounded-lg p-4 bg-white">
                  <div className="text-2xl">{COUNTRY_META[c]?.flag ?? '🌍'}</div>
                  <div className="font-bold text-gray-900 mt-1">
                    {COUNTRY_META[c]?.name ?? c}
                  </div>
                  <div className="text-sm text-gray-600 mt-0.5">
                    {forwarders.size}개 업체 · 센터 {list.length}곳
                  </div>
                </div>
              )
            })}
          </section>

          {/* 주소 누락 안내 (있을 때만) */}
          <div className="bg-amber-50 border border-amber-100 rounded-lg p-4 text-sm text-amber-900 mb-10">
            <strong>💡 안내</strong> — 지도에 표시된 창고는 주소 정보가 공개된 업체 기준입니다.
            전체 배대지 업체 목록은{' '}
            <Link href="/forwarders" className="underline font-medium">
              배대지 목록 페이지
            </Link>
            에서 확인할 수 있습니다.
          </div>

          {/* CTA */}
          <div className="grid sm:grid-cols-3 gap-4">
            <Link
              href="/compare/us"
              className="border rounded-lg p-4 hover:border-blue-400 hover:shadow-sm transition-all text-sm"
            >
              <div className="text-xl mb-1">🇺🇸</div>
              <div className="font-medium text-gray-900">미국 배대지 비교</div>
              <div className="text-xs text-gray-500 mt-1">요금·센터별 비교</div>
            </Link>
            <Link
              href="/compare/jp"
              className="border rounded-lg p-4 hover:border-blue-400 hover:shadow-sm transition-all text-sm"
            >
              <div className="text-xl mb-1">🇯🇵</div>
              <div className="font-medium text-gray-900">일본 배대지 비교</div>
              <div className="text-xs text-gray-500 mt-1">도쿄·오사카 센터</div>
            </Link>
            <Link
              href="/compare/cn"
              className="border rounded-lg p-4 hover:border-blue-400 hover:shadow-sm transition-all text-sm"
            >
              <div className="text-xl mb-1">🇨🇳</div>
              <div className="font-medium text-gray-900">중국 배대지 비교</div>
              <div className="text-xs text-gray-500 mt-1">상하이·선전·광저우</div>
            </Link>
          </div>
        </div>
      </div>
    </>
  )
}
