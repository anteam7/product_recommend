// /api/recommend/estimate — 카트 → 무게 추정 + 배대지 추천 + 부가서비스 옵션
//
// 흐름:
//   1) 카트 입력 검증
//   2) jimscanner_category_weights 일괄 조회 (필요한 카테고리만)
//   3) 카트 항목별 weight 룩업 + 합산
//   4) 국가/운송수단 결정
//   5) shipping_rates 조회 (해당 국가 + air/sea + 무게 구간 + grade_level)
//   6) forwarder_additional_services 조회 (합배송/검수 위주)
//   7) 응답 조립

import { NextResponse, type NextRequest } from 'next/server'
import { supabase } from '@/lib/supabase'
import {
  estimateItem,
  buildCartEstimate,
  recommendCountry,
  recommendShippingMode,
  weightToBracketKg,
  isSimplePrice,
  type WeightRow,
} from '@/lib/recommend/estimate'
import { calculateDuty, type DutyRow } from '@/lib/recommend/duty'
import { getCurrentRates } from '@/lib/current-rates'
import type {
  EstimateRequest,
  EstimateResponse,
  CartItemInput,
  Country,
  ShippingMode,
  ServiceOption,
  ForwarderRecommendation,
  DutyResponse,
} from '@/lib/recommend/types'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const VALID_COUNTRIES = new Set<Country>(['US', 'JP', 'CN'])
// shipping_rates 의 shipping_type 은 'air'/'sea'.
// manifest_items 측의 'boat'/'mixed' 는 estimate 입력에 안 들어옴 (사용자는 air/sea 만 선택).
const VALID_MODES = new Set<ShippingMode>(['air', 'sea'])

const SERVICE_CATEGORIES = ['합배송', '검수', '포장', '보험'] // v1 노출 카테고리

function parseItems(raw: unknown): CartItemInput[] | { error: string } {
  if (!Array.isArray(raw)) return { error: 'items 배열 필요' }
  if (raw.length === 0) return { error: '카트가 비었습니다' }
  if (raw.length > 30) return { error: '카트는 최대 30개 항목까지' }

  const out: CartItemInput[] = []
  for (const r of raw) {
    if (!r || typeof r !== 'object') return { error: 'item 형식 오류' }
    const o = r as Record<string, unknown>
    const category_tag = typeof o.category_tag === 'string' ? o.category_tag.trim() : ''
    if (!category_tag || category_tag.length > 60) return { error: 'category_tag 필수/길이초과' }
    const label_ko = typeof o.label_ko === 'string' ? o.label_ko.slice(0, 60) : category_tag
    const brand =
      typeof o.brand === 'string' && o.brand.trim() ? o.brand.trim().slice(0, 100) : null
    const pcs = Math.max(1, Math.min(999, Math.floor(Number(o.pcs) || 1)))
    const rawValue = Number(o.unit_value_usd)
    const unit_value_usd =
      Number.isFinite(rawValue) && rawValue > 0 ? Math.min(rawValue, 1_000_000) : null
    out.push({ category_tag, label_ko, brand, pcs, unit_value_usd })
  }
  return out
}

