'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import type {
  EstimateResponse,
  ForwarderRecommendation,
  SearchResult,
  Country,
  ShippingMode,
  DutyResponse,
} from '@/lib/recommend/types'
import {
  searchTaxonomy,
  estimateCart,
  searchResultToCartItem,
  totalForForwarder,
  sortForwarders,
  partitionServices,
  formatKrw,
  formatKg,
  COUNTRY_LABEL,
  MODE_LABEL,
  CONFIDENCE_LABEL,
  type CartItem,
  type SelectedServices,
  type SortKey,
} from '@/lib/recommend/client-utils'

export default function RecommendApp() {
  // ─── 카트 상태 ───
  const [cart, setCart] = useState<CartItem[]>([])
  const [country, setCountry] = useState<Country | 'auto'>('auto')
  const [mode, setMode] = useState<ShippingMode | 'auto'>('auto')
  const [sortKey, setSortKey] = useState<SortKey>('base_price')
  const [selected, setSelected] = useState<SelectedServices>({})
  const [localShippingUsd, setLocalShippingUsd] = useState<string>('') // 사용자 입력 raw (USD)

  // ─── 추정 결과 ───
  const [estimate, setEstimate] = useState<EstimateResponse | null>(null)
  const [estimating, setEstimating] = useState(false)
  const [estimateError, setEstimateError] = useState<string | null>(null)

  // 카트/옵션 변경 시 자동 재추정 (디바운스)
  const lastReqRef = useRef(0)
  useEffect(() => {
    if (cart.length === 0) {
      setEstimate(null)
      setEstimateError(null)
      return
    }
    const reqId = ++lastReqRef.current
    setEstimating(true)
    const timer = setTimeout(async () => {
      const localShipNum = Number(localShippingUsd)
      const res = await estimateCart({
        items: cart.map((c) => ({
          label_ko: c.label_ko,
          category_tag: c.category_tag,
          brand: c.brand,
          pcs: c.pcs,
          unit_value_usd: c.unit_value_usd,
        })),
        country: country === 'auto' ? null : country,
        shipping_mode: mode === 'auto' ? null : mode,
        member_grade_level: 1,
        local_shipping_usd:
          Number.isFinite(localShipNum) && localShipNum > 0 ? localShipNum : null,
      })
      if (reqId !== lastReqRef.current) return
      setEstimating(false)
      if ('error' in res) {
        setEstimateError(res.error)
        setEstimate(null)
      } else {
        setEstimate(res)
        setEstimateError(null)
      }
    }, 200)
    return () => clearTimeout(timer)
  }, [cart, country, mode, localShippingUsd])

  // ─── 카트 조작 ───
  const addItem = useCallback((r: SearchResult) => {
    const item = searchResultToCartItem(r, 1)
    if (!item) return
    setCart((prev) => {
      // 같은 (category_tag + brand) 조합이면 수량만 +1
      const idx = prev.findIndex(
        (p) => p.category_tag === item.category_tag && p.brand === item.brand,
      )
      if (idx >= 0) {
        const clone = [...prev]
        clone[idx] = { ...clone[idx], pcs: clone[idx].pcs + 1 }
        return clone
      }
      return [...prev, item]
    })
  }, [])

  const updatePcs = useCallback((key: string, delta: number) => {
    setCart((prev) =>
      prev
        .map((c) => (c.key === key ? { ...c, pcs: Math.max(1, Math.min(999, c.pcs + delta)) } : c))
    )
  }, [])

  const updateUnitValue = useCallback((key: string, raw: string) => {
    const trimmed = raw.trim()
    setCart((prev) =>
      prev.map((c) => {
        if (c.key !== key) return c
        if (trimmed === '') return { ...c, unit_value_usd: null }
        const n = Number(trimmed)
        if (!Number.isFinite(n) || n <= 0) return { ...c, unit_value_usd: null }
        return { ...c, unit_value_usd: Math.min(n, 1_000_000) }
      }),
    )
  }, [])

  const removeItem = useCallback((key: string) => {
    setCart((prev) => prev.filter((c) => c.key !== key))
  }, [])

  const toggleService = useCallback((forwarderId: string, serviceId: string) => {
    setSelected((prev) => {
      const set = new Set(prev[forwarderId] ?? [])
      if (set.has(serviceId)) set.delete(serviceId)
      else set.add(serviceId)
      return { ...prev, [forwarderId]: set }
    })
  }, [])

  const sortedForwarders = useMemo(() => {
    if (!estimate) return []
    return sortForwarders(estimate.forwarders, selected, sortKey)
  }, [estimate, selected, sortKey])

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
      <div className="space-y-6">
        <SearchPanel onPick={addItem} />
        <CartPanel
          cart={cart}
          onUpdatePcs={updatePcs}
          onUpdateUnitValue={updateUnitValue}
          onRemove={removeItem}
          estimate={estimate}
          localShippingUsd={localShippingUsd}
          onLocalShippingChange={setLocalShippingUsd}
        />
      </div>
      <div className="space-y-6">
        <ResultPanel
          estimate={estimate}
          estimating={estimating}
          error={estimateError}
          country={country}
          mode={mode}
          onCountry={setCountry}
          onMode={setMode}
          sortKey={sortKey}
          onSortKey={setSortKey}
          forwarders={sortedForwarders}
          selected={selected}
          onToggleService={toggleService}
        />
      </div>
    </div>
  )
}

