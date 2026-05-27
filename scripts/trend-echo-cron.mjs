#!/usr/bin/env node
/**
 * Cross-Lingual Demand Echo cron — 한·영·일 동시 트렌드 게이트
 *
 * 핀된 키워드 또는 최근 24h trends_keywords 상위에서 키워드를 뽑아
 * 다국가 시그널을 fetch 한 뒤 echo_score(0~3)를 산출한다.
 *
 *   0 = K-fad (한국 단발)
 *   1 = cross-border (KR + 1 인접국)
 *   2 = global sustained (KR + US 강세)
 *   3 = 전 지역 (KR + US + JP)
 *
 * 호출:
 *   node --env-file=.env.local scripts/trend-echo-cron.mjs
 *
 * 환경변수:
 *   NEXT_PUBLIC_SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 */

import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY')
  process.exit(1)
}

const sb = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
})

const MAX_KEYWORDS_PER_RUN = 40
const SLEEP_MS = 450

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ─────────────────────────────────────────
// 1) 후보 키워드 추출 — 핀된 키워드 우선, 모자라면 최근 24h 상위
async function pickKeywords() {
  const out = new Set()

  const { data: pins } = await sb
    .from('jimscanner_trends_pins')
    .select('keyword')
    .order('pinned_at', { ascending: false })
    .limit(MAX_KEYWORDS_PER_RUN)
  for (const p of pins ?? []) {
    if (p?.keyword) out.add(String(p.keyword).trim())
    if (out.size >= MAX_KEYWORDS_PER_RUN) break
  }

  if (out.size < MAX_KEYWORDS_PER_RUN) {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
    const { data: kws } = await sb
      .from('jimscanner_trends_keywords')
      .select('keyword, volume_relative, collected_at')
      .gte('collected_at', since)
      .order('volume_relative', { ascending: false, nullsFirst: false })
      .limit(MAX_KEYWORDS_PER_RUN * 2)
    for (const k of kws ?? []) {
      if (k?.keyword) out.add(String(k.keyword).trim())
      if (out.size >= MAX_KEYWORDS_PER_RUN) break
    }
  }

  return [...out].slice(0, MAX_KEYWORDS_PER_RUN)
}

// ─────────────────────────────────────────
// 2) 번역 — 캐시 우선, 없으면 원본을 그대로 사용 (스크립트는 외부 LLM 호출 안 함;
//    번역 보강은 별도 잡으로 분리. 영문 알파벳·숫자가 섞인 키워드는 그대로 검색 가능)
async function getTranslation(keyword, targetLocale) {
  const { data } = await sb
    .from('jimscanner_trends_echo_translations')
    .select('translated')
    .eq('keyword', keyword)
    .eq('locale', targetLocale)
    .maybeSingle()
  if (data?.translated) return data.translated
  // 폴백: 키워드에 ASCII 가 60% 이상이면 그대로 (브랜드/모델명 케이스),
  // 아니면 빈 번역 — 외국 시그널 fetch 스킵.
  const asciiRatio =
    [...keyword].filter((c) => /[\x00-\x7F]/.test(c)).length / Math.max(keyword.length, 1)
  if (asciiRatio >= 0.6) return keyword
  return null
}