export async function POST(request: NextRequest) {
  let body: EstimateRequest
  try {
    body = (await request.json()) as EstimateRequest
  } catch {
    return NextResponse.json({ error: 'JSON 파싱 실패' }, { status: 400 })
  }

  const itemsParsed = parseItems(body.items as unknown)
  if (!Array.isArray(itemsParsed)) {
    return NextResponse.json({ error: itemsParsed.error }, { status: 400 })
  }
  const items = itemsParsed

  const overrideCountry =
    body.country && VALID_COUNTRIES.has(body.country as Country) ? (body.country as Country) : null
  const overrideMode =
    body.shipping_mode && VALID_MODES.has(body.shipping_mode as ShippingMode)
      ? (body.shipping_mode as ShippingMode)
      : null
  const grade_level = Math.max(1, Math.min(5, Math.floor(Number(body.member_grade_level) || 1)))
  const localShippingRaw = Number(body.local_shipping_usd)
  const local_shipping_usd =
    Number.isFinite(localShippingRaw) && localShippingRaw > 0
      ? Math.min(localShippingRaw, 1_000_000)
      : null

  const notes: string[] = []

  // ── 2) 카테고리 weights 일괄 조회 ──
  const categoryTags = Array.from(new Set(items.map((i) => i.category_tag)))
  const brands = Array.from(new Set(items.map((i) => i.brand).filter((b): b is string => !!b)))

  const { data: weightData, error: wErr } = await supabase
    .from('jimscanner_category_weights')
    .select('source_country, shipping_mode, category_tag, brand, sample_n, weight_p25_kg, weight_median_kg, weight_p75_kg, confidence')
    .in('category_tag', categoryTags)
  if (wErr) {
    return NextResponse.json({ error: `weights 조회 실패: ${wErr.message}` }, { status: 500 })
  }
  const weights: WeightRow[] = (weightData ?? []).map((r) => ({
    source_country: (r.source_country as Country | null) ?? null,
    shipping_mode: (r.shipping_mode as 'air' | 'boat' | 'mixed' | null) ?? null,
    category_tag: String(r.category_tag),
    brand: (r.brand as string | null) ?? null,
    sample_n: Number(r.sample_n ?? 0),
    weight_p25_kg: r.weight_p25_kg as number | null,
    weight_median_kg: Number(r.weight_median_kg ?? 0),
    weight_p75_kg: r.weight_p75_kg as number | null,
    confidence: (r.confidence as 'high' | 'mid' | 'low') ?? 'low',
  }))

  // ── 3) taxonomy 에서 default_country 조회 (국가 추천용) ──
  const { data: taxData } = await supabase
    .from('jimscanner_product_taxonomy')
    .select('category_tag, brand_canonical, default_country')
    .or(
      `category_tag.in.(${categoryTags.map((t) => `"${t}"`).join(',')})${
        brands.length ? `,brand_canonical.in.(${brands.map((b) => `"${b}"`).join(',')})` : ''
      }`,
    )

  const defaultCountries: Array<Country | null> = []
  for (const item of items) {
    // 브랜드 매칭 우선
    const brandRow = item.brand
      ? taxData?.find((t) => t.brand_canonical === item.brand)
      : undefined
    const catRow = taxData?.find(
      (t) => t.category_tag === item.category_tag && !t.brand_canonical,
    )
    defaultCountries.push(
      ((brandRow?.default_country ?? catRow?.default_country) as Country | null) ?? null,
    )
  }

  const country = recommendCountry(defaultCountries, overrideCountry)

  // ── 4) 항목별 추정 + 카트 합산 ──
  const itemEstimates = items.map((it) => estimateItem(weights, it, country))
  const cart = buildCartEstimate(itemEstimates)

  if (itemEstimates.some((e) => e.matched_source === 'no_match')) {
    notes.push('일부 항목은 표본이 없어 추정에서 제외되었습니다.')
  }
  if (cart.confidence === 'low') {
    notes.push('표본이 적어 추정 신뢰도가 낮습니다. 참고용으로만 사용해 주세요.')
  }

  // ── 5) 운송수단 결정 ──
  const mode = recommendShippingMode(cart.total_weight_kg.median, categoryTags, overrideMode)
  if (categoryTags.includes('FURNITURE')) {
    notes.push('가구 카테고리는 항운(sea)으로 자동 추천됩니다.')
  }

  // ── 관부가세 계산 (사용자가 가격 입력 시) ──
  const hasAnyValue = items.some((it) => (it.unit_value_usd ?? 0) > 0)
  let duty: DutyResponse | null = null
  if ((hasAnyValue || (local_shipping_usd ?? 0) > 0) && country) {
    const { data: dutyData } = await supabase
      .from('jimscanner_duty_rates')
      .select(
        'category_tag, label_ko, duty_rate_percent, vat_rate_percent, excise_rate_percent, excise_threshold_krw, personal_use_limit, personal_use_limit_unit, excluded_from_list_clearance, source, notes',
      )
      .in('category_tag', categoryTags)
      .eq('is_active', true)
    const dutyRows: DutyRow[] = (dutyData ?? []).map((r) => ({
      category_tag: String(r.category_tag),
      label_ko: String(r.label_ko),
      duty_rate_percent: Number(r.duty_rate_percent),
      vat_rate_percent: Number(r.vat_rate_percent),
      excise_rate_percent: r.excise_rate_percent === null ? null : Number(r.excise_rate_percent),
      excise_threshold_krw:
        r.excise_threshold_krw === null ? null : Number(r.excise_threshold_krw),
      personal_use_limit: r.personal_use_limit === null ? null : Number(r.personal_use_limit),
      personal_use_limit_unit: (r.personal_use_limit_unit as string | null) ?? null,
      excluded_from_list_clearance: Boolean(r.excluded_from_list_clearance),
      source: (r.source as string | null) ?? null,
      notes: (r.notes as string | null) ?? null,
    }))
    const rates = await getCurrentRates()
    const dutyEst = calculateDuty({
      items: items.map((it) => ({
        category_tag: it.category_tag,
        pcs: it.pcs,
        unit_value_usd: it.unit_value_usd ?? null,
      })),
      rates: dutyRows,
      country,
      shipping_mode: mode,
      usdToKrw: rates.USD,
      localShippingUsd: local_shipping_usd,
    })
    duty = { ...dutyEst, usd_to_krw: rates.USD }
  }

  // 카트가 비어있거나 0kg면 forwarders 빈 결과
  if (cart.total_weight_kg.median <= 0 || !country) {
    return NextResponse.json({
      cart,
      recommended_country: country,
      recommended_mode: mode,
      forwarders: [],
      duty,
      notes: country
        ? notes
        : [...notes, '추천 국가를 결정할 수 없습니다. 국가를 직접 선택해 주세요.'],
    } satisfies EstimateResponse)
  }

  // ── 6) shipping_rates 조회 ──
  const w = weightToBracketKg(cart.total_weight_kg.median)
  const { data: rateRows, error: rErr } = await supabase
    .from('shipping_rates')
    .select('id, forwarder_id, country, center_name, weight_min, weight_max, price_krw, member_grade, grade_level, shipping_type')
    .eq('country', country)
    .eq('shipping_type', mode)
    .eq('grade_level', grade_level)
    .lte('weight_min', w)
    .gt('weight_max', w)
    .not('price_krw', 'is', null)
    .order('price_krw', { ascending: true })
    .limit(30)
  if (rErr) {
    return NextResponse.json({ error: `rates 조회 실패: ${rErr.message}` }, { status: 500 })
  }

  if (!rateRows || rateRows.length === 0) {
    notes.push(
      `${country}/${mode} ${w}kg 구간에 가격 등록된 배대지가 없습니다. 다른 운송수단/국가를 시도해 주세요.`,
    )
    return NextResponse.json({
      cart,
      recommended_country: country,
      recommended_mode: mode,
      forwarders: [],
      duty,
      notes,
    } satisfies EstimateResponse)
  }

  // ── forwarder 메타 + 부가서비스 일괄 조회 ──
  const forwarderIds = Array.from(new Set(rateRows.map((r) => String(r.forwarder_id))))
  const [{ data: fwData }, { data: svcData }] = await Promise.all([
    supabase
      .from('forwarders')
      .select('id, slug, name, logo_url')
      .in('id', forwarderIds)
      .eq('is_active', true),
    supabase
      .from('forwarder_additional_services')
      .select('id, forwarder_id, category, service_name, price_text, price_numeric')
      .in('forwarder_id', forwarderIds)
      .in('category', SERVICE_CATEGORIES)
      .eq('is_active', true),
  ])

  const fwMap = new Map<string, { slug: string; name: string; logo_url: string | null }>()
  for (const f of fwData ?? []) {
    fwMap.set(String(f.id), {
      slug: String(f.slug),
      name: String(f.name),
      logo_url: (f.logo_url as string | null) ?? null,
    })
  }

  const svcByFw = new Map<string, ServiceOption[]>()
  for (const s of svcData ?? []) {
    const fid = String(s.forwarder_id)
    const arr = svcByFw.get(fid) ?? []
    const priceNum = s.price_numeric === null ? null : Number(s.price_numeric)
    const priceText = (s.price_text as string | null) ?? null
    arr.push({
      id: String(s.id),
      category: String(s.category),
      service_name: String(s.service_name),
      price_krw: priceNum,
      price_text: priceText,
      is_simple: isSimplePrice(priceText, priceNum),
    })
    svcByFw.set(fid, arr)
  }

  // 같은 forwarder_id 의 여러 rate 행이 있을 수 있어 (센터 여러 개) — 가장 싼 것 1개만 노출
  const seenForwarder = new Set<string>()
  const recommendations: ForwarderRecommendation[] = []
  for (const r of rateRows) {
    const fid = String(r.forwarder_id)
    if (seenForwarder.has(fid)) continue
    const meta = fwMap.get(fid)
    if (!meta) continue
    seenForwarder.add(fid)
    recommendations.push({
      forwarder_id: fid,
      slug: meta.slug,
      name: meta.name,
      logo_url: meta.logo_url,
      country: r.country as Country,
      shipping_type: r.shipping_type as ShippingMode,
      center_name: (r.center_name as string | null) ?? null,
      weight_bracket: { min: Number(r.weight_min), max: Number(r.weight_max) },
      base_price_krw: Number(r.price_krw),
      member_grade: String(r.member_grade ?? ''),
      grade_level: Number(r.grade_level ?? 1),
      available_services: svcByFw.get(fid) ?? [],
    })
  }

  return NextResponse.json({
    cart,
    recommended_country: country,
    recommended_mode: mode,
    forwarders: recommendations,
    duty,
    notes,
  } satisfies EstimateResponse)
}
