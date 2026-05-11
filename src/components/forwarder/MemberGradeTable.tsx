import { ShippingRate, MemberGradeDefinition } from '@/types'
import type { CurrencyRates } from '@/lib/current-rates'

interface MemberGradeTableProps {
  rates: ShippingRate[]
  gradeDefinitions: MemberGradeDefinition[]
  currencyRates?: CurrencyRates
}

const DISPLAY_WEIGHTS_KG = [0.5, 1, 2, 3, 5, 7, 10]

const LB_TO_KG = 0.453592
const FALLBACK_USD = 1450
const FALLBACK_JPY = 9.5
const FALLBACK_CNY = 216

/** rate 의 무게 구간을 kg로 정규화 */
function rateRangeInKg(r: ShippingRate): { min: number; max: number } {
  if (r.weight_unit === 'lb' || r.weight_unit === 'lbs') {
    return { min: r.weight_min * LB_TO_KG, max: r.weight_max * LB_TO_KG }
  }
  return { min: r.weight_min, max: r.weight_max }
}

/** KG 기준으로 rate 찾기 (원본 단위 무관) */
function findRateByRange(
  rates: ShippingRate[],
  weightKg: number,
  gradeLevel: number
): ShippingRate | null {
  return (
    rates.find((r) => {
      const { min, max } = rateRangeInKg(r)
      return min < weightKg && max >= weightKg && (r.grade_level ?? 1) === gradeLevel
    }) || null
  )
}

function computeKrwFromRate(r: ShippingRate, fx: CurrencyRates | undefined): number | null {
  const usd = fx?.USD ?? FALLBACK_USD
  const jpy = fx?.JPY ?? FALLBACK_JPY
  const cny = fx?.CNY ?? FALLBACK_CNY
  if (r.price_krw != null) return r.price_krw
  if (r.price_usd != null) return Math.round(r.price_usd * usd)
  if (r.price_jpy != null) return Math.round(r.price_jpy * jpy)
  if (r.price_cny != null) return Math.round(r.price_cny * cny)
  return null
}

/** 등급이 많을 때 상·중·하 3개만 노출 (DB는 전체 저장, UI만 축약) */
function reduceToDisplay(grades: MemberGradeDefinition[]): MemberGradeDefinition[] {
  if (grades.length <= 3) return grades
  const lo = grades[0]
  const mid = grades[Math.floor(grades.length / 2)]
  const hi = grades[grades.length - 1]
  // 같은 id 중복 제거
  const seen = new Set<string>()
  return [lo, mid, hi].filter((g) => {
    if (seen.has(g.id)) return false
    seen.add(g.id)
    return true
  })
}

