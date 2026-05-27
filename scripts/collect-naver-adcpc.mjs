#!/usr/bin/env node
/**
 * 네이버 검색광고 키워드도구 → jimscanner_trends_keyword_adcost 적재.
 *
 * 로컬 WSL 전용 collector. scripts/run-crons.mjs 에서 호출 가능.
 *
 * 호출:
 *   node --env-file=.env.local scripts/collect-naver-adcpc.mjs
 *   node --env-file=.env.local scripts/collect-naver-adcpc.mjs --keywords="멜라토닌,오메가3"
 *
 * 필수 env (둘 다 있으면 실 API, 없으면 휴리스틱 fallback):
 *   NAVER_AD_API_KEY        — searchad customer api access key
 *   NAVER_AD_SECRET_KEY     — secret key
 *   NAVER_AD_CUSTOMER_ID    — customer id
 *   NEXT_PUBLIC_SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *
 * API 미설정 시: trends_products 의 최근 canonical_name 을 키워드로 보고
 *   monthly_search ~ alias_count * 1000, cpc 는 카테고리 휴리스틱으로 채움 (개발용 더미).
 */

import crypto from 'node:crypto'
import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('[adcpc] Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
  process.exit(1)
}

const sb = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false },
})

const NAVER_AD_API_KEY = process.env.NAVER_AD_API_KEY
const NAVER_AD_SECRET = process.env.NAVER_AD_SECRET_KEY
const NAVER_AD_CUSTOMER = process.env.NAVER_AD_CUSTOMER_ID
const HAS_NAVER = Boolean(NAVER_AD_API_KEY && NAVER_AD_SECRET && NAVER_AD_CUSTOMER)

const BASE_URL = 'https://api.searchad.naver.com'
const MAX_KEYWORDS_PER_RUN = 200

function signRequest(method, path, timestamp) {
  const message = `${timestamp}.${method}.${path}`
  return crypto.createHmac('sha256', NAVER_AD_SECRET).update(message).digest('base64')
}

async function fetchNaverKeywordTool(keywords) {
  // POST /keywordstool — bulk lookup (최대 5개 hintKeywords/요청)
  const path = '/keywordstool'
  const ts = String(Date.now())
  const sig = signRequest('GET', path, ts)
  const url = new URL(BASE_URL + path)
  url.searchParams.set('hintKeywords', keywords.join(','))
  url.searchParams.set('showDetail', '1')

  const res = await fetch(url, {
    headers: {
      'X-Timestamp': ts,
      'X-API-KEY': NAVER_AD_API_KEY,
      'X-Customer': NAVER_AD_CUSTOMER,
      'X-Signature': sig,
    },
  })
  if (!res.ok) throw new Error(`naver searchad ${res.status}: ${await res.text()}`)
  return res.json()
}

function parseSearchVolume(raw) {
  if (raw === '<10' || raw === '< 10') return 5
  const n = Number(raw)
  return Number.isFinite(n) ? n : 0
}

function heuristicCpcForCategory(catTop) {
  // 카테고리별 평균 CPC 추정 (네이버 광고 시장 평균, KRW)
  switch (catTop) {
    case 'health':
      return { low: 350, high: 1800, avg: 850 }
    case 'living':
      return { low: 200, high: 1200, avg: 550 }
    case 'digital':
      return { low: 400, high: 2500, avg: 1100 }
    default:
      return { low: 200, high: 1000, avg: 500 }
  }
}

async function loadKeywordsFromProducts(limit = MAX_KEYWORDS_PER_RUN) {
  const { data, error } = await sb
    .from('jimscanner_trends_products')
    .select('id, canonical_name, category_top, alias_count, last_seen_at')
    .order('last_seen_at', { ascending: false })
    .limit(limit)
  if (error) throw new Error('load products: ' + error.message)
  return data ?? []
}

