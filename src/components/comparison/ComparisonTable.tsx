'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { Forwarder, ShippingRate, Country, COUNTRIES, GradeLevel } from '@/types'
import CountryFilter from './CountryFilter'
import GradeSelector from '@/components/grade/GradeSelector'
import ShareMenu from '@/components/share/ShareMenu'
import type { CurrencyRates } from '@/lib/current-rates'
import { computeKrw } from '@/lib/current-rates'

interface ComparisonTableProps {
  forwarders: Forwarder[]
  rates: ShippingRate[]
  defaultCountry?: Country
  showFilter?: boolean
  /** true 시 상태를 URL 쿼리로 동기화하고 공유 버튼을 표시. 초기값은 initialGrade/initialWeight props 로 주입. */
  syncUrl?: boolean
  initialGrade?: GradeLevel
  initialWeight?: number
  /** 실시간 환율 (서버에서 주입) — USD/JPY 요금의 KRW 환산에 사용 */
  currencyRates: CurrencyRates
  /** 요금 마지막 업데이트 시각 (서버에서 계산해 주입) */
  dataUpdatedAt?: string | null
}

const WEIGHT_BRACKETS = [0.5, 1, 2, 3, 5, 10]
const KG_PER_LBS = 0.453592

function kgToLbs(kg: number): number {
  return Math.round((kg / KG_PER_LBS) * 2) / 2
}

/** rate 의 weight_min/max 를 kg 로 정규화 (원본 단위는 DB에 그대로 둠) */
function weightRangeKg(r: ShippingRate): { min: number; max: number } {
  if (r.weight_unit === 'lb' || r.weight_unit === 'lbs') {
    return { min: r.weight_min * KG_PER_LBS, max: r.weight_max * KG_PER_LBS }
  }
  return { min: r.weight_min, max: r.weight_max }
}

function formatDataUpdated(iso: string | null | undefined): string {
  if (!iso) return '최근'
  const d = new Date(iso)
  return d.toLocaleDateString('ko-KR', { year: 'numeric', month: '2-digit', day: '2-digit' })
}

