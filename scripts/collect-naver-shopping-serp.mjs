#!/usr/bin/env node
/**
 * Naver Shopping SERP 셀러 스냅샷 — 일 1회.
 *
 * 키워드 시드: jimscanner_trends_keywords 에서 최근 14일 collected_at, source IN (
 *   'naver_search_trend','naver_shopping_insight'
 * ) 중 unique 키워드 상위 N개 + jimscanner_trends_pins 의 pinned 키워드.
 *
 * 각 키워드별로 openapi.naver.com/v1/search/shop.json (display=20, sort=sim) 조회 →
 * jimscanner_serp_seller_snapshots 에 적재.
 *
 * 사용:
 *   node --env-file=.env.local scripts/collect-naver-shopping-serp.mjs
 *   node --env-file=.env.local scripts/collect-naver-shopping-serp.mjs --limit 30
 */

import { createClient } from '@supabase/supabase-js'

const SB_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const NV_ID = process.env.NAVER_OPENAPI_CLIENT_ID
const NV_SECRET = process.env.NAVER_OPENAPI_CLIENT_SECRET

if (!SB_URL || !SB_KEY) {
  console.error('SUPABASE env missing — run with --env-file=.env.local')
  process.exit(1)
}
if (!NV_ID || !NV_SECRET) {
  console.error('NAVER_OPENAPI_CLIENT_ID/SECRET missing')
  process.exit(1)
}

const sb = createClient(SB_URL, SB_KEY)

const args = process.argv.slice(2)
const limitArg = args.indexOf('--limit')
const KEYWORD_LIMIT = limitArg >= 0 ? Number(args[limitArg + 1]) || 30 : 30

const SOURCE = 'naver_shopping_serp'

function stripTags(s) {
  if (!s) return ''
  return String(s)
    .replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim()
}

function sellerIdFor(item) {
  // mallName 있으면 그걸로, 없으면 productUrl 도메인 해시
  if (item.mallName && item.mallName.trim()) return `mall:${item.mallName.trim()}`
  try {
    const u = new URL(item.link)
    return `host:${u.hostname}`
  } catch {
    return `unknown:${item.productId ?? 'na'}`
  }
}

function mallTypeFrom(item) {
  // productType: 1/2 일반, 3 중고, 5 해외
  switch (Number(item.productType)) {
    case 1:
    case 2:
      return 'naver'
    case 3:
      return 'used'
    case 5:
      return 'overseas'
    default:
      return 'other'
  }
}

async function fetchSeedKeywords() {
  const since = new Date(Date.now() - 14 * 86400000).toISOString()
  const { data: kwRows } = await sb
    .from('jimscanner_trends_keywords')
    .select('keyword, collected_at')
    .in('source', ['naver_search_trend', 'naver_shopping_insight'])
    .gte('collected_at', since)
    .order('collected_at', { ascending: false })
    .limit(800)

  const seen = new Map()
  for (const r of kwRows ?? []) {
    if (!r.keyword) continue
    if (!seen.has(r.keyword)) seen.set(r.keyword, r.collected_at)
  }

  // pinned 키워드도 무조건 포함
  const { data: pinned } = await sb
    .from('jimscanner_trends_pins')
    .select('keyword')
  for (const p of pinned ?? []) {
    if (p.keyword && !seen.has(p.keyword)) seen.set(p.keyword, new Date().toISOString())
  }

  return [...seen.keys()].slice(0, KEYWORD_LIMIT)
}

async function searchShop(query) {
  const url = `https://openapi.naver.com/v1/search/shop.json?query=${encodeURIComponent(query)}&display=20&sort=sim`
  const res = await fetch(url, {
    headers: {
      'X-Naver-Client-Id': NV_ID,
      'X-Naver-Client-Secret': NV_SECRET,
    },
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Naver shop ${res.status}: ${body.slice(0, 160)}`)
  }
  const json = await res.json()
  return json.items ?? []
}

async function logRun(status, fetched, inserted, error) {
  await sb.from('jimscanner_trends_runs').insert({
    source: SOURCE,
    status,
    fetched_count: fetched,
    inserted_count: inserted,
    error_message: error ?? null,
    triggered_by: 'cli',
    finished_at: new Date().toISOString(),
  })
}

async function main() {
  const startedAt = Date.now()
  const keywords = await fetchSeedKeywords()
  console.log(`[serp] ${keywords.length} keywords to snapshot`)

  let fetched = 0
  let inserted = 0
  let lastErr = null

  for (const kw of keywords) {
    try {
      const items = await searchShop(kw)
      fetched += items.length

      const rows = items.map((item, idx) => ({
        keyword: kw,
        seller_id: sellerIdFor(item),
        seller_name: item.mallName || stripTags(item.title).slice(0, 80) || 'unknown',
        rank: idx + 1,
        mall_type: mallTypeFrom(item),
        product_id: item.productId ? String(item.productId) : null,
        product_title: stripTags(item.title).slice(0, 200),
        price: item.lprice ? Number(item.lprice) : null,
      }))

      if (rows.length > 0) {
        const { error } = await sb.from('jimscanner_serp_seller_snapshots').insert(rows)
        if (error) {
          lastErr = error.message
          console.warn(`  ✗ ${kw}: ${error.message}`)
        } else {
          inserted += rows.length
          console.log(`  ✓ ${kw}: ${rows.length} rows`)
        }
      }

      // naver API rate limit 보호: 200ms 간격
      await new Promise((r) => setTimeout(r, 200))
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e)
      console.warn(`  ✗ ${kw}: ${lastErr}`)
    }
  }

  const status = lastErr ? (inserted > 0 ? 'partial' : 'error') : 'ok'
  await logRun(status, fetched, inserted, lastErr)
  console.log(`[serp] done in ${Date.now() - startedAt}ms — fetched=${fetched} inserted=${inserted} status=${status}`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
