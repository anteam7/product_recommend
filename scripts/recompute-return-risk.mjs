#!/usr/bin/env node
/**
 * 반품·교환 보정 실효마진 게이트 — 재계산 스크립트 (로컬 전용).
 *
 * commerce_score·순마진은 '판매 성사' 기준일 뿐, 위탁 셀러가 실제로 떠안는
 * 반품·교환 비용(왕복배송비 + 재포장 손실 + 불량 폐기)을 반영하지 못한다.
 * 본 스크립트는 product 별로
 *   (1) category_top 기반 한국 이커머스 반품률 사전치
 *   (2) raw/market 본문에서 alias 와 동반 출현하는 반품 토큰 빈도(buzz)
 *   (3) 사이즈/색상 변형 페널티
 * 를 합쳐 estimated_return_rate 를 구하고, 도매가·SHIP 상수로 반품 1건당
 * 손실을 추정해 순마진을 할인한 effective_margin_ratio 를 적재한다.
 *
 * 호출:
 *   node --env-file=.env.local scripts/recompute-return-risk.mjs
 *
 * 요구 사항:
 *   - NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (env)
 *   - 마이그레이션 적용: supabase/trends_return_risk.sql
 */

import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
  process.exit(1)
}

const sb = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false },
})

// 쿠팡 가격모델과 동기화된 상수 (docs / coupang_pricing_model 참고)
const SHIP = 3000 // 편도 배송비(원)
const FEE = 0.106 // 마켓 수수료율
// 반품 1건당 손실: 왕복배송비(SHIP*2) + 재포장·검수·불량 폐기 손실(고정 추정)
const REPACK_LOSS = 1500

// category_top 별 한국 이커머스 반품률 사전치 (0~1).
//   의류/신발 0.20~0.30, 식품/건강 0.03~0.05, 디지털 0.08 등.
const CATEGORY_RETURN_PRIOR = {
  fashion: 0.25,
  clothes: 0.25,
  의류: 0.25,
  apparel: 0.25,
  shoes: 0.28,
  신발: 0.28,
  bag: 0.18,
  잡화: 0.18,
  accessory: 0.18,
  beauty: 0.12,
  뷰티: 0.12,
  living: 0.08,
  생활: 0.08,
  home: 0.08,
  digital: 0.08,
  디지털: 0.08,
  electronics: 0.08,
  가전: 0.08,
  health: 0.04,
  건강: 0.04,
  supplements: 0.04,
  food: 0.03,
  식품: 0.03,
}
const DEFAULT_PRIOR = 0.1

// 변형(사이즈/색상)이 많아 오배송·교환이 잦은 카테고리.
const SIZE_VARIANT_CATEGORIES = new Set([
  'fashion', 'clothes', '의류', 'apparel', 'shoes', '신발', 'bag', '잡화', 'accessory',
])

// raw/market 본문에서 찾을 반품 토큰.
const RETURN_TOKENS = ['사이즈 안맞', '사이즈안맞', '사이즈가 안', '불량', '반품', '교환', '환불', 'AS', 'A/S', '하자', '오배송']

function priorFor(categoryTop) {
  if (!categoryTop) return DEFAULT_PRIOR
  const key = String(categoryTop).toLowerCase()
  if (CATEGORY_RETURN_PRIOR[key] != null) return CATEGORY_RETURN_PRIOR[key]
  if (CATEGORY_RETURN_PRIOR[categoryTop] != null) return CATEGORY_RETURN_PRIOR[categoryTop]
  return DEFAULT_PRIOR
}

function clamp01(n) {
  return Math.max(0, Math.min(1, n))
}

