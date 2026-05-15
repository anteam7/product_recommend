#!/usr/bin/env node
/**
 * probe-retail-prices — Naver Shopping API 로 ggsan 활성 상품 + canonical product 의
 * 리테일 시장가(최저/중앙/최고) 와 등록상품수(=경쟁 강도) 를 수집해
 * jimscanner_retail_price_probes 에 시계열로 적재한다.
 *
 * 사용법:
 *   node --env-file=.env.local scripts/probe-retail-prices.mjs            # 상위 50개
 *   node --env-file=.env.local scripts/probe-retail-prices.mjs 100        # 상위 N개
 *   node --env-file=.env.local scripts/probe-retail-prices.mjs 50 --no-canonical
 *
 * 결과는 /admin/trend-radar/margin 페이지가 view jimscanner_margin_candidates 로 소비한다.
 */

import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const NAVER_ID = process.env.NAVER_OPENAPI_CLIENT_ID
const NAVER_SECRET = process.env.NAVER_OPENAPI_CLIENT_SECRET

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing')
  process.exit(1)
}
if (!NAVER_ID || !NAVER_SECRET) {
  console.error('NAVER_OPENAPI_CLIENT_ID / NAVER_OPENAPI_CLIENT_SECRET missing')
  process.exit(1)
}

const args = process.argv.slice(2)
const N = (() => {
  const n = parseInt(args[0] ?? '50', 10)
  return Number.isFinite(n) && n > 0 ? n : 50
})()
const SKIP_CANONICAL = args.includes('--no-canonical')

const sb = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
})

function stripTags(s) {
  return (s ?? '')
    .replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim()
}

function median(nums) {
  if (!nums.length) return null
  const sorted = [...nums].sort((a, b) => a - b)
  const m = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? Math.round((sorted[m - 1] + sorted[m]) / 2) : sorted[m]
}

async function searchShopping(query) {
  const url = `https://openapi.naver.com/v1/search/shop.json?query=${encodeURIComponent(
    query,
  )}&display=40&sort=asc`
  const res = await fetch(url, {
    headers: {
      'X-Naver-Client-Id': NAVER_ID,
      'X-Naver-Client-Secret': NAVER_SECRET,
    },
  })
  if (!res.ok) throw new Error(`naver shopping ${res.status} ${res.statusText}`)
  return await res.json()
}

function buildProbe({ goods_no, product_id, query, json }) {
  const items = Array.isArray(json?.items) ? json.items : []
  const prices = items
    .map((it) => parseInt(it.lprice, 10))
    .filter((n) => Number.isFinite(n) && n > 0)
  return {
    goods_no: goods_no ?? null,
    product_id: product_id ?? null,
    query,
    source: 'naver_shopping_api',
    price_min: prices.length ? Math.min(...prices) : null,
    price_med: median(prices),
    price_max: prices.length ? Math.max(...prices) : null,
    listing_count: typeof json?.total === 'number' ? json.total : items.length,
    observed_at: new Date().toISOString(),
    raw_payload: {
      items_count: items.length,
      total: json?.total ?? null,
      sample_titles: items.slice(0, 3).map((it) => stripTags(it.title)),
      sample_malls: items.slice(0, 3).map((it) => it.mallName ?? null),
    },
  }
}

async function probeOne({ goods_no, product_id, title }) {
  const json = await searchShopping(title)
  const probe = buildProbe({ goods_no, product_id, query: title, json })
  const { error } = await sb.from('jimscanner_retail_price_probes').insert(probe)
  if (error) throw new Error(`insert: ${error.message}`)
  return probe
}

async function main() {
  console.log(`[${new Date().toISOString()}] probe-retail-prices — top ${N} ggsan + canonical`)

  // 1) ggsan 활성 상품 상위 N (최근 본 순)
  const { data: ggsan, error: ggsanErr } = await sb
    .from('jimscanner_ggsan_products')
    .select('goods_no, title, status, last_seen_at')
    .eq('status', 'active')
    .order('last_seen_at', { ascending: false })
    .limit(N)
  if (ggsanErr) {
    console.error(`ggsan fetch: ${ggsanErr.message}`)
    process.exit(1)
  }

  let okCount = 0
  let failCount = 0

  for (const p of ggsan ?? []) {
    try {
      const probe = await probeOne({ goods_no: p.goods_no, product_id: null, title: p.title })
      okCount++
      console.log(
        `  OK ggsan/${p.goods_no} min=${probe.price_min} med=${probe.price_med} max=${probe.price_max} listings=${probe.listing_count}`,
      )
    } catch (e) {
      failCount++
      console.error(`  ERR ggsan/${p.goods_no} — ${e instanceof Error ? e.message : String(e)}`)
    }
    await new Promise((r) => setTimeout(r, 130))
  }

  // 2) canonical product 상위 N (v4 trends_products) — naver_shopping_hot 기반
  if (!SKIP_CANONICAL) {
    const { data: canon, error: canonErr } = await sb
      .from('jimscanner_trends_products')
      .select('id, canonical_name, signals_30d')
      .order('signals_30d', { ascending: false, nullsFirst: false })
      .limit(N)
    if (canonErr) {
      console.warn(`canonical fetch skipped: ${canonErr.message}`)
    } else {
      for (const p of canon ?? []) {
        if (!p.canonical_name) continue
        try {
          const probe = await probeOne({
            goods_no: null,
            product_id: p.id,
            title: p.canonical_name,
          })
          okCount++
          console.log(
            `  OK canon/${p.id} "${p.canonical_name}" min=${probe.price_min} med=${probe.price_med} max=${probe.price_max} listings=${probe.listing_count}`,
          )
        } catch (e) {
          failCount++
          console.error(`  ERR canon/${p.id} — ${e instanceof Error ? e.message : String(e)}`)
        }
        await new Promise((r) => setTimeout(r, 130))
      }
    }
  }

  console.log(
    `[${new Date().toISOString()}] probe-retail-prices done — ok=${okCount} fail=${failCount}`,
  )
  process.exit(failCount > 0 && okCount === 0 ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
