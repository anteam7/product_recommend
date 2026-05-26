#!/usr/bin/env node
// ────────────────────────────────────────────────────────────
// PB 침투율 스캐너 (Private Brand penetration scan)
// ────────────────────────────────────────────────────────────
// 쿠팡/네이버 SERP 결과에서 PB(자체브랜드) 슬롯 비율을 측정해
// jimscanner_pb_penetration 에 적재.
//
// PB 식별: 셀러명/배지/브랜드명 정규식 + 화이트리스트 (PB_BRANDS).
//
// 사용:
//   node scripts/pb-penetration-scan.mjs --keyword "수면 영양제" --platform coupang
//   node scripts/pb-penetration-scan.mjs --batch        # KEYWORDS 전체 스캔
//   node scripts/pb-penetration-scan.mjs --dry-run      # DB write 없이 출력만
// ────────────────────────────────────────────────────────────
import { createClient } from '@supabase/supabase-js'
import { readFileSync, existsSync } from 'node:fs'

// ── env 로드 (.env.local) ────────────────────────────────────
function loadEnv() {
  const out = {}
  if (!existsSync('.env.local')) return out
  for (const line of readFileSync('.env.local', 'utf-8').split('\n')) {
    const m = line.match(/^([A-Z_]+)\s*=\s*"?([^"]+)"?$/)
    if (m) out[m[1]] = m[2]
  }
  return out
}
const env = loadEnv()

// ── PB 브랜드 화이트리스트 (플랫폼별) ─────────────────────────
// 셀러명·브랜드명·배지에서 이 키워드가 보이면 PB 슬롯으로 카운트.
export const PB_BRANDS = {
  coupang: [
    '곰곰', '탐사', 'Coupang Only', '쿠팡 Only', '쿠팡온리',
    '코멧', 'Comet',
    '캐럿', 'Carrot',
    '로켓프레시 PB',
  ],
  naver: [
    '브랜드스토어 PB', 'NAVER PB',
  ],
  emart: ['노브랜드', 'No Brand', '피코크', 'PEACOCK'],
  homeplus: ['시그니처', 'Simply'],
}

// ── PB 식별 룰: 셀러/브랜드/제목에서 화이트리스트 매칭 ────────
const PB_BADGE_REGEX = /(Coupang Only|쿠팡\s*Only|로켓프레시\s*PB|NAVER\s*PB|브랜드스토어\s*PB)/i

