'use client'

import { useMemo, useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { TRACKED_CURRENCIES, type Currency } from '@/lib/exchange-rates'

const FLAGS: Record<Currency, string> = {
  USD: '🇺🇸',
  JPY: '🇯🇵',
  CNY: '🇨🇳',
  EUR: '🇪🇺',
}

const LABELS: Record<Currency, string> = {
  USD: '달러',
  JPY: '엔',
  CNY: '위안',
  EUR: '유로',
}

type LatestRates = Partial<Record<Currency, number>>

function formatKRW(v: number, digits = 0) {
  return v.toLocaleString('ko-KR', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })
}

function formatForeign(v: number) {
  return v.toLocaleString('ko-KR', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  })
}

export function CurrencyConverter({ rates }: { rates: LatestRates }) {
  const availableCurrencies = useMemo(
    () => TRACKED_CURRENCIES.filter((c) => rates[c] != null),
    [rates],
  )

  const [currency, setCurrency] = useState<Currency>(availableCurrencies[0] ?? 'USD')
  const [direction, setDirection] = useState<'toKrw' | 'fromKrw'>('toKrw')
  const [amount, setAmount] = useState<string>('100')

  const rate = rates[currency]
  const num = Number(amount.replace(/,/g, ''))
  const valid = Number.isFinite(num) && num >= 0 && rate != null

  const converted = valid
    ? direction === 'toKrw'
      ? num * (rate as number)
      : num / (rate as number)
    : null

  const swap = () => setDirection((d) => (d === 'toKrw' ? 'fromKrw' : 'toKrw'))

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2 flex-wrap">
          <span>💱 환율 계산기</span>
          <span className="text-xs text-gray-500 font-normal">
            오늘의 매매기준율로 즉시 환산
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-1 md:grid-cols-[1fr_auto_1fr] gap-3 md:gap-4 items-stretch">
          {/* 입력 쪽 */}
          <div className="border rounded-lg p-3 bg-white">
            <div className="text-xs text-gray-500 mb-1">
              {direction === 'toKrw' ? '외화 금액' : '원화 금액'}
            </div>
            <div className="flex items-center gap-2">
              {direction === 'toKrw' ? (
                <select
                  value={currency}
                  onChange={(e) => setCurrency(e.target.value as Currency)}
                  className="border rounded-md px-2 py-1.5 bg-white text-sm font-medium"
                  aria-label="통화 선택"
                >
                  {availableCurrencies.map((c) => (
                    <option key={c} value={c}>
                      {FLAGS[c]} {c}
                    </option>
                  ))}
                </select>
              ) : (
                <span className="px-2 py-1.5 text-sm font-medium">🇰🇷 KRW</span>
              )}
              <input
                type="text"
                inputMode="decimal"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                className="border rounded-md px-3 py-1.5 text-lg font-semibold flex-1 min-w-0 tabular-nums text-right"
                placeholder="0"
                aria-label="금액 입력"
              />
            </div>
          </div>

          {/* 방향 전환 */}
          <button
            type="button"
            onClick={swap}
            className="self-center border rounded-full p-2 bg-white hover:bg-gray-50 active:scale-95 transition-all text-gray-500"
            aria-label="통화 방향 전환"
            title="방향 바꾸기"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M7 16V4M7 4L3 8M7 4l4 4" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M17 8v12M17 20l4-4M17 20l-4-4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>

          {/* 결과 쪽 */}
          <div className="border rounded-lg p-3 bg-blue-50/60 border-blue-100">
            <div className="text-xs text-gray-500 mb-1">
              {direction === 'toKrw' ? '원화 환산' : `${LABELS[currency]} 환산`}
            </div>
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-sm text-gray-600 font-medium shrink-0">
                {direction === 'toKrw' ? '🇰🇷 KRW' : (
                  <span>{FLAGS[currency]} {currency}</span>
                )}
              </span>
              <span className="text-2xl font-bold text-gray-900 tabular-nums text-right truncate">
                {converted == null
                  ? '—'
                  : direction === 'toKrw'
                    ? formatKRW(converted)
                    : formatForeign(converted)}
              </span>
            </div>
          </div>
        </div>

        <div className="mt-3 text-xs text-gray-500">
          {rate != null ? (
            <>
              기준 환율 —{' '}
              <strong className="text-gray-700">
                1 {currency} = {rate.toLocaleString('ko-KR', { maximumFractionDigits: 4 })}원
              </strong>
              {currency === 'JPY' && (
                <span className="text-gray-400"> · 100엔 단위로 보려면 표를 참고하세요</span>
              )}
            </>
          ) : (
            '환율 데이터를 불러오는 중입니다.'
          )}
        </div>
      </CardContent>
    </Card>
  )
}
