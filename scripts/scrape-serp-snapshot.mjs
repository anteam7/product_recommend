#!/usr/bin/env node
/**
 * 카테고리별 네이버쇼핑 SERP 상위 50 주간 스냅샷 수집.
 *
 * jimscanner_serp_snapshots(category, week, rank, product_id, seller, reviews, captured_at)
 * 에 적재. 매주 KST 18:00 (recompute_scores 직후) 1회 실행.
 *
 * 사용법:
 *   node --env-file=.env.local scripts/scrape-serp-snapshot.mjs
 *   node --env-file=.env.local scripts/scrape-serp-snapshot.mjs --category=health
 *
 * 요구 환경변수:
 *   - NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY
 *   - NAVER_OPENAPI_CLIENT_ID / NAVER_OPENAPI_CLIENT_SECRET
 *     (Naver Open API > 검색 > 쇼핑)
 */

import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const NAVER_ID = process.env.NAVER_OPENAPI_CLIENT_ID
const NAVER_SECRET = process.env.NAVER_OPENAPI_CLIENT_SECRET

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
  process.exit(1)
}
if (!NAVER_ID || !NAVER_SECRET) {
  console.error('Missing NAVER_OPENAPI_CLIENT_ID or NAVER_OPENAPI_CLIENT_SECRET')
  process.exit(1)
}

const sb = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false },
})

// 카테고리 → SERP 시드 쿼리. 추후 trends_seeds 에서 동적으로 가져오도록 확장 가능.
const CATEGORY_QUERIES = {
  health: ['오메가3', '유산균', '비타민', '루테인', '콜라겐'],
  living: ['주방세제', '세탁세제', '청소포', '수세미', '욕실청소'],
  digital: ['보조배터리', '블루투스이어폰', '무선마우스', '키보드', '충전기'],
}

// 이번 주 월요일 (KST 기준).
function currentWeekMonday() {
  const now = new Date()
  // KST 보정 (UTC+9)
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000)
  const dow = kst.getUTCDay() // 0=Sun
  const offset = dow === 0 ? -6 : 1 - dow
  const monday = new Date(kst)
  monday.setUTCDate(kst.getUTCDate() + offset)
  return monday.toISOString().slice(0, 10)
}

async function fetchNaverShoppingTop50(query) {
  // Naver Shopping Search API. 한 번에 최대 100. sort=sim (정확도) 사용.
  const url = `https://openapi.naver.com/v1/search/shop.json?query=${encodeURIComponent(query)}&display=50&sort=sim`
  const res = await fetch(url, {
    headers: {
      'X-Naver-Client-Id': NAVER_ID,
      'X-Naver-Client-Secret': NAVER_SECRET,
    },
  })
  if (!res.ok) {
    const t = await res.text().catch(() => '')
    throw new Error(`naver shopping ${res.status}: ${t.slice(0, 200)}`)
  }
  const j = await res.json()
  return j.items ?? []
}

async function snapshotCategory(category, queries, week) {
  const merged = new Map() // productId → row
  let rank = 0
  for (const q of queries) {
    let items = []
    try {
      items = await fetchNaverShoppingTop50(q)
    } catch (e) {
      console.warn(`  ${category}/${q} fail: ${e.message}`)
      continue
    }
    for (const it of items) {
      const pid = String(it.productId ?? it.productCode ?? '')
      if (!pid) continue
      if (merged.has(pid)) continue
      rank++
      merged.set(pid, {
        category,
        week,
        rank,
        product_id: pid,
        seller: it.mallName ?? null,
        reviews: null, // Naver Open API 는 리뷰 수 미제공 — 추후 별도 source
      })
      if (rank >= 50) break
    }
    if (rank >= 50) break
    // rate-limit 살짝
    await new Promise((r) => setTimeout(r, 250))
  }
  const rows = [...merged.values()]
  if (rows.length === 0) return { inserted: 0 }
  const { error } = await sb
    .from('jimscanner_serp_snapshots')
    .upsert(rows, { onConflict: 'category,week,rank' })
  if (error) throw new Error(`upsert ${category}: ${error.message}`)
  return { inserted: rows.length }
}

const args = process.argv.slice(2)
const filterCategory = args.find((a) => a.startsWith('--category='))?.slice(11)

const week = currentWeekMonday()
console.log(`[${new Date().toISOString()}] SERP snapshot week=${week}`)

let totalInserted = 0
let okCount = 0
let failCount = 0
for (const [cat, queries] of Object.entries(CATEGORY_QUERIES)) {
  if (filterCategory && cat !== filterCategory) continue
  try {
    const { inserted } = await snapshotCategory(cat, queries, week)
    console.log(`  OK  ${cat.padEnd(8)} inserted=${inserted}`)
    totalInserted += inserted
    okCount++
  } catch (e) {
    console.error(`  ERR ${cat}: ${e.message}`)
    failCount++
  }
}

console.log(`[${new Date().toISOString()}] done — ${okCount} ok, ${failCount} fail, ${totalInserted} rows`)
process.exit(failCount > 0 ? 1 : 0)
