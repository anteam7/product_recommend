'use client'

import { useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { Forwarder, ShippingRate, Country, COUNTRIES, CalculatorResult, GradeLevel } from '@/types'
import CountryFilter from '@/components/comparison/CountryFilter'
import GradeSelector from '@/components/grade/GradeSelector'
import Link from 'next/link'
import { track, ANALYTICS_EVENTS } from '@/lib/analytics'
import { type CurrencyRates, computeKrw } from '@/lib/current-rates'
import RealTimeRateBadge from '@/components/exchange/RealTimeRateBadge'

interface ShippingCalculatorProps {
  forwarders: Forwarder[]
  rates: ShippingRate[]
  currentRates: CurrencyRates
}

const LBS_TO_KG = 0.4536
const QUICK_WEIGHTS_KG = [0.5, 1, 2, 3, 5, 10]
const QUICK_WEIGHTS_LBS = [1, 2, 5, 10, 15, 22]

// 국가별 부피무게 계산 규칙
const VOL_WEIGHT_CONFIG: Record<Country, { unit: 'cm' | 'inch'; divisor: number; label: string }> = {
  US: { unit: 'inch', divisor: 366, label: '미국 (inch ÷ 366)' },
  JP: { unit: 'cm',   divisor: 5000, label: '일본 (cm ÷ 5,000)' },
  CN: { unit: 'cm',   divisor: 5000, label: '중국 (cm ÷ 5,000)' },
}

// 창고명 → 주(State) 약자 매핑
const CENTER_STATE: Record<string, string> = {
  '뉴저지 센터': 'NJ',
  '오리건 센터': 'OR',
  '캘리포니아 센터': 'CA',
  '델라웨어 센터': 'DE',
}

function getState(centerName: string | null): string | null {
  if (!centerName) return null
  return CENTER_STATE[centerName] || null
}

function buildResults(
  forwarders: Forwarder[],
  rates: ShippingRate[],
  country: Country,
  weightKg: number,
  gradeLevel: GradeLevel,
  currentRates: CurrencyRates,
): CalculatorResult[] {
  return forwarders
    .map((forwarder) => {
      const matchWeight = (r: ShippingRate) =>
        r.forwarder_id === forwarder.id &&
        r.country === country &&
        r.weight_min < weightKg &&
        r.weight_max >= weightKg

      // Find rates matching selected grade level
      let usedFallback = false
      let matching = rates.filter((r) => matchWeight(r) && (r.grade_level ?? 1) === gradeLevel)

      // GradeSelector level 3 (VIP/최고등급): 해당 배대지에서 가장 높은 grade_level 사용
      if (matching.length === 0 && gradeLevel === 3) {
        const allWeightMatching = rates.filter(matchWeight)
        const maxLevel = Math.max(...allWeightMatching.map((r) => r.grade_level ?? 1))
        if (maxLevel > 1) {
          matching = allWeightMatching.filter((r) => (r.grade_level ?? 1) === maxLevel)
        }
      }

      // Fallback to grade 1 if 배대지 doesn't have the selected grade (e.g., 포스트고)
      if (matching.length === 0 && gradeLevel !== 1) {
        matching = rates.filter((r) => matchWeight(r) && (r.grade_level ?? 1) === 1)
        usedFallback = true
      }

      // 실시간 환율로 KRW 재계산
      const withPrice = matching
        .map((r) => ({ rate: r, price: computeKrw(r, currentRates) }))
        .filter((x): x is { rate: ShippingRate; price: number } => x.price !== null)

      if (withPrice.length === 0) return { forwarder, rate: null, price: null }

      const sorted = withPrice.sort((a, b) => a.price - b.price)
      const [best, ...rest] = sorted

      return {
        forwarder,
        rate: best.rate,
        price: best.price,
        isUniformPricing: usedFallback,
        alternatives: rest.map((x) => ({ rate: x.rate, price: x.price })),
      }
    })
    .filter((r) => r.price !== null)
    .sort((a, b) => (a.price ?? Infinity) - (b.price ?? Infinity))
}

interface ResultsListProps {
  results: CalculatorResult[]
  label: string
  minPrice: number | null
  maxPrice: number | null
  selectedGrade: GradeLevel
  currentRates: CurrencyRates
}

function ResultsList({ results, label, minPrice, maxPrice, selectedGrade, currentRates }: ResultsListProps) {
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set())

  const toggle = (id: string) =>
    setExpandedIds((prev) => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })

  return (
    <div className="space-y-3">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1">
        <h3 className="text-lg font-bold text-gray-900">{label}</h3>
        {minPrice && maxPrice && (
          <p className="text-sm text-gray-500">
            최저 <span className="text-green-600 font-bold">{minPrice.toLocaleString()}원</span>
            {' ~ '}
            최고 <span className="text-red-500 font-bold">{maxPrice.toLocaleString()}원</span>
          </p>
        )}
      </div>

      <div className="grid gap-3">
        {results.map((result, index) => {
          const isExpanded = expandedIds.has(result.forwarder.id)
          const state = getState(result.rate?.center_name ?? null)
          const hasAlternatives = (result.alternatives?.length ?? 0) > 0

          return (
            <Card
              key={result.forwarder.id}
              className={`transition-all ${
                index === 0
                  ? 'border-green-200 bg-green-50/50 shadow-md'
                  : 'hover:border-blue-200 hover:shadow-sm'
              }`}
            >
              <CardContent className="py-3 px-4">
                {/* Main result row */}
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <span className="text-lg font-bold text-gray-400 w-8 shrink-0">
                      {index + 1}위
                    </span>
                    <div>
                      <div className="flex items-center gap-2 flex-wrap">
                        <Link
                          href={`/forwarders/${result.forwarder.slug}`}
                          className="font-semibold text-gray-900 hover:text-blue-600"
                        >
                          {result.forwarder.name}
                        </Link>
                        {index === 0 && (
                          <Badge className="bg-green-500 text-white text-xs">최저가</Badge>
                        )}
                        {result.rate?.grade_level && result.rate.grade_level > 1 && !result.isUniformPricing && (
                          <Badge className="bg-purple-100 text-purple-700 border-purple-200 text-xs">
                            {result.rate.member_grade}
                          </Badge>
                        )}
                        {result.isUniformPricing && selectedGrade > 1 && (
                          <Badge className="bg-gray-100 text-gray-500 border-gray-200 text-xs">
                            균일가
                          </Badge>
                        )}
                      </div>
                      {result.rate?.center_name && (
                        <div className="flex items-center gap-1 mt-0.5">
                          <p className="text-xs text-gray-500">{result.rate.center_name}</p>
                          {state && (
                            <span className="text-xs font-medium text-gray-400">({state})</span>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="text-right">
                    <p
                      className={`text-xl font-bold ${
                        index === 0 ? 'text-green-600' : 'text-gray-900'
                      }`}
                    >
                      {result.price?.toLocaleString()}원
                    </p>
                    {result.rate?.price_usd && (
                      <p className="text-xs text-gray-400">
                        ${result.rate.price_usd.toFixed(2)} · 1USD={currentRates.USD.toLocaleString('ko-KR', { maximumFractionDigits: 2 })}원
                      </p>
                    )}
                    {result.rate?.price_jpy && (
                      <p className="text-xs text-gray-400">
                        ¥{result.rate.price_jpy.toLocaleString()} · 100JPY={(currentRates.JPY * 100).toLocaleString('ko-KR', { maximumFractionDigits: 2 })}원
                      </p>
                    )}
                    {result.rate?.price_cny && (
                      <p className="text-xs text-gray-400">
                        元{result.rate.price_cny.toLocaleString()} · 1CNY={currentRates.CNY.toLocaleString('ko-KR', { maximumFractionDigits: 2 })}원
                      </p>
                    )}
                    {index === 0 && maxPrice && maxPrice > (result.price ?? 0) && (
                      <p className="text-xs text-green-600 font-medium">
                        최대 {(maxPrice - (result.price ?? 0)).toLocaleString()}원 절약
                      </p>
                    )}
                    {minPrice && index > 0 && (
                      <p className="text-xs text-gray-400">
                        최저가보다 +{((result.price ?? 0) - minPrice).toLocaleString()}원
                      </p>
                    )}
                  </div>
                </div>

                {/* Expand/collapse other centers */}
                {hasAlternatives && (
                  <button
                    type="button"
                    onClick={() => toggle(result.forwarder.id)}
                    className="mt-2 text-xs text-blue-500 hover:text-blue-700 flex items-center gap-1"
                  >
                    다른 창고 보기 ({result.alternatives!.length})
                    <span>{isExpanded ? '▲' : '▼'}</span>
                  </button>
                )}

                {isExpanded && result.alternatives && (
                  <div className="mt-2 space-y-1.5 pl-11">
                    {result.alternatives.map(({ rate, price }) => {
                      const altState = getState(rate.center_name)
                      return (
                        <div
                          key={rate.id}
                          className="flex items-center justify-between text-sm bg-gray-50 rounded px-3 py-1.5"
                        >
                          <div className="flex items-center gap-1.5 text-gray-600">
                            <span>{rate.center_name}</span>
                            {altState && (
                              <span className="text-xs text-gray-400">({altState})</span>
                            )}
                          </div>
                          <div className="text-right">
                            <span className="font-medium text-gray-700">
                              {price.toLocaleString()}원
                            </span>
                            {rate.price_usd && (
                              <p className="text-xs text-gray-400">
                                ${rate.price_usd.toFixed(2)}
                              </p>
                            )}
                            {rate.price_jpy && (
                              <p className="text-xs text-gray-400">
                                ¥{rate.price_jpy.toLocaleString()}
                              </p>
                            )}
                            {rate.price_cny && (
                              <p className="text-xs text-gray-400">
                                元{rate.price_cny.toLocaleString()}
                              </p>
                            )}
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )}
              </CardContent>
            </Card>
          )
        })}
      </div>

      <p className="text-xs text-gray-400 text-center">
        * 표시 요금은 참고용이며 실제 요금과 다를 수 있습니다
      </p>
    </div>
  )
}

export default function ShippingCalculator({ forwarders, rates, currentRates }: ShippingCalculatorProps) {
  const [country, setCountry] = useState<Country>('US')
  const [gradeLevel, setGradeLevel] = useState<GradeLevel>(1)

  // Actual weight tab
  const [unit, setUnit] = useState<'kg' | 'lbs'>('kg')
  const [weight, setWeight] = useState('')
  const [results, setResults] = useState<CalculatorResult[]>([])
  const [calculated, setCalculated] = useState(false)

  // Volume weight tab
  const [length, setLength] = useState('')
  const [width, setWidth] = useState('')
  const [height, setHeight] = useState('')
  const [volResults, setVolResults] = useState<CalculatorResult[]>([])
  const [volCalculated, setVolCalculated] = useState(false)
  const [volWeightKg, setVolWeightKg] = useState<number | null>(null)

  const resultsRef = useRef<HTMLDivElement>(null)
  const volResultsRef = useRef<HTMLDivElement>(null)

  const scrollToResults = (ref: React.RefObject<HTMLDivElement | null>) => {
    // 다음 페인트 이후 결과가 DOM에 붙은 뒤 스크롤
    requestAnimationFrame(() => {
      ref.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    })
  }

  const quickWeights = unit === 'lbs' ? QUICK_WEIGHTS_LBS : QUICK_WEIGHTS_KG
  const toKg = (val: number) => (unit === 'lbs' ? val * LBS_TO_KG : val)

  const handleGradeChange = (level: GradeLevel) => {
    setGradeLevel(level)
    track(ANALYTICS_EVENTS.COMPARE_FILTER_CHANGE, { filter: 'grade', value: level })
    // Auto-recalculate if results are already shown
    if (calculated) {
      const w = parseFloat(weight)
      if (!isNaN(w) && w > 0) {
        setResults(buildResults(forwarders, rates, country, toKg(w), level, currentRates))
      }
    }
    if (volCalculated && volWeightKg !== null) {
      setVolResults(buildResults(forwarders, rates, country, volWeightKg, level, currentRates))
    }
  }

  const handleCalculateWithWeight = (w: number) => {
    setWeight(String(w))
    setResults(buildResults(forwarders, rates, country, toKg(w), gradeLevel, currentRates))
    setCalculated(true)
    track(ANALYTICS_EVENTS.CALCULATE_CLICK, {
      weight_kg: toKg(w),
      country,
      grade_level: gradeLevel,
      trigger: 'quick_weight',
    })
    scrollToResults(resultsRef)
  }

  const handleCalculate = () => {
    const w = parseFloat(weight)
    if (isNaN(w) || w <= 0) return
    setResults(buildResults(forwarders, rates, country, toKg(w), gradeLevel, currentRates))
    setCalculated(true)
    track(ANALYTICS_EVENTS.CALCULATE_CLICK, {
      weight_kg: toKg(w),
      country,
      grade_level: gradeLevel,
      trigger: 'manual',
    })
    scrollToResults(resultsRef)
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') handleCalculate()
  }

  const handleCountryChange = (c: Country) => {
    setCountry(c)
    track(ANALYTICS_EVENTS.COMPARE_FILTER_CHANGE, { filter: 'country', value: c })
  }

  const volConfig = VOL_WEIGHT_CONFIG[country]

  const handleVolumeCalculate = () => {
    const l = parseFloat(length)
    const w = parseFloat(width)
    const h = parseFloat(height)
    if (isNaN(l) || isNaN(w) || isNaN(h) || l <= 0 || w <= 0 || h <= 0) return
    const vw = (l * w * h) / volConfig.divisor
    const rounded = Math.round(vw * 100) / 100
    setVolWeightKg(rounded)
    setVolResults(buildResults(forwarders, rates, country, vw, gradeLevel, currentRates))
    setVolCalculated(true)
    scrollToResults(volResultsRef)
  }

  const lPreview = parseFloat(length)
  const wPreview = parseFloat(width)
  const hPreview = parseFloat(height)
  const volPreview =
    !isNaN(lPreview) && !isNaN(wPreview) && !isNaN(hPreview)
      ? (lPreview * wPreview * hPreview) / volConfig.divisor
      : null

  const countryInfo = COUNTRIES.find((c) => c.code === country)
  const minPrice = results[0]?.price ?? null
  const maxPrice = results[results.length - 1]?.price ?? null
  const volMinPrice = volResults[0]?.price ?? null
  const volMaxPrice = volResults[volResults.length - 1]?.price ?? null

  const weightDisplayLabel = (() => {
    if (!weight) return ''
    const w = parseFloat(weight)
    if (isNaN(w)) return ''
    if (unit === 'lbs') return `${weight}lbs (≈${(w * LBS_TO_KG).toFixed(2)}kg)`
    return `${weight}kg`
  })()

  return (
    <div className="space-y-6">
      <Card className="border-2 border-blue-100 shadow-lg">
        <CardHeader className="pb-4">
          <CardTitle className="text-xl text-gray-900 flex items-center gap-2">
            <span className="text-2xl">📦</span>
            배송비 계산기
          </CardTitle>
          <p className="text-sm text-gray-500">무게를 입력하면 배대지별 예상 배송비를 비교합니다</p>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <label className="text-sm font-medium text-gray-700 mb-2 block">출발 국가</label>
            <CountryFilter selected={country} onChange={handleCountryChange} />
          </div>

          <GradeSelector value={gradeLevel} onChange={handleGradeChange} />

          <Tabs defaultValue="actual">
            <TabsList className="w-full">
              <TabsTrigger value="actual" className="flex-1">실무게</TabsTrigger>
              <TabsTrigger value="volume" className="flex-1">부피무게</TabsTrigger>
            </TabsList>

            {/* Actual weight tab */}
            <TabsContent value="actual" className="pt-4 space-y-3">
              <div className="flex items-center justify-between">
                <label className="text-sm font-medium text-gray-700">무게</label>
                <div className="flex rounded-full border border-gray-200 overflow-hidden text-xs">
                  <button
                    onClick={() => setUnit('kg')}
                    className={`px-3 py-1 transition-colors ${
                      unit === 'kg' ? 'bg-blue-600 text-white' : 'text-gray-600 hover:bg-gray-50'
                    }`}
                  >
                    kg
                  </button>
                  <button
                    onClick={() => setUnit('lbs')}
                    className={`px-3 py-1 transition-colors ${
                      unit === 'lbs' ? 'bg-blue-600 text-white' : 'text-gray-600 hover:bg-gray-50'
                    }`}
                  >
                    lbs
                  </button>
                </div>
              </div>

              <div className="flex flex-wrap gap-2">
                {quickWeights.map((w) => (
                  <button
                    key={w}
                    onClick={() => handleCalculateWithWeight(w)}
                    className={`px-3 py-1.5 rounded-full text-sm border transition-all ${
                      weight === String(w)
                        ? 'bg-blue-600 text-white border-blue-600'
                        : 'bg-white text-gray-600 border-gray-200 hover:border-blue-400'
                    }`}
                  >
                    {w}{unit}
                  </button>
                ))}
              </div>

              <div className="flex gap-3">
                <div className="relative max-w-[200px] w-full">
                  <Input
                    type="number"
                    placeholder="직접 입력"
                    value={weight}
                    onChange={(e) => setWeight(e.target.value)}
                    onKeyDown={handleKeyDown}
                    min="0.1"
                    step="0.1"
                    className="pr-10"
                  />
                  <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-gray-400 pointer-events-none">
                    {unit}
                  </span>
                </div>
                <Button onClick={handleCalculate} className="bg-blue-600 hover:bg-blue-700 px-8">
                  계산하기
                </Button>
              </div>

              {unit === 'lbs' && weight && !isNaN(parseFloat(weight)) && (
                <p className="text-xs text-blue-500">
                  ≈ {(parseFloat(weight) * LBS_TO_KG).toFixed(2)} kg
                </p>
              )}
              <p className="text-xs text-gray-400">Enter키로 즉시 계산</p>
            </TabsContent>

            {/* Volume weight tab */}
            <TabsContent value="volume" className="pt-4 space-y-3">
              <div className="flex items-center gap-2 bg-blue-50 rounded-lg px-3 py-2">
                <span className="text-base">📦</span>
                <div className="text-xs text-blue-700">
                  <span className="font-semibold">{volConfig.label}</span>
                  <span className="text-blue-500 ml-1">
                    — 가로 × 세로 × 높이({volConfig.unit}) ÷ {volConfig.divisor.toLocaleString()}
                  </span>
                </div>
              </div>

              <div>
                <label className="text-sm font-medium text-gray-700 mb-2 block">
                  박스 크기 ({volConfig.unit})
                </label>
                <div className="grid grid-cols-3 gap-2">
                  <div>
                    <p className="text-xs text-gray-500 mb-1">가로 (A)</p>
                    <Input
                      type="number"
                      placeholder={volConfig.unit}
                      value={length}
                      onChange={(e) => setLength(e.target.value)}
                      min="1"
                      step="0.1"
                    />
                  </div>
                  <div>
                    <p className="text-xs text-gray-500 mb-1">세로 (B)</p>
                    <Input
                      type="number"
                      placeholder={volConfig.unit}
                      value={width}
                      onChange={(e) => setWidth(e.target.value)}
                      min="1"
                      step="0.1"
                    />
                  </div>
                  <div>
                    <p className="text-xs text-gray-500 mb-1">높이 (C)</p>
                    <Input
                      type="number"
                      placeholder={volConfig.unit}
                      value={height}
                      onChange={(e) => setHeight(e.target.value)}
                      min="1"
                      step="0.1"
                    />
                  </div>
                </div>
              </div>

              {volPreview !== null && (
                <div className="bg-green-50 rounded-lg px-3 py-2 text-sm">
                  <span className="text-gray-600">부피무게 = </span>
                  <span className="text-green-700 font-medium">
                    {lPreview} × {wPreview} × {hPreview} ÷ {volConfig.divisor.toLocaleString()} = <strong>{volPreview.toFixed(2)} kg</strong>
                  </span>
                </div>
              )}

              <Button
                onClick={handleVolumeCalculate}
                className="bg-blue-600 hover:bg-blue-700 w-full"
              >
                부피무게로 계산하기
              </Button>
              <p className="text-xs text-gray-400">
                실무게와 부피무게 중 더 큰 값이 적용됩니다. 국가 선택 시 공식이 자동 변경됩니다.
              </p>
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>

      {/* Actual weight results */}
      {calculated && results.length > 0 && (
        <div ref={resultsRef} className="space-y-4 scroll-mt-20">
          <RealTimeRateBadge rates={currentRates} variant="banner" />
          <ResultsList
            results={results}
            label={`${countryInfo?.flag} ${countryInfo?.name} ${weightDisplayLabel} 배송비 비교`}
            minPrice={minPrice}
            maxPrice={maxPrice}
            selectedGrade={gradeLevel}
            currentRates={currentRates}
          />
        </div>
      )}

      {/* Volume weight results */}
      {volCalculated && volResults.length > 0 && (
        <div ref={volResultsRef} className="scroll-mt-20">
          <ResultsList
            results={volResults}
            label={`${countryInfo?.flag} ${countryInfo?.name} 부피무게 ${volWeightKg}kg 배송비 비교`}
            minPrice={volMinPrice}
            maxPrice={volMaxPrice}
            selectedGrade={gradeLevel}
            currentRates={currentRates}
          />
        </div>
      )}

      {calculated && results.length === 0 && (
        <Card className="border-orange-100">
          <CardContent className="py-6 text-center">
            <p className="text-gray-500">해당 무게/국가에 대한 요금 정보가 없습니다.</p>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