export default function MemberGradeTable({ rates, gradeDefinitions, currencyRates }: MemberGradeTableProps) {
  // 이 테이블에 실제로 존재하는 등급만 헤더로 렌더 (국가별 차이 반영)
  const presentLevels = new Set(rates.map((r) => r.grade_level ?? 1))
  const allGrades = [...gradeDefinitions]
    .filter((g) => presentLevels.has(g.grade_level))
    .sort((a, b) => a.grade_level - b.grade_level)
  const sortedGrades = reduceToDisplay(allGrades)
  if (sortedGrades.length === 0) return null

  const isLbsBased = rates.some(
    (r) => r.price_usd !== null && Math.abs((r.weight_max * 2) % 1) > 0.01
  )
  const isJpyBased = rates.some((r) => r.price_jpy !== null)
  const isCnyBased = rates.some((r) => r.price_cny !== null)
  const JPY_RATE = Math.round((currencyRates?.JPY ?? FALLBACK_JPY) * 100) / 100
  const USD_RATE = Math.round(currencyRates?.USD ?? FALLBACK_USD)
  const CNY_RATE = Math.round((currencyRates?.CNY ?? FALLBACK_CNY) * 100) / 100

  const displayWeights = DISPLAY_WEIGHTS_KG

  const findRate = (weight: number, gradeLevel: number) =>
    findRateByRange(rates, weight, gradeLevel)

  const getBasePrice = (weight: number): number | null => {
    const r = findRate(weight, 1)
    return r ? computeKrwFromRate(r, currencyRates) : null
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm border-collapse">
        <thead>
          <tr className="bg-gray-50">
            <th className="text-left py-2 px-3 font-semibold text-gray-700 border-b min-w-[90px]">
              무게
            </th>
            {sortedGrades.map((grade) => (
              <th
                key={grade.id}
                className="text-center py-2 px-3 font-semibold text-gray-700 border-b min-w-[120px]"
              >
                <div>{grade.grade_name}</div>
                {grade.discount_percent > 0 && (
                  <div className="text-xs font-normal text-blue-600">
                    {grade.discount_percent}% 할인
                  </div>
                )}
                {grade.min_shipments !== null && grade.min_shipments > 0 && (
                  <div className="text-xs font-normal text-gray-400">
                    {grade.min_shipments}회 이상
                  </div>
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {displayWeights.map((weight) => {
            const basePrice = getBasePrice(weight)
            const weightLabel = `${weight}kg`

            return (
              <tr key={weight} className="border-b hover:bg-blue-50/30 transition-colors">
                <td className="py-2 px-3 font-medium text-gray-700">{weightLabel}</td>
                {sortedGrades.map((grade) => {
                  const rate = findRate(weight, grade.grade_level)
                  const usdPrice = rate?.price_usd ?? null
                  const jpyPrice = rate?.price_jpy ?? null
                  const cnyPrice = rate?.price_cny ?? null
                  const krwPrice = rate ? computeKrwFromRate(rate, currencyRates) : null
                  const savings =
                    grade.grade_level > 1 && basePrice != null && krwPrice != null
                      ? basePrice - krwPrice
                      : null
                  const priceClass = `font-medium ${
                    grade.grade_level >= 3 ? 'text-blue-700' : 'text-gray-800'
                  }`

                  return (
                    <td key={grade.id} className="py-2 px-3 text-center">
                      {usdPrice !== null ? (
                        <div>
                          <span className={priceClass}>${usdPrice.toFixed(2)}</span>
                          {krwPrice !== null && (
                            <div className="text-xs text-gray-400">
                              ≈ {krwPrice.toLocaleString()}원
                            </div>
                          )}
                          {savings !== null && savings > 0 && (
                            <div className="text-xs text-green-600">
                              -{savings.toLocaleString()}원
                            </div>
                          )}
                        </div>
                      ) : jpyPrice !== null ? (
                        <div>
                          <span className={priceClass}>¥{jpyPrice.toLocaleString()}</span>
                          {krwPrice !== null && (
                            <div className="text-xs text-gray-400">
                              ≈ {krwPrice.toLocaleString()}원
                            </div>
                          )}
                          {savings !== null && savings > 0 && (
                            <div className="text-xs text-green-600">
                              -{savings.toLocaleString()}원
                            </div>
                          )}
                        </div>
                      ) : cnyPrice !== null ? (
                        <div>
                          <span className={priceClass}>元{cnyPrice.toLocaleString()}</span>
                          {krwPrice !== null && (
                            <div className="text-xs text-gray-400">
                              ≈ {krwPrice.toLocaleString()}원
                            </div>
                          )}
                          {savings !== null && savings > 0 && (
                            <div className="text-xs text-green-600">
                              -{savings.toLocaleString()}원
                            </div>
                          )}
                        </div>
                      ) : krwPrice !== null ? (
                        <div>
                          <span className={priceClass}>{krwPrice.toLocaleString()}원</span>
                          {savings !== null && savings > 0 && (
                            <div className="text-xs text-green-600 mt-0.5">
                              -{savings.toLocaleString()}원
                            </div>
                          )}
                        </div>
                      ) : (
                        <span className="text-gray-300">-</span>
                      )}
                    </td>
                  )
                })}
              </tr>
            )
          })}
        </tbody>
      </table>
      {isLbsBased && (
        <p className="text-xs text-gray-400 mt-2">
          * 원본 사이트 lbs 기준 요금 · 1 USD = {USD_RATE.toLocaleString()}원 환율 적용
        </p>
      )}
      {isJpyBased && (
        <p className="text-xs text-gray-400 mt-2">
          * 원본 사이트 엔화(¥) 기준 요금 · 1 JPY = {JPY_RATE}원 환율 적용
        </p>
      )}
      {isCnyBased && (
        <p className="text-xs text-gray-400 mt-2">
          * 원본 사이트 위안화(元) 기준 요금 · 1 CNY = {CNY_RATE}원 환율 적용
        </p>
      )}
    </div>
  )
}
