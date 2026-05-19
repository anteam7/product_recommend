#!/usr/bin/env node
/**
 * Global→KR 시차 차익 보드 — 해외 베스트셀러 수집 cron.
 *
 * 동작:
 *   1. jimscanner_trends_seeds 에서 kind='foreign_best' 시드 조회.
 *   2. 각 시드 URL 을 fetch → HTML 에서 상품명 후보 추출.
 *   3. jimscanner_trends_raw + jimscanner_trends_keywords 에 적재.
 *   4. jimscanner_trends_runs 감사 로그 기록.
 *
 * 사용:
 *   node --env-file=.env.local scripts/fetch-foreign-best.mjs
 *   node --env-file=.env.local scripts/fetch-foreign-best.mjs --source amazon_best_us
 *
 * 환경변수:
 *   NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing.')
  process.exit(1)
}

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36'

const args = process.argv.slice(2)
const sourceFilter = (() => {
  const i = args.indexOf('--source')
  return i >= 0 ? args[i + 1] : null
})()

const sb = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false },
})

function cleanTitle(s) {
  return s
    .replace(/\s+/g, ' ')
    .replace(/[​-‍﻿]/g, '')
    .trim()
}

/**
 * 일반화된 HTML → 상품명 후보 추출.
 * 사이트별 정밀 셀렉터 대신 휴리스틱으로 시작 (cron 안정성 우선).
 *   - Amazon: <span class="zg-bdg-text"> 또는 <a class="a-link-normal"><span>...
 *   - Rakuten: <span class="title"> 또는 <a class="title">
 *   - Taobao: og:title / meta keywords (CN 사이트는 SPA → 헤더 시그널 위주)
 */
function extractTitles(html, source) {
  const titles = new Set()

  if (source === 'amazon_best_us') {
    // Amazon 상품 카드는 <div class="p13n-sc-truncate"> 또는 <span class="zg-bdg-text">
    const re1 = /<div[^>]*class="[^"]*p13n-sc-truncate[^"]*"[^>]*>([\s\S]*?)<\/div>/g
    for (const m of html.matchAll(re1)) {
      const t = cleanTitle(m[1].replace(/<[^>]+>/g, ' '))
      if (t.length >= 8 && t.length <= 200) titles.add(t)
    }
    // fallback: aria-label on product links
    const re2 = /aria-label="([^"]{15,200})"/g
    for (const m of html.matchAll(re2)) {
      const t = cleanTitle(m[1])
      if (t && !/^(Previous|Next|Page)/i.test(t)) titles.add(t)
    }
  } else if (source === 'rakuten_best_jp') {
    // Rakuten ranking: <a class="rnkRanking_imageLink"> alt, or h3 titles
    const re1 = /<h\d[^>]*class="[^"]*(?:title|itemName|rnkRanking)[^"]*"[^>]*>([\s\S]*?)<\/h\d>/g
    for (const m of html.matchAll(re1)) {
      const t = cleanTitle(m[1].replace(/<[^>]+>/g, ' '))
      if (t.length >= 8 && t.length <= 200) titles.add(t)
    }
    const re2 = /<img[^>]*alt="([^"]{15,200})"[^>]*>/g
    for (const m of html.matchAll(re2)) {
      const t = cleanTitle(m[1])
      if (t) titles.add(t)
    }
  } else if (source === 'taobao_best_cn') {
    // Taobao is JS-rendered; pick og/meta + visible Chinese product strings
    const re1 = /<meta[^>]*name="keywords"[^>]*content="([^"]+)"/i
    const m1 = html.match(re1)
    if (m1) {
      for (const t of m1[1].split(/[,，]/)) {
        const c = cleanTitle(t)
        if (c.length >= 2 && c.length <= 60) titles.add(c)
      }
    }
    // Chinese characters runs (loose heuristic)
    const re2 = />([一-龥][一-龥A-Za-z0-9·\s]{4,40}[一-龥A-Za-z0-9])</g
    for (const m of html.matchAll(re2)) {
      const t = cleanTitle(m[1])
      if (t) titles.add(t)
    }
  }

  return Array.from(titles).slice(0, 100)
}

