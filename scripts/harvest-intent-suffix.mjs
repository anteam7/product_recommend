#!/usr/bin/env node
/**
 * 검색의도 suffix 하베스터 — 트렌드 레이더 v5 (2026-05-15)
 *
 * 각 canonical product 의 canonical_name 으로 Naver autosuggest 를 때리고
 * suffix 를 의도 사전에 매핑해서 jimscanner_trends_intent_signals 에 적재.
 *
 * 호출:
 *   node --env-file=.env.local scripts/harvest-intent-suffix.mjs
 *
 * 의도 사전:
 *   transactional  : 최저가·구매·할인·직구·쿠폰
 *   comparison     : 추천·비교·순위
 *   review         : 후기·리뷰·내돈내산
 *   informational  : 효능·부작용·성분
 *
 * 적재 후 purchase_intent_score 도 trends_scores 최근 row 에 업데이트.
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

// ── 의도 사전 ───────────────────────────────────────────────
const INTENT_DICT = {
  transactional: ['최저가', '구매', '할인', '직구', '쿠폰', '특가', '세일', '구입', '판매', '주문'],
  comparison: ['추천', '비교', '순위', '랭킹', '베스트', '인기'],
  review: ['후기', '리뷰', '내돈내산', '솔직후기', '사용기', '솔직'],
  informational: ['효능', '부작용', '성분', '효과', '뜻', '의미', '설명', '원리', '복용법', '사용법'],
}

const HARVEST_LIMIT = Number(process.env.HARVEST_LIMIT ?? 80)
const FETCH_TIMEOUT_MS = 5000
const SLEEP_MS = 200

function classifyKeyword(rawSuffix, baseName) {
  const suffix = (rawSuffix || '').toLowerCase().trim()
  if (!suffix) return 'unknown'
  // baseName 제거 (있으면) 해서 순수 modifier 만 확인
  const stripped = suffix.replace(new RegExp((baseName || '').toLowerCase(), 'g'), '').trim()
  const tokens = (stripped || suffix).split(/[\s+]+/).filter(Boolean)

  for (const [cls, words] of Object.entries(INTENT_DICT)) {
    for (const w of words) {
      if (tokens.some((t) => t.includes(w)) || stripped.includes(w) || suffix.includes(w)) {
        return cls
      }
    }
  }
  return 'unknown'
}

async function fetchNaverAutosuggest(keyword) {
  // Naver autosuggest 공개 endpoint (JSONP). _callback 없이도 JSON 반환.
  const url = `https://ac.search.naver.com/nx/ac?q=${encodeURIComponent(keyword)}&st=100&r_format=json&r_enc=UTF-8&r_unicode=0&t_koreng=1&run=2&rev=4&q_enc=UTF-8`
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
        Accept: 'application/json,text/plain,*/*',
        Referer: 'https://www.naver.com/',
      },
    })
    if (!res.ok) return []
    const json = await res.json()
    // 응답 모양: { items: [[ ["keyword", "...", "..."], ... ]] }
    const items = json?.items?.[0] ?? []
    const out = []
    for (let i = 0; i < items.length; i++) {
      const row = items[i]
      const kw = Array.isArray(row) ? row[0] : row
      if (typeof kw === 'string' && kw.trim()) {
        // 순위 기반 상대 volume (0~100): 상위일수록 큰 값
        const vol = Math.max(0, 100 - i * (100 / Math.max(items.length, 1)))
        out.push({ keyword: kw.trim(), volume: Math.round(vol) })
      }
    }
    return out
  } catch {
    return []
  } finally {
    clearTimeout(timer)
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

function calcPurchaseIntentScore(counts, totalVolume) {
  // 거래 의도 가중치 — transactional 가장 크게.
  const W = { transactional: 1.0, comparison: 0.55, review: 0.4, informational: 0.0, unknown: 0.1 }
  if (!totalVolume) return 0
  let score = 0
  for (const [cls, vol] of Object.entries(counts)) {
    score += (W[cls] ?? 0) * vol
  }
  const raw = score / totalVolume // 0~1
  return Math.round(Math.max(0, Math.min(1, raw)) * 100)
}

async function main() {
  console.log('[harvest-intent-suffix] start')

  // 최근 본 product 만 (전체가 많으면 부담)
  const { data: products, error: prodErr } = await sb
    .from('jimscanner_trends_products')
    .select('id, canonical_name, category_top, last_seen_at')
    .order('last_seen_at', { ascending: false })
    .limit(HARVEST_LIMIT)
  if (prodErr) {
    console.error('product fetch failed:', prodErr)
    process.exit(1)
  }

  console.log(`  candidates: ${products?.length ?? 0}`)

  const runStart = Date.now()
  let okCount = 0
  let insertedCount = 0
  let scoreUpdatedCount = 0

  for (const p of products ?? []) {
    const base = (p.canonical_name || '').trim()
    if (!base) continue

    const suggestions = await fetchNaverAutosuggest(base)
    if (suggestions.length === 0) {
      await sleep(SLEEP_MS)
      continue
    }
    okCount += 1

    // 의도 분류 + 적재 row 작성
    const rows = []
    const counts = { transactional: 0, comparison: 0, review: 0, informational: 0, unknown: 0 }
    let totalVolume = 0
    for (const s of suggestions) {
      const cls = classifyKeyword(s.keyword, base)
      rows.push({
        product_id: p.id,
        intent_class: cls,
        co_keyword: s.keyword,
        volume: s.volume,
        source: 'naver_autosuggest',
      })
      counts[cls] = (counts[cls] || 0) + s.volume
      totalVolume += s.volume
    }

    if (rows.length > 0) {
      const { error: insErr } = await sb.from('jimscanner_trends_intent_signals').insert(rows)
      if (insErr) {
        console.warn(`  insert failed (${base}):`, insErr.message)
      } else {
        insertedCount += rows.length
      }
    }

    // 최신 score row 에 purchase_intent_score 업데이트
    const purchaseScore = calcPurchaseIntentScore(counts, totalVolume)
    const { data: latestScore } = await sb
      .from('jimscanner_trends_scores')
      .select('id')
      .eq('product_id', p.id)
      .order('computed_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (latestScore?.id) {
      const { error: updErr } = await sb
        .from('jimscanner_trends_scores')
        .update({ purchase_intent_score: purchaseScore })
        .eq('id', latestScore.id)
      if (!updErr) scoreUpdatedCount += 1
    }

    await sleep(SLEEP_MS)
  }

  const duration = Date.now() - runStart
  console.log(
    `[harvest-intent-suffix] done — ok ${okCount} / inserted ${insertedCount} / scores updated ${scoreUpdatedCount} / ${duration}ms`,
  )

  // 감사 로그
  await sb.from('jimscanner_trends_runs').insert({
    source: 'harvest_intent_suffix',
    status: okCount > 0 ? 'ok' : 'partial',
    fetched_count: products?.length ?? 0,
    inserted_count: insertedCount,
    duration_ms: duration,
    triggered_by: 'cli',
    finished_at: new Date().toISOString(),
  })
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
