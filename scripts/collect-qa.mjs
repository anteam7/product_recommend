#!/usr/bin/env node
/**
 * Q&A Vacuum Mining — SERP 상위 상품 상세의 Q&A 수집기 (로컬 WSL playwright)
 *
 * keyword 별 쿠팡·네이버 스마트스토어 SERP 상위 N개 상품의 Q&A 섹션을 파싱해
 * jimscanner_trends_qa_raw 에 적재. 이후 classify-qa-llm.mjs 가 intent_label 분류,
 * recompute-qa-clusters.mjs 가 jimscanner_trends_qa_clusters 로 집계.
 *
 * 호출:
 *   node --env-file=.env.local scripts/collect-qa.mjs --keyword="오메가3" --source=coupang --top=10
 *   node --env-file=.env.local scripts/collect-qa.mjs --keyword-file=keywords.txt --source=coupang
 *
 * 요구 사항:
 *   - playwright (npm i -D playwright) — WSL/로컬 PC 에서만
 *   - NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
 *
 * 참고: 본 스크립트는 위탁 발굴용 어드민 도구이며 SERP scraping 정책을
 * 존중하기 위해 throttle (3-5s/req) + UA 명시 + robots 우회 금지.
 * 비공개 PC 단발 실행 가정. 대량 수집 금지.
 */

import { createClient } from '@supabase/supabase-js'
import crypto from 'node:crypto'
import fs from 'node:fs'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
  process.exit(1)
}

const sb = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false },
})

function parseArgs(argv) {
  const out = { top: 10, source: 'coupang', keyword: null, keywordFile: null, dryRun: false }
  for (const a of argv.slice(2)) {
    const [k, v] = a.includes('=') ? a.split('=', 2) : [a, 'true']
    const key = k.replace(/^--/, '')
    if (key === 'top') out.top = Math.max(1, Math.min(20, parseInt(v, 10) || 10))
    else if (key === 'source') out.source = String(v).toLowerCase()
    else if (key === 'keyword') out.keyword = v
    else if (key === 'keyword-file') out.keywordFile = v
    else if (key === 'dry-run') out.dryRun = v !== 'false'
  }
  return out
}

function sha1(s) {
  return crypto.createHash('sha1').update(s, 'utf8').digest('hex')
}

function lagHoursBetween(askedIso, answeredIso) {
  if (!askedIso || !answeredIso) return null
  const a = Date.parse(askedIso)
  const b = Date.parse(answeredIso)
  if (Number.isNaN(a) || Number.isNaN(b) || b < a) return null
  return Math.round(((b - a) / 36e5) * 10) / 10
}

async function loadKeywords(args) {
  if (args.keyword) return [args.keyword]
  if (args.keywordFile) {
    const txt = fs.readFileSync(args.keywordFile, 'utf8')
    return txt.split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !s.startsWith('#'))
  }
  // fallback: 핀한 키워드에서 가져오기
  const { data } = await sb
    .from('jimscanner_trends_pins')
    .select('keyword')
    .order('pinned_at', { ascending: false })
    .limit(20)
  return (data ?? []).map((r) => r.keyword).filter(Boolean)
}

/**
 * 쿠팡 SERP 상위 N개 상품 URL 추출.
 * 실제 playwright 로직은 scripts/coupang-debug-search.mjs 의 파서를 재사용 가능.
 * 본 함수는 인터페이스 stub — 실수집은 playwright 모듈 로드 후 처리.
 */
async function fetchSerpUrls(keyword, source, top) {
  // playwright 모듈은 WSL 환경에만 존재 — 동적 import 로 가드.
  let chromium
  try {
    ({ chromium } = await import('playwright'))
  } catch {
    console.warn(`[serp] playwright 미설치 — ${keyword} 건너뜀 (npm i -D playwright 필요)`)
    return []
  }

  const browser = await chromium.launch({ headless: true })
  try {
    const ctx = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      locale: 'ko-KR',
    })
    const page = await ctx.newPage()

    if (source === 'coupang') {
      const u = `https://www.coupang.com/np/search?q=${encodeURIComponent(keyword)}`
      await page.goto(u, { waitUntil: 'domcontentloaded', timeout: 30000 })
      const urls = await page.$$eval('a[href*="/vp/products/"]', (els, n) =>
        Array.from(new Set(
          els
            .slice(0, 100)
            .map((e) => /** @type {HTMLAnchorElement} */ (e).href)
            .filter((h) => /\/vp\/products\/\d+/.test(h)),
        )).slice(0, n),
        top,
      )
      return urls
    }

    if (source === 'smartstore' || source === 'naver_brand') {
      const u = `https://search.shopping.naver.com/search/all?query=${encodeURIComponent(keyword)}`
      await page.goto(u, { waitUntil: 'domcontentloaded', timeout: 30000 })
      const urls = await page.$$eval('a[href*="smartstore.naver.com"]', (els, n) =>
        Array.from(new Set(
          els
            .map((e) => /** @type {HTMLAnchorElement} */ (e).href)
            .filter((h) => /smartstore\.naver\.com\/[^/]+\/products\/\d+/.test(h)),
        )).slice(0, n),
        top,
      )
      return urls
    }

    console.warn(`[serp] unknown source=${source}`)
    return []
  } finally {
    await browser.close()
  }
}