// ─────────────────────────────────────────
// 3) Google suggest (locale 별 — gl/hl param)
async function fetchGoogleSuggest(q, gl, hl) {
  if (!q) return { hits: 0, items: [] }
  const url = `https://suggestqueries.google.com/complete/search?client=firefox&q=${encodeURIComponent(q)}&gl=${gl}&hl=${hl}`
  try {
    const res = await fetch(url, {
      headers: {
        'user-agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
      },
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok) return { hits: 0, items: [] }
    const j = await res.json()
    const items = Array.isArray(j?.[1]) ? j[1].slice(0, 20) : []
    return { hits: items.length, items }
  } catch {
    return { hits: 0, items: [] }
  }
}

// ─────────────────────────────────────────
// 4) Amazon autocomplete — 공개 completion endpoint
async function fetchAmazonSuggest(q, marketplace) {
  if (!q) return { hits: 0, items: [] }
  const mid = marketplace === 'JP' ? 6 : 1
  const alias = marketplace === 'JP' ? 'aps' : 'aps'
  const url = `https://completion.amazon.com/api/2017/suggestions?session-id=000&customer-id=&request-id=&mid=${mid}&alias=${alias}&prefix=${encodeURIComponent(q)}`
  try {
    const res = await fetch(url, {
      headers: {
        'user-agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
      },
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok) return { hits: 0, items: [] }
    const j = await res.json()
    const items = Array.isArray(j?.suggestions) ? j.suggestions.slice(0, 15) : []
    return { hits: items.length, items: items.map((s) => s?.value).filter(Boolean) }
  } catch {
    return { hits: 0, items: [] }
  }
}

// ─────────────────────────────────────────
// 5) Reddit mention count (search.json)
async function fetchRedditMentions(q) {
  if (!q) return { hits: 0 }
  const url = `https://www.reddit.com/search.json?q=${encodeURIComponent(q)}&limit=25&sort=new&t=week`
  try {
    const res = await fetch(url, {
      headers: {
        'user-agent': 'jimscanner-echo-cron/1.0 (+https://www.jimscanner.co.kr)',
      },
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok) return { hits: 0 }
    const j = await res.json()
    const cnt = Array.isArray(j?.data?.children) ? j.data.children.length : 0
    return { hits: cnt }
  } catch {
    return { hits: 0 }
  }
}

// ─────────────────────────────────────────
// 6) echo_score 산출
function scoreFromLocaleHits({ kr, us, jp }) {
  const krHot = kr >= 5
  const usHot = us >= 8
  const jpHot = jp >= 5
  if (!krHot) return 0
  const otherHot = [usHot, jpHot].filter(Boolean).length
  if (otherHot === 0) return 0
  if (otherHot === 1) return jpHot && !usHot ? 1 : 2
  return 3
}

// ─────────────────────────────────────────
// 7) main
async function main() {
  const startedAt = Date.now()
  let inserted = 0
  let processed = 0
  let errCount = 0

  const keywords = await pickKeywords()
  console.log(`[echo-cron] picked ${keywords.length} keywords`)

  for (const kw of keywords) {
    try {
      const enKw = (await getTranslation(kw, 'EN')) ?? kw
      const jaKw = await getTranslation(kw, 'JA')

      const [krSugg, usSugg, jpSugg, usAmz, jpAmz, redditUS] = await Promise.all([
        fetchGoogleSuggest(kw, 'kr', 'ko'),
        fetchGoogleSuggest(enKw, 'us', 'en'),
        jaKw ? fetchGoogleSuggest(jaKw, 'jp', 'ja') : Promise.resolve({ hits: 0, items: [] }),
        fetchAmazonSuggest(enKw, 'US'),
        jaKw ? fetchAmazonSuggest(jaKw, 'JP') : Promise.resolve({ hits: 0, items: [] }),
        fetchRedditMentions(enKw),
      ])

      const krHits = krSugg.hits
      const usHits = usSugg.hits + usAmz.hits + redditUS.hits
      const jpHits = jpSugg.hits + jpAmz.hits

      const score = scoreFromLocaleHits({ kr: krHits, us: usHits, jp: jpHits })

      const rows = [
        {
          keyword: kw,
          translated: kw,
          locale: 'KR',
          source: 'google_suggest',
          hits: krSugg.hits,
          score: 0,
          meta: { items: krSugg.items.slice(0, 5) },
        },
        {
          keyword: kw,
          translated: enKw,
          locale: 'US',
          source: 'google_suggest',
          hits: usSugg.hits,
          score: 0,
          meta: { items: usSugg.items.slice(0, 5) },
        },
        {
          keyword: kw,
          translated: enKw,
          locale: 'US',
          source: 'amazon_autocomplete',
          hits: usAmz.hits,
          score: 0,
          meta: { items: usAmz.items.slice(0, 5) },
        },
        {
          keyword: kw,
          translated: enKw,
          locale: 'US',
          source: 'reddit',
          hits: redditUS.hits,
          score: 0,
          meta: null,
        },
        {
          keyword: kw,
          translated: jaKw,
          locale: 'JP',
          source: 'google_suggest',
          hits: jpSugg.hits,
          score: 0,
          meta: { items: jpSugg.items.slice(0, 5) },
        },
        {
          keyword: kw,
          translated: jaKw,
          locale: 'JP',
          source: 'amazon_autocomplete',
          hits: jpAmz.hits,
          score: 0,
          meta: { items: jpAmz.items.slice(0, 5) },
        },
        {
          keyword: kw,
          translated: null,
          locale: 'ALL',
          source: 'echo',
          hits: krHits + usHits + jpHits,
          score,
          meta: { kr: krHits, us: usHits, jp: jpHits },
        },
      ]

      const { error } = await sb.from('jimscanner_trends_echo').insert(rows)
      if (error) {
        errCount++
        console.error(`[echo-cron] insert error for ${kw}:`, error.message)
      } else {
        inserted += rows.length
      }
      processed++
      await sleep(SLEEP_MS)
    } catch (e) {
      errCount++
      console.error(`[echo-cron] failed for ${kw}:`, e?.message ?? e)
    }
  }

  const durationMs = Date.now() - startedAt
  await sb.from('jimscanner_trends_runs').insert({
    source: 'trend_echo',
    status: errCount === 0 ? 'ok' : errCount < processed ? 'partial' : 'error',
    fetched_count: processed,
    inserted_count: inserted,
    duration_ms: durationMs,
    error_message: errCount > 0 ? `${errCount} keyword(s) failed` : null,
    triggered_by: 'cron',
    started_at: new Date(startedAt).toISOString(),
    finished_at: new Date().toISOString(),
  })

  console.log(
    `[echo-cron] done — processed=${processed} inserted=${inserted} errors=${errCount} dur=${durationMs}ms`,
  )
}

await main()