// ============================================================
// 검색 패널
// ============================================================
function SearchPanel({ onPick }: { onPick: (r: SearchResult) => void }) {
  const searchParams = useSearchParams()
  const initialQ = searchParams?.get('q')?.trim() ?? ''
  const [q, setQ] = useState(initialQ)
  const [results, setResults] = useState<SearchResult[]>([])
  const [featured, setFeatured] = useState<SearchResult[]>([])
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)
  const listboxId = 'recommend-search-listbox'
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([])

  // featured 한 번만 로드
  useEffect(() => {
    void searchTaxonomy('').then(setFeatured)
  }, [])

  // q 디바운스 검색
  useEffect(() => {
    if (!q.trim()) {
      setResults([])
      setOpen(false)
      return
    }
    const t = setTimeout(async () => {
      const r = await searchTaxonomy(q)
      setResults(r)
      setOpen(true)
      setActiveIndex(0) // 새 결과마다 첫 항목으로 리셋
    }, 150)
    return () => clearTimeout(t)
  }, [q])

  // 활성 인덱스 변경 시 보이도록 스크롤
  useEffect(() => {
    if (!open) return
    const el = itemRefs.current[activeIndex]
    el?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex, open])

  function commitPick(r: SearchResult) {
    onPick(r)
    setQ('')
    setOpen(false)
    setActiveIndex(0)
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!open || results.length === 0) {
      // 닫혀 있어도 ArrowDown 누르면 결과 표시 시도
      if (e.key === 'ArrowDown' && results.length > 0) {
        setOpen(true)
        e.preventDefault()
      }
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveIndex((i) => (i + 1) % results.length)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIndex((i) => (i - 1 + results.length) % results.length)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const r = results[activeIndex]
      if (r) commitPick(r)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      setOpen(false)
    } else if (e.key === 'Home') {
      e.preventDefault()
      setActiveIndex(0)
    } else if (e.key === 'End') {
      e.preventDefault()
      setActiveIndex(results.length - 1)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">상품 검색</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="relative">
          <Input
            placeholder="청바지, 나이키, 영양제, 피규어..."
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onFocus={() => results.length > 0 && setOpen(true)}
            onBlur={() => setTimeout(() => setOpen(false), 150)}
            onKeyDown={onKeyDown}
            role="combobox"
            aria-expanded={open && results.length > 0}
            aria-controls={listboxId}
            aria-autocomplete="list"
            aria-activedescendant={
              open && results.length > 0 ? `${listboxId}-opt-${activeIndex}` : undefined
            }
          />
          {open && results.length > 0 && (
            <div
              id={listboxId}
              role="listbox"
              className="absolute left-0 right-0 top-full z-20 mt-1 max-h-80 overflow-y-auto rounded-md border bg-background shadow-md"
            >
              {results.map((r, i) => {
                const noSample = r.kind === 'brand' || r.kind === 'ip'
                const hasSample = r.sample_n != null && r.sample_n > 0
                const tip =
                  hasSample && r.weight_median_kg != null
                    ? `≈ ${formatKg(r.weight_median_kg)} · 표본 ${r.sample_n}건`
                    : noSample
                      ? '표본 없음 · 카트에 담으면 카테고리를 선택하세요'
                      : ''
                const isActive = i === activeIndex
                return (
                  <button
                    key={`${r.kind}_${r.label_ko}_${i}`}
                    ref={(el) => {
                      itemRefs.current[i] = el
                    }}
                    id={`${listboxId}-opt-${i}`}
                    type="button"
                    role="option"
                    aria-selected={isActive}
                    className={
                      'flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm transition ' +
                      (isActive ? 'bg-accent text-accent-foreground' : 'hover:bg-accent')
                    }
                    onMouseEnter={() => setActiveIndex(i)}
                    onMouseDown={(e) => {
                      e.preventDefault()
                      commitPick(r)
                    }}
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="text-base">{r.icon_emoji ?? '🔹'}</span>
                      <span className="truncate font-medium">{r.label_ko}</span>
                      <KindBadge kind={r.kind} />
                    </span>
                    <span className="ml-2 shrink-0 text-xs text-muted-foreground">
                      {tip || (r.default_country ? COUNTRY_LABEL[r.default_country] : '')}
                    </span>
                  </button>
                )
              })}
            </div>
          )}
        </div>

        <div>
          <p className="mb-2 text-xs text-muted-foreground">또는 인기 카테고리</p>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {featured.map((r, i) => (
              <button
                key={`f_${r.label_ko}_${i}`}
                type="button"
                onClick={() => onPick(r)}
                className="flex items-center gap-2 rounded-md border bg-card px-3 py-2 text-sm transition hover:bg-accent"
              >
                <span className="text-lg">{r.icon_emoji ?? '🔹'}</span>
                <span className="font-medium">{r.label_ko}</span>
              </button>
            ))}
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

function KindBadge({ kind }: { kind: SearchResult['kind'] }) {
  if (kind === 'brand_category') return null // 라벨에 이미 "브랜드 · 카테고리" 형태로 표시됨
  const label = kind === 'category' ? '카테고리' : kind === 'brand' ? '브랜드' : 'IP'
  return (
    <Badge variant="outline" className="text-[10px]">
      {label}
    </Badge>
  )
}

// ============================================================
// 카트 패널
// ============================================================
function CartPanel({
  cart,
  onUpdatePcs,
  onUpdateUnitValue,
  onRemove,
  estimate,
  localShippingUsd,
  onLocalShippingChange,
}: {
  cart: CartItem[]
  onUpdatePcs: (key: string, delta: number) => void
  onUpdateUnitValue: (key: string, raw: string) => void
  onRemove: (key: string) => void
  estimate: EstimateResponse | null
  localShippingUsd: string
  onLocalShippingChange: (v: string) => void
}) {
  const hasAnyValue = cart.some((c) => c.unit_value_usd != null && c.unit_value_usd > 0)
  const hasShipping = localShippingUsd.trim() !== '' && Number(localShippingUsd) > 0
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center justify-between text-lg">
          <span>🛒 내 카트</span>
          {cart.length > 0 && <span className="text-sm font-normal text-muted-foreground">{cart.length}개 항목</span>}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {cart.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            상품을 검색하거나 인기 카테고리를 클릭해 카트에 담아보세요.
          </p>
        ) : (
          <div className="space-y-2">
            {cart.map((item) => {
              const est = estimate?.cart.items.find(
                (x) => x.input.category_tag === item.category_tag && x.input.brand === item.brand,
              )
              const wt = est?.weight_per_pc_kg
                ? `${formatKg(est.weight_per_pc_kg.median * item.pcs)} (개당 ${formatKg(est.weight_per_pc_kg.median)})`
                : est?.matched_source === 'no_match'
                  ? '추정 표본 없음'
                  : '추정 중...'
              const hasValue = item.unit_value_usd != null && item.unit_value_usd > 0
              return (
                <div key={item.key} className="rounded-md border p-2">
                  <div className="flex items-center gap-2">
                    <span className="text-lg">{item.icon_emoji ?? '🔹'}</span>
                    <div className="flex-1 min-w-0">
                      <div className="truncate text-sm font-medium">{item.label_ko}</div>
                      <div className="truncate text-xs text-muted-foreground">{wt}</div>
                    </div>
                    <div className="flex items-center gap-1">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-7 w-7 p-0"
                        onClick={() => onUpdatePcs(item.key, -1)}
                        disabled={item.pcs <= 1}
                      >
                        −
                      </Button>
                      <span className="w-7 text-center text-sm font-medium">{item.pcs}</span>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-7 w-7 p-0"
                        onClick={() => onUpdatePcs(item.key, 1)}
                      >
                        +
                      </Button>
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-7 w-7 p-0 text-rose-600 hover:bg-rose-50 hover:text-rose-700"
                      onClick={() => onRemove(item.key)}
                      aria-label="삭제"
                    >
                      ✕
                    </Button>
                  </div>
                  <label
                    className={
                      'mt-2 flex items-center gap-2 rounded-md border px-2 py-1.5 transition ' +
                      (hasValue
                        ? 'border-emerald-300 bg-emerald-50/60'
                        : 'border-dashed border-blue-300 bg-blue-50/40 hover:bg-blue-50')
                    }
                  >
                    <span className="text-base" aria-hidden>💵</span>
                    <span className="text-xs font-medium text-gray-700">
                      개당 가격
                    </span>
                    <span className="font-semibold text-gray-700">$</span>
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      inputMode="decimal"
                      placeholder="0.00 — 입력 시 관부가세 자동 계산"
                      value={item.unit_value_usd ?? ''}
                      onChange={(e) => onUpdateUnitValue(item.key, e.target.value)}
                      className="h-8 flex-1 min-w-0 rounded border bg-white px-2 text-sm font-medium focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                    />
                    {hasValue && item.pcs > 1 && (
                      <span className="ml-auto whitespace-nowrap text-xs font-medium text-emerald-700">
                        ×{item.pcs} = ${(item.unit_value_usd! * item.pcs).toFixed(2)}
                      </span>
                    )}
                  </label>
                </div>
              )
            })}
            {estimate && (
              <div className="mt-3 rounded-md bg-muted p-3 text-sm">
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">총 무게</span>
                  <span className="font-bold">
                    {formatKg(estimate.cart.total_weight_kg.median)}{' '}
                    <span className="text-xs font-normal text-muted-foreground">
                      ({formatKg(estimate.cart.total_weight_kg.p25)} ~{' '}
                      {formatKg(estimate.cart.total_weight_kg.p75)})
                    </span>
                  </span>
                </div>
                <div className="mt-1 flex items-center justify-between text-xs">
                  <span className="text-muted-foreground">신뢰도</span>
                  <span className={CONFIDENCE_LABEL[estimate.cart.confidence].tone}>
                    {CONFIDENCE_LABEL[estimate.cart.confidence].emoji}{' '}
                    {CONFIDENCE_LABEL[estimate.cart.confidence].ko}
                  </span>
                </div>
              </div>
            )}
            {cart.length > 0 && hasAnyValue && (
              <label
                className={
                  'mt-2 flex items-center gap-2 rounded-md border px-2 py-2 transition ' +
                  (hasShipping
                    ? 'border-emerald-300 bg-emerald-50/60'
                    : 'border-dashed border-blue-300 bg-blue-50/40 hover:bg-blue-50')
                }
              >
                <span className="text-base" aria-hidden>📦</span>
                <span className="text-xs font-medium text-gray-700 whitespace-nowrap">
                  현지 배송비
                </span>
                <span className="text-[10px] text-muted-foreground whitespace-nowrap">
                  (사이트 → 배대지)
                </span>
                <span className="font-semibold text-gray-700">$</span>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  inputMode="decimal"
                  placeholder="0.00 — 면세한도/부가세 정확도 ↑"
                  value={localShippingUsd}
                  onChange={(e) => onLocalShippingChange(e.target.value)}
                  className="h-8 flex-1 min-w-0 rounded border bg-white px-2 text-sm font-medium focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
              </label>
            )}
            {cart.length > 0 && !hasAnyValue && (
              <div className="mt-2 rounded-md border border-dashed border-blue-300 bg-blue-50/60 p-2 text-center text-xs text-blue-800">
                💡 각 상품의 <strong>개당 가격(USD)</strong> + <strong>현지 배송비</strong>를 입력하면 관부가세가 자동 계산됩니다.
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

// ============================================================
// 결과 패널
// ============================================================
function ResultPanel({
  estimate,
  estimating,
  error,
  country,
  mode,
  onCountry,
  onMode,
  sortKey,
  onSortKey,
  forwarders,
  selected,
  onToggleService,
}: {
  estimate: EstimateResponse | null
  estimating: boolean
  error: string | null
  country: Country | 'auto'
  mode: ShippingMode | 'auto'
  onCountry: (c: Country | 'auto') => void
  onMode: (m: ShippingMode | 'auto') => void
  sortKey: SortKey
  onSortKey: (k: SortKey) => void
  forwarders: ForwarderRecommendation[]
  selected: SelectedServices
  onToggleService: (forwarderId: string, serviceId: string) => void
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">📦 배대지 추천</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* 국가/운송수단/정렬 컨트롤 */}
        <div className="grid grid-cols-3 gap-2">
          <div>
            <label className="text-xs text-muted-foreground">국가</label>
            <Select value={country} onValueChange={(v) => onCountry(v as Country | 'auto')}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">
                  자동{estimate?.recommended_country ? ` (${COUNTRY_LABEL[estimate.recommended_country]})` : ''}
                </SelectItem>
                <SelectItem value="US">{COUNTRY_LABEL.US}</SelectItem>
                <SelectItem value="JP">{COUNTRY_LABEL.JP}</SelectItem>
                <SelectItem value="CN">{COUNTRY_LABEL.CN}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <label className="text-xs text-muted-foreground">운송</label>
            <Select value={mode} onValueChange={(v) => onMode(v as ShippingMode | 'auto')}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">
                  자동{estimate ? ` (${MODE_LABEL[estimate.recommended_mode]})` : ''}
                </SelectItem>
                <SelectItem value="air">{MODE_LABEL.air}</SelectItem>
                <SelectItem value="sea">{MODE_LABEL.sea}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <label className="text-xs text-muted-foreground">정렬</label>
            <Select value={sortKey} onValueChange={(v) => onSortKey(v as SortKey)}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="base_price">기본 운임</SelectItem>
                <SelectItem value="total_with_services">부가서비스 포함</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        {error && (
          <div className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">
            {error}
          </div>
        )}

        {!estimate && !estimating && !error && (
          <p className="py-8 text-center text-sm text-muted-foreground">
            카트에 상품을 담으면 배대지를 추천해 드립니다.
          </p>
        )}
        {estimating && !estimate && (
          <p className="py-8 text-center text-sm text-muted-foreground">계산 중...</p>
        )}

        {estimate && estimate.notes.length > 0 && (
          <ul className="space-y-1 rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
            {estimate.notes.map((n, i) => (
              <li key={i}>· {n}</li>
            ))}
          </ul>
        )}

        {estimate?.duty && estimate.duty.has_value_input && (
          <DutyCard duty={estimate.duty} />
        )}

        {forwarders.length > 0 && (
          <div className="space-y-3">
            {forwarders.map((fw, idx) => (
              <ForwarderCard
                key={fw.forwarder_id}
                fw={fw}
                isCheapest={idx === 0}
                selected={selected[fw.forwarder_id]}
                onToggle={(sid) => onToggleService(fw.forwarder_id, sid)}
              />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function DutyCard({ duty }: { duty: DutyResponse }) {
  const tone = duty.is_over_threshold || duty.by_category.some((c) => c.is_personal_use_exceeded)
    ? 'border-rose-300 bg-rose-50'
    : 'border-emerald-300 bg-emerald-50/60'

  return (
    <div className={'rounded-lg border p-3 ' + tone}>
      <div className="flex items-center justify-between">
        <div>
          <div className="text-sm font-semibold">💰 관부가세 추정</div>
          <div className="mt-0.5 text-[11px] text-muted-foreground">
            상품가 ${duty.total_value_usd.toFixed(2)}
            {duty.local_shipping_usd > 0 && (
              <> + 현지배송 ${duty.local_shipping_usd.toFixed(2)}</>
            )}
            {' '}= 합계 <strong>${duty.cif_usd.toFixed(2)}</strong>
            {' (≈ ₩'}{duty.cif_krw.toLocaleString()}{')'}
            {' · '}면세한도 ${duty.threshold_usd}
            {duty.threshold_reason === 'fta_us_air' && ' (한미 FTA)'}
            {duty.threshold_reason === 'excluded_categories' && ' (목록통관 배제)'}
          </div>
        </div>
        <div className="text-right">
          <div className="text-lg font-bold">
            ₩{duty.total_tax_krw.toLocaleString()}
          </div>
          <div className="text-[11px] text-muted-foreground">
            관세 ₩{duty.total_duty_krw.toLocaleString()}
            {duty.total_excise_krw > 0 && ` + 개별소비세 ₩${duty.total_excise_krw.toLocaleString()}`}
            {' + 부가세 ₩' + duty.total_vat_krw.toLocaleString()}
          </div>
        </div>
      </div>

      {!duty.is_over_threshold &&
        !duty.by_category.some((c) => c.is_personal_use_exceeded) && (
          <p className="mt-2 text-xs text-emerald-800">
            ✓ 면세한도 내 — 관부가세 부과 없음
          </p>
        )}

      {duty.by_category.some((c) => c.duty_krw > 0) && (
        <div className="mt-2 space-y-1 border-t pt-2 text-xs">
          {duty.by_category
            .filter((c) => c.duty_krw > 0 || c.is_personal_use_exceeded)
            .map((c) => (
              <div key={c.category_tag} className="flex items-center justify-between">
                <span>
                  {c.label_ko}
                  <span className="ml-1 text-muted-foreground">
                    (${c.value_usd.toFixed(2)}, {c.duty_rate_percent}%)
                  </span>
                </span>
                <span className="font-medium">
                  ₩{c.duty_krw.toLocaleString()}
                  {c.excise_krw > 0 && ` (+₩${c.excise_krw.toLocaleString()})`}
                </span>
              </div>
            ))}
        </div>
      )}

      <p className="mt-2 text-[10px] text-muted-foreground">
        ⚠️ 일반 간이세율/일반관세 기준 추정치. 실제 부과액은 통관 시 결정됩니다. 환율 ₩
        {duty.usd_to_krw.toLocaleString()}/USD.
      </p>
    </div>
  )
}

function ForwarderCard({
  fw,
  isCheapest,
  selected,
  onToggle,
}: {
  fw: ForwarderRecommendation
  isCheapest: boolean
  selected: Set<string> | undefined
  onToggle: (serviceId: string) => void
}) {
  const total = totalForForwarder(fw, selected)
  const { toggleable, informational } = partitionServices(fw.available_services)
  const extra = total - fw.base_price_krw

  return (
    <div
      className={
        'rounded-lg border p-3 ' +
        (isCheapest ? 'border-emerald-300 bg-emerald-50/60' : 'bg-card')
      }
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="truncate font-semibold">{fw.name}</span>
            {isCheapest && (
              <Badge className="bg-emerald-600 text-xs hover:bg-emerald-700">최저가</Badge>
            )}
          </div>
          <div className="mt-0.5 text-xs text-muted-foreground">
            {fw.center_name ? `${fw.center_name} · ` : ''}
            {fw.weight_bracket.min}~{fw.weight_bracket.max}kg · {fw.member_grade}
          </div>
        </div>
        <div className="text-right">
          <div className="text-lg font-bold">{formatKrw(total)}</div>
          {extra > 0 && (
            <div className="text-xs text-muted-foreground">
              운임 {formatKrw(fw.base_price_krw)} + 옵션 {formatKrw(extra)}
            </div>
          )}
        </div>
      </div>

      {(toggleable.length > 0 || informational.length > 0) && (
        <div className="mt-3 space-y-2 border-t pt-2">
          {toggleable.length > 0 && (
            <div>
              <div className="mb-1 text-[11px] font-medium text-muted-foreground">부가서비스</div>
              <div className="flex flex-wrap gap-2">
                {toggleable.map((s) => {
                  const checked = selected?.has(s.id) ?? false
                  const free = s.price_krw === 0
                  return (
                    <label
                      key={s.id}
                      className={
                        'flex cursor-pointer items-center gap-1.5 rounded-md border px-2 py-1 text-xs transition ' +
                        (checked ? 'border-emerald-400 bg-emerald-50' : 'hover:bg-accent')
                      }
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => onToggle(s.id)}
                        className="size-3"
                      />
                      <span className="font-medium">[{s.category}]</span>
                      <span className="truncate max-w-[140px]">{s.service_name}</span>
                      <span className={free ? 'text-emerald-700' : 'text-muted-foreground'}>
                        {free ? '무료' : formatKrw(s.price_krw ?? 0)}
                      </span>
                    </label>
                  )
                })}
              </div>
            </div>
          )}
          {informational.length > 0 && (
            <details className="text-xs">
              <summary className="cursor-pointer text-muted-foreground">
                별도 문의 옵션 {informational.length}건
              </summary>
              <ul className="mt-1 space-y-0.5 pl-2">
                {informational.map((s) => (
                  <li key={s.id} className="text-muted-foreground">
                    · [{s.category}] {s.service_name} —{' '}
                    <span className="italic">{s.price_text ?? '문의'}</span>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
    </div>
  )
}
