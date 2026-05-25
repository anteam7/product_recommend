#!/usr/bin/env node
/**
 * 트렌드 레이더 v4 — 한국 인허가 강제 분류기 (rule-based, 로컬 전용).
 *
 * 위탁 셀러가 도매 입수 직전 마지막으로 체크해야 하는 인허가 게이트.
 * canonical_name + alias 텍스트를 키워드 룰북으로 스캔해서
 * jimscanner_trends_certifications 에 인증 row 를 upsert.
 *
 * 호출:
 *   node --env-file=.env.local scripts/classify-trends-certs.mjs
 *
 * 정책: rule_engine 우선 — 명확한 키워드 매칭만 자동 적재. LLM 보조는 후속.
 * 이미 위탁등록한 상품도 cron 스캔으로 역추적 (모든 product 대상).
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

// 인증 메타 — est_cost_krw 와 est_lead_weeks 는 위탁셀러 기준 보수적 추정.
const CERT_META = {
  kc_safety: { cost: 800_000, lead: 3, label: 'KC 안전' },
  kc_emi: { cost: 800_000, lead: 3, label: 'KC 전자파' },
  kc_kids: { cost: 1_500_000, lead: 4, label: 'KC 어린이' },
  mfds_food: { cost: 5_000_000, lead: 4, label: '식약처 식품' },
  mfds_cosmetic: { cost: 3_000_000, lead: 6, label: '책임판매업자' },
  mfds_med: { cost: 10_000_000, lead: 12, label: '의료기기' },
  rra_radio: { cost: 800_000, lead: 4, label: '전파인증' },
  kats_efficiency: { cost: 600_000, lead: 2, label: '에너지효율' },
}

// 키워드 룰북 — 한국어 + 영문 혼용. 부분 일치 (lowercase).
// 우선순위: 위에서 아래로 — 동일 상품에 여러 인증 매칭 가능.
const RULES = [
  // ─── 식약처 식품·건강기능식품 ───
  { cert: 'mfds_food', kws: ['캡슐', '정제', '드링크', '액상', '분말', '영양제', '비타민', '오메가', '오메가3', '프로바이오틱', '유산균', '콜라겐', '멜라토닌', '루테인', '쏘팔메토', '밀크씨슬', '홍삼', '글루코사민', '코큐텐', 'coq10', '단백질 보충', '프로틴 파우더'] },

  // ─── 식약처 화장품 ───
  { cert: 'mfds_cosmetic', kws: ['화장품', '미스트', '토너', '세럼', '크림', '로션', '에센스', '마스크팩', '클렌징', '선크림', '쿠션', '파운데이션', '립스틱', '립밤', '아이섀도', '바디로션', '바디오일', '향수', '퍼퓸', '샴푸', '컨디셔너', '트리트먼트'] },

  // ─── 식약처 의료기기 ───
  { cert: 'mfds_med', kws: ['의료기기', '진단', '혈압계', '혈당계', '체온계', '저주파 치료', '온열 치료', '마스크 의료용', '카이로프랙틱', '카이로 매트', '안마 의료'] },

  // ─── KC 어린이용품 ───
  { cert: 'kc_kids', kws: ['어린이', '유아', '아동', '키즈', '완구', '장난감', '학용품', '아기 장난감', '아기용', '유아용', '베이비', 'baby', 'kids', '인형'] },

  // ─── 전파인증 (RRA) ───
  { cert: 'rra_radio', kws: ['블루투스', 'bluetooth', '무선', 'wireless', '와이파이', 'wifi', 'wi-fi', '리모컨', '리모트', '무선 이어폰', '무선 충전', '무선청소기', '무선 청소기', 'rf '] },

  // ─── KC 안전인증 (전기) ───
  { cert: 'kc_safety', kws: ['220v', '110v', '콘센트', '멀티탭', '어댑터', '충전기', '전원', '전기', '히터', '온풍기', '전기장판', '전기담요', '인덕션', '가전', '전동', '전원공급', '플러그'] },

  // ─── KC 전자파 (EMI) — 전자제품 일반 ───
  { cert: 'kc_emi', kws: ['모니터', 'tv 수신', '셋톱', '컴퓨터', '노트북', '태블릿', '스피커', '앰프', '믹서기', '전자레인지', '공기청정기'] },

  // ─── 에너지효율 (KATS) ───
  { cert: 'kats_efficiency', kws: ['냉장고', '에어컨', '세탁기', '제습기', '가습기', '식기세척기', '김치냉장고', '의류건조기', '전기레인지'] },
]

const STAMP_ENGINE = 'rule_engine'

function normalize(s) {
  return (s ?? '').toLowerCase().replace(/\s+/g, ' ').trim()
}

function classifyText(text) {
  const t = normalize(text)
  if (!t) return []
  const hits = []
  const seen = new Set()
  for (const rule of RULES) {
    for (const kw of rule.kws) {
      if (t.includes(kw.toLowerCase())) {
        if (seen.has(rule.cert)) break
        seen.add(rule.cert)
        hits.push({ cert: rule.cert, keyword: kw })
        break
      }
    }
  }
  return hits
}

async function fetchProducts() {
  const { data } = await sb
    .from('jimscanner_trends_products')
    .select('id, canonical_name, category_top, category_mid, description')
    .order('updated_at', { ascending: false })
    .limit(5000)
  return data ?? []
}

async function fetchAliasesByProduct(productIds) {
  if (productIds.length === 0) return new Map()
  const map = new Map()
  const chunk = 200
  for (let i = 0; i < productIds.length; i += chunk) {
    const slice = productIds.slice(i, i + chunk)
    const { data } = await sb
      .from('jimscanner_trends_aliases')
      .select('product_id, alias')
      .in('product_id', slice)
    for (const r of data ?? []) {
      const list = map.get(r.product_id) ?? []
      list.push(r.alias)
      map.set(r.product_id, list)
    }
  }
  return map
}

async function upsertCerts(rows) {
  if (rows.length === 0) return 0
  const chunk = 200
  let n = 0
  for (let i = 0; i < rows.length; i += chunk) {
    const slice = rows.slice(i, i + chunk)
    const { error } = await sb
      .from('jimscanner_trends_certifications')
      .upsert(slice, { onConflict: 'product_id,cert_type' })
    if (error) {
      console.error(`  upsert chunk failed: ${error.message}`)
      continue
    }
    n += slice.length
  }
  return n
}

async function main() {
  const t0 = Date.now()
  console.log(`[${new Date().toISOString()}] classify-trends-certs (rule-based) start`)

  const products = await fetchProducts()
  console.log(`  products: ${products.length}`)
  if (products.length === 0) return

  const aliasMap = await fetchAliasesByProduct(products.map((p) => p.id))

  const upsertRows = []
  let productsWithCert = 0
  const certCounts = {}

  for (const p of products) {
    const haystack = [p.canonical_name, p.category_mid, p.description, ...(aliasMap.get(p.id) ?? [])]
      .filter(Boolean)
      .join(' | ')
    const hits = classifyText(haystack)
    if (hits.length === 0) continue
    productsWithCert++
    for (const h of hits) {
      const meta = CERT_META[h.cert]
      certCounts[h.cert] = (certCounts[h.cert] ?? 0) + 1
      upsertRows.push({
        product_id: p.id,
        cert_type: h.cert,
        mandatory: true,
        est_cost_krw: meta.cost,
        est_lead_weeks: meta.lead,
        rule_source: STAMP_ENGINE,
        rule_keyword: h.keyword,
        confidence: 0.8,
      })
    }
  }

  console.log(`  classified: ${productsWithCert} products with ${upsertRows.length} cert rows`)
  for (const [k, v] of Object.entries(certCounts)) {
    console.log(`    ${k}: ${v}`)
  }

  const n = await upsertCerts(upsertRows)
  console.log(
    `[${new Date().toISOString()}] done — upserted ${n} rows, ${Date.now() - t0}ms`,
  )
}

main().catch((e) => {
  console.error(`[fatal] ${e instanceof Error ? e.message : e}`)
  process.exit(1)
})