async function main() {
  // 1) 최신 score 가 있는 product 만 대상으로 (UI 와 동일 집합).
  const { data: products, error: pErr } = await sb
    .from('jimscanner_trends_products')
    .select('id, canonical_name, category_top')
    .limit(5000)
  if (pErr) throw pErr
  if (!products?.length) {
    console.log('대상 product 없음 — 종료')
    return
  }
  console.log(`대상 product ${products.length}개`)

  // 2) alias (alias → product_id) 적재.
  const { data: aliases } = await sb
    .from('jimscanner_trends_aliases')
    .select('product_id, alias')
    .limit(20000)
  const aliasByProduct = new Map()
  for (const a of aliases ?? []) {
    if (!a.alias) continue
    const arr = aliasByProduct.get(a.product_id) ?? []
    arr.push(String(a.alias))
    aliasByProduct.set(a.product_id, arr)
  }

  // 3) market_raw 본문 적재 (반품 토큰 동반출현 탐지용).
  const { data: rawRows } = await sb
    .from('jimscanner_market_raw')
    .select('title, query, metadata')
    .order('captured_at', { ascending: false })
    .limit(8000)
  const corpus = (rawRows ?? []).map((r) => {
    const desc = r?.metadata && typeof r.metadata === 'object' ? (r.metadata.description ?? '') : ''
    return `${r?.title ?? ''} ${r?.query ?? ''} ${desc}`
  })

  // 4) 도매 최저가 (effective margin 계산용).
  const { data: suppliers } = await sb
    .from('jimscanner_trends_supplier')
    .select('product_id, price_krw')
    .limit(20000)
  const minPriceByProduct = new Map()
  for (const s of suppliers ?? []) {
    const price = Number(s.price_krw)
    if (!Number.isFinite(price) || price <= 0) continue
    const cur = minPriceByProduct.get(s.product_id)
    if (cur == null || price < cur) minPriceByProduct.set(s.product_id, price)
  }

  const nowRows = []
  for (const p of products) {
    const prior = priorFor(p.category_top)
    const aliasList = aliasByProduct.get(p.id) ?? [p.canonical_name].filter(Boolean)

    // buzz: alias 와 반품 토큰이 같은 본문에 동반 출현한 횟수.
    let cooccur = 0
    let scannedHits = 0
    if (aliasList.length) {
      const aliasNeedles = aliasList
        .map((a) => String(a).trim())
        .filter((a) => a.length >= 2)
        .map((a) => a.toLowerCase())
      for (const doc of corpus) {
        const lower = doc.toLowerCase()
        const hasAlias = aliasNeedles.some((n) => lower.includes(n))
        if (!hasAlias) continue
        scannedHits++
        const hasToken = RETURN_TOKENS.some((t) => doc.includes(t))
        if (hasToken) cooccur++
      }
    }
    // 동반출현 비율 → 0~1 buzz (포화 곡선; 5건이면 ~0.6).
    const buzz = scannedHits > 0 ? clamp01(cooccur / Math.max(scannedHits, 1)) : 0
    const buzzSignal = clamp01(buzz * 0.5 + Math.min(cooccur, 6) / 6 * 0.5)

    const sizePenalty = SIZE_VARIANT_CATEGORIES.has(String(p.category_top ?? '').toLowerCase())
      ? 0.08
      : 0

    const estReturnRate = clamp01(prior + buzzSignal * 0.15 + sizePenalty)

    // effective margin: 도매가 알면 손실 차감, 없으면 비율만 할인.
    const supplierPrice = minPriceByProduct.get(p.id)
    const lossPerReturn = SHIP * 2 + REPACK_LOSS // 왕복 배송 + 재포장
    let surfaceMargin = null
    let effectiveMargin = null
    if (supplierPrice && supplierPrice > 0) {
      // 단순 판매가 가정: 도매가의 1.8배(위탁 보편 마크업) — 실제 등록가 미연동분 fallback.
      const sellPrice = supplierPrice * 1.8
      const grossPerSale = sellPrice * (1 - FEE) - supplierPrice - SHIP
      surfaceMargin = grossPerSale / sellPrice
      // 반품률만큼 판매 1건당 손실을 기대값으로 차감.
      const effPerSale = grossPerSale - estReturnRate * lossPerReturn
      effectiveMargin = effPerSale / sellPrice
    } else {
      // 도매가 미연동: 반품률 비율로만 마진을 할인(상대 다운랭크용).
      surfaceMargin = null
      effectiveMargin = -estReturnRate // 음수일수록 위험 — 정렬용 프록시
    }

    nowRows.push({
      product_id: p.id,
      category_return_prior: prior,
      buzz_return_signal: Number(buzzSignal.toFixed(4)),
      size_variant_penalty: sizePenalty,
      estimated_return_rate: Number(estReturnRate.toFixed(4)),
      loss_per_return_krw: lossPerReturn,
      surface_margin_ratio: surfaceMargin == null ? null : Number(surfaceMargin.toFixed(4)),
      effective_margin_ratio: effectiveMargin == null ? null : Number(effectiveMargin.toFixed(4)),
      components: {
        alias_count: aliasList.length,
        buzz_cooccur: cooccur,
        buzz_scanned_hits: scannedHits,
        supplier_min_price: supplierPrice ?? null,
        ship: SHIP,
        fee: FEE,
      },
    })
  }

  // 5) 적재 (chunk insert — 매 실행 새 row, UI 는 latest 조회).
  const CHUNK = 500
  let inserted = 0
  for (let i = 0; i < nowRows.length; i += CHUNK) {
    const slice = nowRows.slice(i, i + CHUNK)
    const { error } = await sb.from('jimscanner_trends_return_risk').insert(slice)
    if (error) {
      console.error('insert 실패:', error.message)
      process.exit(1)
    }
    inserted += slice.length
  }
  console.log(`반품 리스크 적재 완료: ${inserted}개`)

  const collapsing = nowRows.filter(
    (r) => r.surface_margin_ratio != null && r.effective_margin_ratio != null && r.effective_margin_ratio < 0,
  )
  console.log(`반품 보정 후 마진 음수(적색 다운랭크 후보): ${collapsing.length}개`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