async function runRealCollector(products) {
  const rows = []
  // 5개씩 배치
  for (let i = 0; i < products.length; i += 5) {
    const batch = products.slice(i, i + 5)
    const keywords = batch.map((p) => p.canonical_name)
    try {
      const resp = await fetchNaverKeywordTool(keywords)
      const list = resp?.keywordList ?? []
      for (const item of list) {
        const matched = batch.find(
          (p) => p.canonical_name.replace(/\s+/g, '') === String(item.relKeyword ?? '').replace(/\s+/g, ''),
        )
        const pc = parseSearchVolume(item.monthlyPcQcCnt)
        const mo = parseSearchVolume(item.monthlyMobileQcCnt)
        rows.push({
          keyword: item.relKeyword,
          product_id: matched?.id ?? null,
          monthly_search_pc: pc,
          monthly_search_mobile: mo,
          monthly_search_total: pc + mo,
          est_cpc_low: null,
          est_cpc_high: null,
          est_cpc_avg: null,
          competition_index: item.compIdx ?? null,
          ad_depth: Number(item.plAvgDepth) || null,
          source: 'naver_searchad',
          raw_payload: item,
        })
      }
      // 네이버 rate-limit 대비 짧은 sleep
      await new Promise((r) => setTimeout(r, 250))
    } catch (e) {
      console.error('[adcpc] batch failed:', e.message)
    }
  }
  return rows
}

async function runHeuristicCollector(products) {
  return products.map((p) => {
    const cpc = heuristicCpcForCategory(p.category_top)
    const baseSearch = Math.min(120000, (p.alias_count || 1) * 800 + 200)
    return {
      keyword: p.canonical_name,
      product_id: p.id,
      monthly_search_pc: Math.round(baseSearch * 0.35),
      monthly_search_mobile: Math.round(baseSearch * 0.65),
      monthly_search_total: baseSearch,
      est_cpc_low: cpc.low,
      est_cpc_high: cpc.high,
      est_cpc_avg: cpc.avg,
      competition_index: baseSearch > 50000 ? '높음' : baseSearch > 10000 ? '중간' : '낮음',
      ad_depth: baseSearch > 50000 ? 15 : 8,
      source: 'heuristic',
      raw_payload: { generated: 'heuristic-fallback', alias_count: p.alias_count },
    }
  })
}

async function upsertHeartbeat(status, notes) {
  await sb
    .from('jimscanner_trends_heartbeat')
    .upsert({
      id: 'main',
      heartbeat_at: new Date().toISOString(),
      last_collector: 'collect-naver-adcpc',
      last_run_status: status,
      notes,
    })
}

async function main() {
  const argv = process.argv.slice(2)
  const kwArg = argv.find((a) => a.startsWith('--keywords='))
  let products = []

  if (kwArg) {
    const list = kwArg.slice('--keywords='.length).split(',').map((s) => s.trim()).filter(Boolean)
    products = list.map((kw) => ({
      id: null,
      canonical_name: kw,
      category_top: 'living',
      alias_count: 1,
    }))
  } else {
    products = await loadKeywordsFromProducts()
  }

  if (products.length === 0) {
    console.log('[adcpc] 0 keywords to collect — exit')
    return
  }

  console.log(`[adcpc] collecting ${products.length} keywords (mode=${HAS_NAVER ? 'naver-api' : 'heuristic'})`)

  const rows = HAS_NAVER ? await runRealCollector(products) : await runHeuristicCollector(products)

  if (rows.length === 0) {
    console.log('[adcpc] no rows to insert')
    await upsertHeartbeat('partial', '0 rows fetched')
    return
  }

  // 동일 (keyword, source, collected_at) UNIQUE — collected_at 기본값 충돌 시 retry
  const stamped = rows.map((r) => ({ ...r, collected_at: new Date().toISOString() }))
  const { error } = await sb.from('jimscanner_trends_keyword_adcost').insert(stamped)
  if (error) {
    console.error('[adcpc] insert error:', error.message)
    await upsertHeartbeat('error', error.message)
    process.exit(1)
  }
  console.log(`[adcpc] inserted ${stamped.length} rows`)
  await upsertHeartbeat('ok', `inserted ${stamped.length}`)
}

main().catch((e) => {
  console.error('[adcpc] fatal:', e)
  process.exit(1)
})