export default function ComparisonTable({
  forwarders,
  rates,
  defaultCountry = 'US',
  showFilter = true,
  syncUrl = false,
  initialGrade = 1,
  initialWeight = 1,
  currencyRates,
  dataUpdatedAt,
}: ComparisonTableProps) {
  const USD_RATE = Math.round(currencyRates.USD)
  const JPY_RATE = Math.round(currencyRates.JPY * 100) / 100
  const CNY_RATE = Math.round(currencyRates.CNY * 100) / 100
  const DATA_UPDATED = formatDataUpdated(dataUpdatedAt)
  const pathname = usePathname()
  const router = useRouter()

  const [country, setCountry] = useState<Country>(defaultCountry)
  const [gradeLevel, setGradeLevel] = useState<GradeLevel>(initialGrade)
  const [mobileWeight, setMobileWeight] = useState<number>(initialWeight)

  // URL ↔ state 동기화 (syncUrl 일 때만)
  const didMount = useRef(false)
  useEffect(() => {
    if (!syncUrl) return
    if (!didMount.current) {
      didMount.current = true
      return
    }
    const params = new URLSearchParams()
    if (country !== defaultCountry) params.set('country', country.toLowerCase())
    if (gradeLevel !== 1) params.set('grade', String(gradeLevel))
    if (mobileWeight !== 1) params.set('weight', String(mobileWeight))
    const qs = params.toString()
    const nextUrl = qs ? `${pathname}?${qs}` : (pathname ?? '/')
    router.replace(nextUrl, { scroll: false })
  }, [country, gradeLevel, mobileWeight, syncUrl, defaultCountry, pathname, router])

  const shareCountryName = COUNTRIES.find((c) => c.code === country)?.name ?? country
  const shareTitle = `${shareCountryName} 배대지 배송비 비교 · ${mobileWeight}kg`
  const shareDescription = `${shareCountryName} 배대지 ${mobileWeight}kg 기준 최저가를 짐스캐너에서 바로 확인하세요.`

  const filteredForwarders = forwarders.filter((f) =>
    rates.some((r) => r.forwarder_id === f.id && r.country === country)
  )

  // 요금 행의 원화 가격 (KRW 직접 저장 or USD/JPY 환산)
  const rateKrw = (r: ShippingRate): number | null => computeKrw(r, currencyRates)

  // Returns the lowest-price rate for a forwarder at a given weight + grade level
  // weight 는 사용자 입력 kg. rate의 weight_min/max는 weight_unit 기준 → kg 정규화 후 비교
  const getRate = (
    forwarderId: string,
    weight: number,
  ): { rate: ShippingRate; isUniform: boolean; priceKrw: number } | null => {
    const matchWeight = (r: ShippingRate) => {
      if (r.forwarder_id !== forwarderId || r.country !== country) return false
      const { min, max } = weightRangeKg(r)
      return min < weight && max >= weight
    }

    let isUniform = false
    let matching = rates.filter((r) => matchWeight(r) && (r.grade_level ?? 1) === gradeLevel)

    // GradeSelector level 3 (VIP/최고등급): 해당 배대지에서 가장 높은 grade_level 사용
    if (matching.length === 0 && gradeLevel === 3) {
      const allWeightMatching = rates.filter(matchWeight)
      const maxLevel = Math.max(...allWeightMatching.map((r) => r.grade_level ?? 1))
      if (maxLevel > 1) {
        matching = allWeightMatching.filter((r) => (r.grade_level ?? 1) === maxLevel)
      }
    }

    if (matching.length === 0 && gradeLevel !== 1) {
      matching = rates.filter((r) => matchWeight(r) && (r.grade_level ?? 1) === 1)
      isUniform = true
    }

    if (matching.length === 0) return null

    // KRW(원본 or 환산) 기준 최저가 선택. KRW 환산 불가 행은 제외.
    let best: { rate: ShippingRate; priceKrw: number } | null = null
    for (const r of matching) {
      const p = rateKrw(r)
      if (p === null) continue
      if (!best || p < best.priceKrw) best = { rate: r, priceKrw: p }
    }
    if (!best) return null
    return { rate: best.rate, priceKrw: best.priceKrw, isUniform }
  }

  const formatPrice = (price: number | null) => {
    if (price === null) return '-'
    return `${price.toLocaleString()}원`
  }

  const getCheapestForWeight = (weight: number): string | null => {
    let minPrice = Infinity
    let cheapestId: string | null = null
    for (const f of filteredForwarders) {
      const rr = getRate(f.id, weight)
      if (rr && rr.priceKrw < minPrice) {
        minPrice = rr.priceKrw
        cheapestId = f.id
      }
    }
    return cheapestId
  }

  const countryInfo = COUNTRIES.find((c) => c.code === country)
  const hasUsdRates = rates.some(
    (r) => filteredForwarders.some((f) => f.id === r.forwarder_id) && r.country === country && r.price_usd !== null
  )
  const hasJpyRates = rates.some(
    (r) => filteredForwarders.some((f) => f.id === r.forwarder_id) && r.country === country && r.price_jpy !== null
  )
  const hasCnyRates = rates.some(
    (r) => filteredForwarders.some((f) => f.id === r.forwarder_id) && r.country === country && r.price_cny !== null
  )

  // Mobile: sorted forwarders for selected weight (priceKrw = USD/JPY 환산 포함)
  const mobileSorted = filteredForwarders
    .map((f) => {
      const rr = getRate(f.id, mobileWeight)
      return {
        forwarder: f,
        rate: rr?.rate ?? null,
        price: rr?.priceKrw ?? null,
      }
    })
    .filter((r) => r.price !== null)
    .sort((a, b) => (a.price ?? Infinity) - (b.price ?? Infinity))

  const mobileMinPrice = mobileSorted[0]?.price ?? null

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold text-gray-900">
            {countryInfo?.flag} {countryInfo?.name} 배대지 배송비 비교
          </h2>
          <p className="text-sm text-gray-500 mt-1">
            {filteredForwarders.length}개 배대지 · 무게별 배송비를 한눈에 비교하세요
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <Badge variant="outline" className="text-xs text-gray-500 font-normal shrink-0">
            요금 기준 {DATA_UPDATED} 업데이트
          </Badge>
          {syncUrl && (
            <ShareMenu
              title={shareTitle}
              description={shareDescription}
              size="sm"
              label="공유"
            />
          )}
          {showFilter && <CountryFilter selected={country} onChange={setCountry} />}
        </div>
      </div>

      {/* Grade selector */}
      <GradeSelector value={gradeLevel} onChange={setGradeLevel} />

      {/* ─── Mobile card view (hidden on md+) ─── */}
      <div className="md:hidden space-y-3">
        <div>
          <p className="text-xs font-medium text-gray-500 mb-2">무게 선택</p>
          <div className="flex flex-wrap gap-2">
            {WEIGHT_BRACKETS.map((w) => (
              <button
                key={w}
                onClick={() => setMobileWeight(w)}
                className={`px-3 py-1.5 rounded-full text-sm border transition-all ${
                  mobileWeight === w
                    ? 'bg-blue-600 text-white border-blue-600'
                    : 'bg-white text-gray-600 border-gray-200 hover:border-blue-400'
                }`}
              >
                {w}kg
              </button>
            ))}
          </div>
        </div>

        <div className="grid gap-2">
          {mobileSorted.map((item, index) => (
            <Card
              key={item.forwarder.id}
              className={`${index === 0 ? 'border-green-200 bg-green-50/50 shadow-sm' : ''}`}
            >
              <CardContent className="py-3 px-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <span className="text-sm font-bold text-gray-400 w-7 shrink-0">
                      {index + 1}위
                    </span>
                    <div>
                      <div className="flex items-center gap-2 flex-wrap">
                        <Link
                          href={`/forwarders/${item.forwarder.slug}`}
                          className="font-semibold text-gray-900 hover:text-blue-600 text-sm"
                        >
                          {item.forwarder.name}
                        </Link>
                        {index === 0 && (
                          <Badge className="bg-green-500 text-white text-xs">최저</Badge>
                        )}
                      </div>
                      {mobileMinPrice && index > 0 && (
                        <p className="text-xs text-gray-400">
                          최저가보다 +{((item.price ?? 0) - mobileMinPrice).toLocaleString()}원
                        </p>
                      )}
                    </div>
                  </div>
                  <div className="text-right">
                    <p
                      className={`text-lg font-bold ${
                        index === 0 ? 'text-green-600' : 'text-gray-900'
                      }`}
                    >
                      {formatPrice(item.price)}
                    </p>
                    {item.rate?.price_usd && (
                      <p className="text-xs text-gray-400">
                        ${item.rate.price_usd.toFixed(2)}{country === 'US' ? ` · ${kgToLbs(weightRangeKg(item.rate).max)}lbs` : ''} · 1USD={USD_RATE.toLocaleString()}원
                      </p>
                    )}
                    {item.rate?.price_jpy && (
                      <p className="text-xs text-gray-400">
                        ¥{item.rate.price_jpy.toLocaleString()} · 1JPY={JPY_RATE}원
                      </p>
                    )}
                    {item.rate?.price_cny && (
                      <p className="text-xs text-gray-400">
                        元{item.rate.price_cny.toLocaleString()} · 1CNY={CNY_RATE}원
                      </p>
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>

      {/* ─── Desktop table view (hidden on <md) ─── */}
      <div className="hidden md:block overflow-x-auto rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow className="bg-gray-50">
              <TableHead className="sticky left-0 bg-gray-50 font-semibold text-gray-900 min-w-[120px]">
                배대지
              </TableHead>
              {WEIGHT_BRACKETS.map((w) => (
                <TableHead key={w} className="text-center font-semibold text-gray-900 min-w-[90px]">
                  {w}kg
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {filteredForwarders.map((forwarder) => (
              <TableRow key={forwarder.id} className="hover:bg-blue-50/50 transition-colors">
                <TableCell className="sticky left-0 bg-white font-medium">
                  <Link
                    href={`/forwarders/${forwarder.slug}`}
                    className="text-blue-600 hover:underline"
                  >
                    {forwarder.name}
                  </Link>
                </TableCell>
                {WEIGHT_BRACKETS.map((weight) => {
                  const rr = getRate(forwarder.id, weight)
                  const cheapestId = getCheapestForWeight(weight)
                  const isCheapest = cheapestId === forwarder.id
                  return (
                    <TableCell key={weight} className={`text-center ${isCheapest ? 'bg-green-50' : ''}`}>
                      {rr?.rate ? (
                        <div className="flex flex-col items-center">
                          <span
                            className={`text-sm font-medium ${
                              isCheapest ? 'text-green-700 font-bold' : 'text-gray-700'
                            }`}
                          >
                            {formatPrice(rr.priceKrw)}
                          </span>
                          {rr.rate.price_usd && (
                            <span className="text-xs text-gray-400">
                              ${rr.rate.price_usd.toFixed(2)}{country === 'US' ? ` · ${kgToLbs(weightRangeKg(rr.rate).max)}lbs` : ''}
                            </span>
                          )}
                          {rr.rate.price_jpy && (
                            <span className="text-xs text-gray-400">
                              ¥{rr.rate.price_jpy.toLocaleString()}
                            </span>
                          )}
                          {rr.rate.price_cny && (
                            <span className="text-xs text-gray-400">
                              元{rr.rate.price_cny.toLocaleString()}
                            </span>
                          )}
                          {isCheapest && (
                            <span className="text-xs text-green-600 font-medium">최저</span>
                          )}
                          {rr.isUniform && gradeLevel > 1 && (
                            <span className="text-xs text-gray-400">균일</span>
                          )}
                        </div>
                      ) : (
                        <span className="text-gray-300">-</span>
                      )}
                    </TableCell>
                  )
                })}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <div className="space-y-1">
        <p className="text-xs text-gray-400">
          * 초록색 가격이 해당 무게에서 가장 저렴한 배대지입니다. 각 창고 중 최저가 기준. 실제 요금은 각 배대지 사이트에서 확인하세요.
        </p>
        {hasUsdRates && (
          <p className="text-xs text-gray-400">
            * $ 표시 금액은 원본 사이트 달러($) 기준 요금이며, 1 USD = {USD_RATE.toLocaleString()}원 환율을 적용하여 원화로 환산한 금액입니다.
          </p>
        )}
        {hasJpyRates && (
          <p className="text-xs text-gray-400">
            * ¥ 표시 금액은 원본 사이트 엔화(¥) 기준 요금이며, 1 JPY = {JPY_RATE}원 환율을 적용하여 원화로 환산한 금액입니다.
          </p>
        )}
        {hasCnyRates && (
          <p className="text-xs text-gray-400">
            * 元 표시 금액은 원본 사이트 위안화(元) 기준 요금이며, 1 CNY = {CNY_RATE}원 환율을 적용하여 원화로 환산한 금액입니다.
          </p>
        )}
      </div>
    </div>
  )
}
