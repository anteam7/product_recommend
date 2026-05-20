#!/usr/bin/env node
/**
 * scripts/ggsan-multi-seller-fetch.mjs
 *
 * 같은 canonical product 에 매핑된 ggsan / 도매꾹 / 1688 의 *여러 셀러* 견적을
 * jimscanner_trends_supplier_quotes 에 일별 적재한다.
 *
 * 현재 1차 구현:
 *  - jimscanner_trends_aliases 에서 alias_type='product_title', source='ggsan' 인 alias 들을
 *    canonical product 단위로 묶고
 *  - jimscanner_ggsan_products 에서 같은 title 키워드로 LIKE 매칭되는 셀러(=상품) 들의
 *    현재 price_krw 를 'supplier' 로 기록한다. (ggsan 은 1상품 = 1셀러 구조이지만
 *    동일 SKU 가 여러 goodsNo 로 등록된 경우가 잦으므로 같은 canonical alias 매칭 ⇒
 *    multi-seller 후보로 본다.)
 *  - 도매꾹/1688 fetch 는 별도 후속 PR (현재 단계는 ggsan 만 적재).
 *
 * 적재 단위: (product_id, source, supplier_id_or_seller_name) 1행 / 1일.
 * 같은 product/source/seller 가 같은 날 또 들어오면 새 row 가 쌓이고, 일별 view 는
 * DISTINCT ON 으로 최신 1행만 본다.
 *
 * 환경변수: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *
 * 실행:
 *   node --env-file=.env.local scripts/ggsan-multi-seller-fetch.mjs
 */

import { createClient } from '@supabase/supabase-js'

const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!url || !key) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
  process.exit(1)
}

const sb = createClient(url, key, { auth: { persistSession: false } })

const MIN_TITLE_LEN = 4
const MAX_SELLERS_PER_PRODUCT = 25

function shortToken(title) {
  // 첫 2~3개 단어를 LIKE 키워드로
  const words = title.replace(/[\[\](){}/.,]/g, ' ').split(/\s+/).filter(Boolean)
  const head = words.slice(0, 2).join(' ').trim()
  return head.length >= MIN_TITLE_LEN ? head : title.slice(0, 12)
}

async function loadCanonicalProducts() {
  const { data, error } = await sb
    .from('jimscanner_trends_products')
    .select('id, canonical_name, brand')
    .order('last_seen_at', { ascending: false })
    .limit(2000)
  if (error) throw error
  return data ?? []
}

async function findGgsanSellersForProduct(p) {
  const token = shortToken(p.canonical_name)
  let q = sb
    .from('jimscanner_ggsan_products')
    .select('goods_no, title, price_krw, detail_url, brand')
    .ilike('title', `%${token}%`)
    .not('price_krw', 'is', null)
    .order('price_krw', { ascending: true })
    .limit(MAX_SELLERS_PER_PRODUCT)
  if (p.brand) {
    // 브랜드가 있으면 같은 브랜드 OR 같은 토큰 (느슨한 매칭)
    // (현재 1차에선 토큰 매칭만 — 브랜드 정규화 misalign 방지)
  }
  const { data, error } = await q
  if (error) {
    console.warn(`[skip] ${p.canonical_name}: ${error.message}`)
    return []
  }
  return data ?? []
}

async function insertQuotes(rows) {
  if (rows.length === 0) return 0
  const { error } = await sb.from('jimscanner_trends_supplier_quotes').insert(rows)
  if (error) {
    console.error('insert failed', error)
    throw error
  }
  return rows.length
}

async function main() {
  const t0 = Date.now()
  const products = await loadCanonicalProducts()
  console.log(`loaded ${products.length} canonical products`)

  let totalSellers = 0
  let totalInserts = 0
  const batch = []

  for (const p of products) {
    const sellers = await findGgsanSellersForProduct(p)
    if (sellers.length < 2) continue // multi-seller 가 아닌 단일 ⇒ 분산 의미 없음

    totalSellers += sellers.length
    for (const s of sellers) {
      batch.push({
        product_id: p.id,
        source: 'ggsan',
        supplier_id_or_seller_name: s.goods_no,
        external_url: s.detail_url,
        unit_price_krw: s.price_krw,
        currency: 'KRW',
        raw_price: s.price_krw,
        moq: 1,
        raw_payload: { title: s.title, brand: s.brand },
      })
      if (batch.length >= 500) {
        totalInserts += await insertQuotes(batch.splice(0, batch.length))
      }
    }
  }
  totalInserts += await insertQuotes(batch)

  console.log(
    `[done ${((Date.now() - t0) / 1000).toFixed(1)}s] sellers_seen=${totalSellers} inserted=${totalInserts}`,
  )
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