async function recordRun(source, status, fetched, inserted, durationMs, errorMessage) {
  await sb.from('jimscanner_trends_runs').insert({
    source,
    status,
    fetched_count: fetched,
    inserted_count: inserted,
    duration_ms: durationMs,
    error_message: errorMessage ?? null,
    triggered_by: 'cli',
    finished_at: new Date().toISOString(),
  })
}

async function processSeed(seed) {
  const { source, config, label } = seed
  const url = config?.url
  const categoryTop = config?.category_top ?? 'unknown'
  const market = config?.market ?? 'unknown'

  if (!url) return { skipped: true, reason: 'no url' }

  const t0 = Date.now()
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': UA,
        'Accept-Language': 'en-US,en;q=0.9,ja;q=0.7,zh;q=0.5,ko;q=0.3',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      // 큰 사이트는 늦음 — 25초 timeout
      signal: AbortSignal.timeout(25_000),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const html = await res.text()
    const titles = extractTitles(html, source)

    const collectedAt = new Date().toISOString()

    await sb.from('jimscanner_trends_raw').insert({
      source,
      request_label: label ?? `${source}:${categoryTop}`,
      payload: {
        url,
        market,
        category_top: categoryTop,
        size: html.length,
        title_count: titles.length,
        sample: titles.slice(0, 10),
      },
      collected_at: collectedAt,
    })

    let inserted = 0
    if (titles.length > 0) {
      const rows = titles.slice(0, 50).map((t, i) => ({
        keyword: t,
        source,
        category: market,
        category_top: categoryTop,
        rank: i + 1,
        collected_at: collectedAt,
      }))
      const { error } = await sb.from('jimscanner_trends_keywords').insert(rows)
      if (error) throw new Error(`keywords insert: ${error.message}`)
      inserted = rows.length
    }

    const ms = Date.now() - t0
    await recordRun(source, inserted > 0 ? 'ok' : 'partial', titles.length, inserted, ms)
    return { ok: true, source, fetched: titles.length, inserted, ms }
  } catch (e) {
    const ms = Date.now() - t0
    const msg = e instanceof Error ? e.message : String(e)
    await recordRun(source, 'error', 0, 0, ms, msg)
    return { ok: false, source, error: msg, ms }
  }
}

async function main() {
  const q = sb
    .from('jimscanner_trends_seeds')
    .select('source, kind, label, config, is_active')
    .eq('kind', 'foreign_best')
    .eq('is_active', true)

  if (sourceFilter) q.eq('source', sourceFilter)

  const { data: seeds, error } = await q
  if (error) {
    console.error('seeds query failed:', error.message)
    process.exit(1)
  }
  if (!seeds || seeds.length === 0) {
    console.error('no foreign_best seeds. apply supabase/trends_market_lag.sql first.')
    process.exit(1)
  }

  console.log(`[fetch-foreign-best] ${seeds.length} seed(s)`)
  let okCount = 0
  let failCount = 0
  for (const s of seeds) {
    const r = await processSeed(s)
    if (r.ok) {
      okCount++
      console.log(`  OK  ${r.source.padEnd(20)} ${String(r.fetched).padStart(3)} → ${String(r.inserted).padStart(3)}  ${r.ms}ms`)
    } else if (r.skipped) {
      console.log(`  SKIP ${s.source.padEnd(20)} (${r.reason})`)
    } else {
      failCount++
      console.log(`  ERR ${r.source.padEnd(20)} ${r.error}`)
    }
  }
  console.log(`[fetch-foreign-best] done — ${okCount} ok, ${failCount} fail`)
  process.exit(failCount > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error('fatal:', e)
  process.exit(1)
})