/**
 * 상품 상세의 Q&A 섹션 파싱.
 * 쿠팡: '상품문의' 탭 / 스마트스토어: 'Q&A' 탭.
 * 본 구현은 셀렉터 + 헤더 휴리스틱 — 사이트 마크업 변경 시 매뉴얼 패치 필요.
 */
async function fetchQa(productUrl, source) {
  let chromium
  try {
    ({ chromium } = await import('playwright'))
  } catch {
    return []
  }
  const browser = await chromium.launch({ headless: true })
  try {
    const ctx = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      locale: 'ko-KR',
    })
    const page = await ctx.newPage()
    await page.goto(productUrl, { waitUntil: 'domcontentloaded', timeout: 30000 })

    // 두 사이트 공통: Q&A 영역 내 dl/li 안에 질문/답변이 짝지어 있다고 가정.
    // 답변이 없는 질문은 답변 노드가 비어있거나 '답변대기' 텍스트.
    const items = await page.evaluate(() => {
      const out = []
      const wraps = document.querySelectorAll(
        '[class*="qna"], [class*="qaList"], [class*="QnA"], [data-component="ProductQna"]',
      )
      for (const w of Array.from(wraps).slice(0, 1)) {
        const rows = w.querySelectorAll('li, dl, .qa-item, .qna-row')
        for (const r of Array.from(rows).slice(0, 50)) {
          const qEl = r.querySelector('[class*="question"], .q, dt')
          const aEl = r.querySelector('[class*="answer"], .a, dd')
          const dEl = r.querySelector('time, .date, [class*="date"]')
          const q = (qEl?.textContent ?? '').trim()
          const a = (aEl?.textContent ?? '').trim()
          if (!q || q.length < 5) continue
          const isUnanswered = !a || /답변\s*대기|답변\s*예정|미답변/.test(a)
          out.push({
            question: q,
            answer: isUnanswered ? null : a,
            seller_responded: !isUnanswered,
            asked_at_text: (dEl?.textContent ?? '').trim() || null,
          })
        }
        if (out.length > 0) break
      }
      return out
    })

    return items
  } catch (err) {
    console.warn(`[qa] ${productUrl} 파싱 실패: ${err?.message ?? err}`)
    return []
  } finally {
    await browser.close()
  }
}

function parseKstDate(txt) {
  if (!txt) return null
  // '2025.10.12' / '25.10.12' / '2025-10-12'
  const m = txt.match(/(\d{2,4})[.\-/](\d{1,2})[.\-/](\d{1,2})/)
  if (!m) return null
  let [, y, mo, d] = m
  if (y.length === 2) y = `20${y}`
  const iso = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}T00:00:00+09:00`
  const t = Date.parse(iso)
  return Number.isNaN(t) ? null : new Date(t).toISOString()
}

async function insertRows(rows, dryRun) {
  if (rows.length === 0) return { inserted: 0 }
  if (dryRun) {
    console.log(`[dry-run] would insert ${rows.length} rows`)
    console.log(JSON.stringify(rows.slice(0, 3), null, 2))
    return { inserted: 0 }
  }
  const { error, count } = await sb
    .from('jimscanner_trends_qa_raw')
    .upsert(rows, { onConflict: 'source,product_url,question_hash', count: 'exact', ignoreDuplicates: true })
  if (error) {
    console.error('[insert] supabase 에러:', error.message)
    return { inserted: 0 }
  }
  return { inserted: count ?? rows.length }
}

async function main() {
  const args = parseArgs(process.argv)
  const keywords = await loadKeywords(args)
  if (keywords.length === 0) {
    console.error('수집할 keyword 없음. --keyword 또는 --keyword-file 지정.')
    process.exit(1)
  }
  console.log(`[start] keywords=${keywords.length} source=${args.source} top=${args.top} dryRun=${args.dryRun}`)

  let totalInserted = 0
  for (const kw of keywords) {
    console.log(`\n[kw] ${kw}`)
    const urls = await fetchSerpUrls(kw, args.source, args.top)
    console.log(`  SERP urls: ${urls.length}`)
    for (const url of urls) {
      const items = await fetchQa(url, args.source)
      console.log(`  ${url.slice(0, 60)}… qa=${items.length}`)
      const rows = items.map((it) => {
        const askedIso = parseKstDate(it.asked_at_text)
        return {
          keyword: kw,
          source: args.source,
          product_url: url,
          question: it.question.slice(0, 1000),
          question_hash: sha1(it.question.slice(0, 1000)),
          asked_at: askedIso,
          answered_at: it.seller_responded ? new Date().toISOString() : null,
          seller_responded: it.seller_responded,
          response_lag_hours: null,
        }
      })
      const { inserted } = await insertRows(rows, args.dryRun)
      totalInserted += inserted
      // 동일 호스트 throttle (3s)
      await new Promise((r) => setTimeout(r, 3000))
    }
    // 키워드 간 추가 throttle
    await new Promise((r) => setTimeout(r, 2000))
  }

  console.log(`\n[done] totalInserted=${totalInserted}`)

  // heartbeat 업데이트
  if (!args.dryRun) {
    await sb.from('jimscanner_trends_heartbeat').upsert(
      {
        id: 'main',
        heartbeat_at: new Date().toISOString(),
        last_collector: 'collect-qa',
        last_run_status: 'ok',
        notes: `qa_vacuum kw=${keywords.length} inserted=${totalInserted}`,
      },
      { onConflict: 'id' },
    )
  }
}

main().catch((err) => {
  console.error('fatal:', err)
  process.exit(1)
})