export function identifyPb(item, platform) {
  const brands = PB_BRANDS[platform] ?? []
  const haystack = [
    item.seller ?? '',
    item.brand ?? '',
    item.title ?? '',
    item.badge ?? '',
  ].join(' ')

  if (PB_BADGE_REGEX.test(haystack)) {
    return { isPb: true, matchedBrand: 'Coupang Only/PB-badge' }
  }
  for (const b of brands) {
    const re = new RegExp(`(^|[\\s\\[\\]\\(\\)])${escapeRe(b)}([\\s\\[\\]\\(\\)]|$)`, 'i')
    if (re.test(haystack)) return { isPb: true, matchedBrand: b }
  }
  return { isPb: false, matchedBrand: null }
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// ── 가격대 버킷 ─────────────────────────────────────────────
function priceBucket(priceKrw) {
  if (priceKrw == null) return 'all'
  if (priceKrw < 10000) return 'low'
  if (priceKrw < 50000) return 'mid'
  return 'high'
}

// ── SERP 수집 (간단 mock + 쿠팡 search API 1차 지원) ─────────
// 실제 쿠팡 SERP 스크래핑은 scripts/coupang-debug-search.mjs 에 이미
// 패턴이 있음. 본 스캐너는 호출 측이 items 배열을 넘기거나,
// --keyword 만 받으면 mock 으로 동작 (PB 식별 로직 자체는 동일).
async function fetchSerpCoupang(keyword, limit = 50) {
  // TODO: 실제 SERP 호출은 후속 PR. 현재는 mock — DB 스키마와
  // 식별 로직만 먼저 입수. items 형태: { title, brand, seller, badge, price_krw }
  return []
}

async function fetchSerpNaver(keyword, limit = 50) {
  return []
}

// ── 핵심: items[] → 한 row 누적 ─────────────────────────────
export function aggregatePbStats(items, platform) {
  const brandCount = {}
  let pbSlots = 0
  for (const it of items) {
    const { isPb, matchedBrand } = identifyPb(it, platform)
    if (isPb) {
      pbSlots += 1
      const key = matchedBrand ?? '(unknown PB)'
      brandCount[key] = (brandCount[key] ?? 0) + 1
    }
  }
  const sortedBrands = Object.entries(brandCount).sort((a, b) => b[1] - a[1])
  const topBrand = sortedBrands[0]?.[0] ?? null
  const share = items.length === 0 ? 0 : pbSlots / items.length
  return {
    serp_total: items.length,
    pb_slot_count: pbSlots,
    pb_share: Number(share.toFixed(4)),
    pb_top_brand: topBrand,
    pb_brands: brandCount,
  }
}

// ── 키워드 시드 (배치 모드) ─────────────────────────────────
const KEYWORDS = [
  { keyword: '수면 영양제', category: 'health' },
  { keyword: '멜라토닌', category: 'health' },
  { keyword: '프로바이오틱스', category: 'health' },
  { keyword: '비타민d', category: 'health' },
  { keyword: '주방세제', category: 'living' },
  { keyword: '세탁세제', category: 'living' },
  { keyword: '물티슈', category: 'living' },
  { keyword: '생수 2l', category: 'living' },
  { keyword: '커피믹스', category: 'living' },
  { keyword: '유튜브 마이크', category: 'digital' },
  { keyword: '무선 이어폰', category: 'digital' },
]

// ── 메인 ────────────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2)
  const get = (flag) => {
    const i = args.indexOf(flag)
    return i >= 0 ? args[i + 1] : null
  }
  const dryRun = args.includes('--dry-run')
  const batch = args.includes('--batch')
  const platform = get('--platform') ?? 'coupang'

  let runs
  if (batch) {
    runs = KEYWORDS.map((k) => ({ ...k, platform }))
  } else {
    const keyword = get('--keyword')
    if (!keyword) {
      console.error('usage: --keyword "<kw>" [--platform coupang|naver|emart|homeplus] [--dry-run] | --batch')
      process.exit(1)
    }
    const category = get('--category')
    runs = [{ keyword, category, platform }]
  }

  let sb = null
  if (!dryRun) {
    if (!env.NEXT_PUBLIC_SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
      console.error('ERR: .env.local 에 NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 필요')
      process.exit(1)
    }
    sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY)
  }

  for (const r of runs) {
    const items =
      r.platform === 'coupang'
        ? await fetchSerpCoupang(r.keyword)
        : r.platform === 'naver'
        ? await fetchSerpNaver(r.keyword)
        : []

    const stats = aggregatePbStats(items, r.platform)
    const bucket = priceBucket(items[0]?.price_krw)

    const row = {
      keyword: r.keyword,
      category: r.category ?? null,
      platform: r.platform,
      price_bucket: bucket,
      ...stats,
    }

    console.log(
      `[${r.platform}] "${r.keyword}" — PB ${stats.pb_slot_count}/${stats.serp_total} ` +
        `(${(stats.pb_share * 100).toFixed(1)}%) top=${stats.pb_top_brand ?? '-'}`
    )

    if (sb && stats.serp_total > 0) {
      const { error } = await sb.from('jimscanner_pb_penetration').insert(row)
      if (error) console.error('  insert error:', error.message)
    } else if (dryRun) {
      console.log('  (dry-run) row =', JSON.stringify(row))
    } else if (stats.serp_total === 0) {
      console.log('  (skip insert — serp_total=0; SERP collector 구현 후 적재)')
    }
  }
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}`) {
  main().catch((e) => {
    console.error(e)
    process.exit(1)
  })
}
