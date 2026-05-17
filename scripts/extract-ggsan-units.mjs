#!/usr/bin/env node
/**
 * ggsan 상품 제목에서 용량(mg/g/ml/iu)·수량(정/캡슐/포/개)을 추출해
 * jimscanner_ggsan_products 의 volume_value/volume_unit/pack_count/unit_price 컬럼을
 * 채워넣는 배치. 정규식 → LLM fallback (옵션) 순.
 *
 * 호출:
 *   node --env-file=.env.local scripts/extract-ggsan-units.mjs [--all] [--limit=500]
 *
 *   --all   : 이미 추출된 row 도 재계산 (default: unit_extracted_at IS NULL 만)
 *   --limit : 한 번에 처리할 row 수 (default 1000)
 *
 * 정규식만으로 80~90% 커버 목표. LLM fallback 은 향후 추가 (--llm 플래그).
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

const args = process.argv.slice(2)
const ALL = args.includes('--all')
const LIMIT = (() => {
  const m = args.find((a) => a.startsWith('--limit='))
  return m ? parseInt(m.split('=')[1], 10) || 1000 : 1000
})()

// ───────────────────────── parser ─────────────────────────

const VOLUME_UNITS = {
  mg: { unit: 'mg', toMg: 1 },
  밀리그램: { unit: 'mg', toMg: 1 },
  g: { unit: 'g', toMg: 1000 },
  그램: { unit: 'g', toMg: 1000 },
  kg: { unit: 'g', toMg: 1_000_000 },
  ml: { unit: 'ml', toMg: null },
  밀리리터: { unit: 'ml', toMg: null },
  l: { unit: 'ml', toMg: null }, // l → ml*1000 처리 아래
  iu: { unit: 'iu', toMg: null },
  μg: { unit: 'mg', toMg: 0.001 },
  ug: { unit: 'mg', toMg: 0.001 },
  mcg: { unit: 'mg', toMg: 0.001 },
}

const PACK_UNITS = {
  정: '정',
  캡슐: '캡슐',
  포: '포',
  개: '개',
  알: '정',
  스틱: '포',
  봉: '포',
  팩: '팩',
  병: '병',
  매: '매',
  ea: '개',
  세트: '세트',
}

// 예: "1000mg", "1,000 mg", "500MG", "60ml", "60ML"
// 후보 모두 뽑은 뒤 마지막(가장 우측의 용량) 선택
const VOLUME_RE = /(\d{1,5}(?:[,\.]\d{1,3})?)\s?(mg|g|kg|ml|l|iu|μg|ug|mcg|밀리그램|그램|밀리리터)\b/gi

// 예: "60정", "30캡슐", "x60", "× 60", "60ea", "60개입", "60정입"
const PACK_RE = /(?:[xX×*]\s?(\d{1,4})|(\d{1,4})\s?(정|캡슐|포|개입|개|알|스틱|봉|팩|병|매|세트|ea)\b)/gi

function parseTitle(title) {
  if (!title) return null
  const norm = title.replace(/[,]/g, '').toLowerCase()

  // 1) 용량
  let volumeValue = null
  let volumeUnit = null
  let volumeMatch
  const volMatches = []
  while ((volumeMatch = VOLUME_RE.exec(norm)) !== null) {
    const num = parseFloat(volumeMatch[1])
    const rawUnit = volumeMatch[2].toLowerCase()
    if (isNaN(num)) continue
    const meta = VOLUME_UNITS[rawUnit]
    if (!meta) continue
    let value = num
    let unit = meta.unit
    if (rawUnit === 'l') {
      value = num * 1000
      unit = 'ml'
    } else if (rawUnit === 'kg') {
      value = num * 1000
      unit = 'g'
    }
    volMatches.push({ value, unit })
  }
  if (volMatches.length) {
    // 가장 큰 값을 선택 (보통 본 용량이 더 크고, 부가성분 수치가 작음)
    const main = volMatches.reduce((a, b) => (a.value >= b.value ? a : b))
    volumeValue = main.value
    volumeUnit = main.unit
  }

  // 2) 수량
  let packCount = null
  let packUnit = null
  const packMatches = []
  let packMatch
  while ((packMatch = PACK_RE.exec(norm)) !== null) {
    const xCount = packMatch[1]
    const num = packMatch[2]
    const unitText = packMatch[3]
    if (xCount) {
      const n = parseInt(xCount, 10)
      if (!isNaN(n) && n >= 2 && n <= 9999) packMatches.push({ count: n, unit: '개' })
    } else if (num && unitText) {
      const n = parseInt(num, 10)
      const u = PACK_UNITS[unitText] || PACK_UNITS[unitText.replace('개입', '개')] || unitText
      if (!isNaN(n) && n >= 1 && n <= 9999) packMatches.push({ count: n, unit: u })
    }
  }
  if (packMatches.length) {
    // 가장 큰 정/캡슐/포 우선
    const preferred = packMatches.find((m) => ['정', '캡슐', '포'].includes(m.unit))
    const main = preferred || packMatches.reduce((a, b) => (a.count >= b.count ? a : b))
    packCount = main.count
    packUnit = main.unit
  }

  return { volumeValue, volumeUnit, packCount, packUnit }
}

function computeUnitPrice({ priceKrw, volumeValue, volumeUnit, packCount }) {
  if (!priceKrw || priceKrw <= 0) return { unitPrice: null, basis: null }

  // 1순위: 원/mg (mg/g/kg → mg 환산, 총 mg = volume × pack)
  if (volumeValue && (volumeUnit === 'mg' || volumeUnit === 'g')) {
    const perItemMg = volumeUnit === 'g' ? volumeValue * 1000 : volumeValue
    const totalMg = perItemMg * (packCount || 1)
    if (totalMg > 0) {
      return { unitPrice: priceKrw / totalMg, basis: 'per_mg' }
    }
  }
  // 2순위: 원/ml
  if (volumeValue && volumeUnit === 'ml') {
    const totalMl = volumeValue * (packCount || 1)
    if (totalMl > 0) return { unitPrice: priceKrw / totalMl, basis: 'per_ml' }
  }
  // 3순위: 원/정 (용량 없어도 수량만 있으면)
  if (packCount && packCount > 0) {
    return { unitPrice: priceKrw / packCount, basis: 'per_pack' }
  }
  return { unitPrice: null, basis: null }
}

// ───────────────────────── runner ─────────────────────────

async function fetchTargets() {
  let q = sb
    .from('jimscanner_ggsan_products')
    .select('goods_no, title, price_krw')
    .neq('status', 'removed')
    .not('price_krw', 'is', null)
    .order('last_seen_at', { ascending: false })
    .limit(LIMIT)
  if (!ALL) q = q.is('unit_extracted_at', null)
  const { data, error } = await q
  if (error) throw error
  return data || []
}

async function run() {
  console.log(`[extract-ggsan-units] mode=${ALL ? 'ALL' : 'incremental'} limit=${LIMIT}`)
  const rows = await fetchTargets()
  console.log(`[extract-ggsan-units] target rows: ${rows.length}`)

  let parsed = 0
  let priced = 0
  let failed = 0
  const updates = []

  for (const row of rows) {
    const p = parseTitle(row.title || '')
    if (!p) {
      failed++
      updates.push({
        goods_no: row.goods_no,
        volume_value: null,
        volume_unit: null,
        pack_count: null,
        pack_unit: null,
        unit_price: null,
        unit_price_basis: null,
        unit_extracted_at: new Date().toISOString(),
        unit_extract_method: 'regex',
      })
      continue
    }
    const { unitPrice, basis } = computeUnitPrice({
      priceKrw: row.price_krw,
      volumeValue: p.volumeValue,
      volumeUnit: p.volumeUnit,
      packCount: p.packCount,
    })
    if (p.volumeValue || p.packCount) parsed++
    if (unitPrice != null) priced++
    if (!p.volumeValue && !p.packCount) failed++

    updates.push({
      goods_no: row.goods_no,
      volume_value: p.volumeValue,
      volume_unit: p.volumeUnit,
      pack_count: p.packCount,
      pack_unit: p.packUnit,
      unit_price: unitPrice == null ? null : Number(unitPrice.toFixed(4)),
      unit_price_basis: basis,
      unit_extracted_at: new Date().toISOString(),
      unit_extract_method: 'regex',
    })
  }

  console.log(`[extract-ggsan-units] parsed=${parsed} priced=${priced} no_match=${failed}`)

  // upsert (PRIMARY KEY = goods_no) — chunk 200
  const CHUNK = 200
  for (let i = 0; i < updates.length; i += CHUNK) {
    const chunk = updates.slice(i, i + CHUNK)
    const { error } = await sb
      .from('jimscanner_ggsan_products')
      .upsert(chunk, { onConflict: 'goods_no' })
    if (error) {
      console.error('[extract-ggsan-units] upsert error', error)
      process.exit(1)
    }
    process.stdout.write(`  upserted ${Math.min(i + CHUNK, updates.length)}/${updates.length}\r`)
  }
  console.log(`\n[extract-ggsan-units] done`)
}

run().catch((e) => {
  console.error(e)
  process.exit(1)
})
