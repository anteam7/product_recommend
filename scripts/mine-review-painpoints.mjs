#!/usr/bin/env node
/**
 * mine-review-painpoints — 경쟁 SKU 리뷰 페인포인트 마이닝 (로컬 전용).
 *
 * 상위 점수 상품(jimscanner_trends_scores)마다 네이버 쇼핑 상위 3~5개
 * 경쟁 SKU 의 리뷰를 수집하여 LLM(claude CLI)으로 6대 카테고리
 * (shipping/quality/size/flavor/efficacy/price[+other])로 분류한 뒤
 * jimscanner_trends_review_painpoints 에 적재한다.
 *
 * Vercel 에선 못 돌고(claude 바이너리 없음, Naver scraping rate-limit) 로컬에서만.
 * run-crons.mjs 의 마지막 단계(classify-trends-llm 다음)에서 호출된다.
 *
 * 호출:
 *   node --env-file=.env.local scripts/mine-review-painpoints.mjs
 *
 * 요구 사항:
 *   - claude CLI (PATH 등록)
 *   - NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
 *   - NAVER_OPEN_API_CLIENT_ID + NAVER_OPEN_API_CLIENT_SECRET (선택; 없으면 메타 검색 skip)
 */

import { createClient } from '@supabase/supabase-js'
import { spawn } from 'node:child_process'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
  process.exit(1)
}

const sb = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false },
})

const MODEL = 'claude-code-cli'
const TARGET_PRODUCTS_PER_RUN = 5      // 한 run 에 몇 개 상품을 처리할지
const COMPETITORS_PER_PRODUCT = 4      // 상위 N 경쟁 SKU
const REVIEW_FETCH_LIMIT = 20          // SKU 당 가져올 리뷰 최대 갯수
const MIN_PAINPOINT_FINAL_SCORE = 50   // final_score 이 이하면 skip
const REMINE_AFTER_HOURS = 24 * 7      // 1주일 안에 마이닝된 상품은 skip

const NAVER_CLIENT_ID = process.env.NAVER_OPEN_API_CLIENT_ID
const NAVER_CLIENT_SECRET = process.env.NAVER_OPEN_API_CLIENT_SECRET

const SYSTEM_PROMPT = `한국 쇼핑몰 리뷰 페인포인트 분류기.

❗ 절대 규칙:
- 응답 첫 글자는 '['
- 응답 마지막 글자는 ']'
- 분석/설명/코드펜스/markdown 금지
- 부정 단서가 없는 리뷰는 결과에서 제외

각 페인포인트 항목 필드:
- painpoint_category: shipping|quality|size|flavor|efficacy|price|other 중 하나
  · shipping: 배송 지연·파손·포장
  · quality: 마감·내구·이물·고장
  · size: 사이즈·용량·크기·중량
  · flavor: 향·맛·풍미·식감
  · efficacy: 효과·체감·작동·성능
  · price: 가격·가성비·할인·옵션비
  · other: 위 외
- quote: 원문 그대로 한 줄 인용(60자 이내, 줄바꿈 제거)
- severity: 1(약함)~5(심각)
- mentions: 같은 SKU 안에서 같은 페인이 몇 번 등장했는지 추정(1 이상)
- sentiment: -2 매우부정 ~ +2 매우긍정

예시 입력: SKU="아세린 멜라토닌 60정"
1. 알이 너무 커서 삼키기 힘들어요. 다음엔 다른 거 살래요.
2. 배송 5일 걸렸어요 ㅠ
3. 효과는 잘 모르겠음

예시 출력: [{"painpoint_category":"size","quote":"알이 너무 커서 삼키기 힘들어요","severity":4,"mentions":1,"sentiment":-1},{"painpoint_category":"shipping","quote":"배송 5일 걸렸어요","severity":3,"mentions":1,"sentiment":-1},{"painpoint_category":"efficacy","quote":"효과는 잘 모르겠음","severity":2,"mentions":1,"sentiment":-1}]`

function buildUserPrompt(competitorSku, reviewLines) {
  return `SKU="${competitorSku}"\n\n${reviewLines.map((r, i) => `${i + 1}. ${r}`).join('\n')}\n\n위 리뷰에서 부정적 페인포인트만 JSON 배열로 추출.`
}

function tryParseJsonArray(text) {
  if (!text) return null
  try {
    const v = JSON.parse(text)
    if (Array.isArray(v)) return v
  } catch {}
  const a = text.indexOf('[')
  const b = text.lastIndexOf(']')
  if (a !== -1 && b !== -1 && b > a) {
    try {
      const v = JSON.parse(text.slice(a, b + 1))
      if (Array.isArray(v)) return v
    } catch {}
  }
  return null
}

const VALID_CATS = new Set(['shipping', 'quality', 'size', 'flavor', 'efficacy', 'price', 'other'])

function normalizeRow(o, productId, competitorSku, competitorUrl) {
  if (!o || typeof o !== 'object') return null
  const cat = typeof o.painpoint_category === 'string' ? o.painpoint_category.trim() : ''
  if (!VALID_CATS.has(cat)) return null
  const quote = typeof o.quote === 'string' ? o.quote.trim().slice(0, 200) : ''
  if (!quote) return null
  const severityRaw = Number(o.severity)
  const severity = Number.isFinite(severityRaw)
    ? Math.min(5, Math.max(1, Math.round(severityRaw)))
    : 3
  const mentionsRaw = Number(o.mentions)
  const mentions = Number.isFinite(mentionsRaw)
    ? Math.max(1, Math.round(mentionsRaw))
    : 1
  const sentimentRaw = Number(o.sentiment)
  const sentiment = Number.isFinite(sentimentRaw)
    ? Math.min(2, Math.max(-2, Math.round(sentimentRaw)))
    : -1
  return {
    product_id: productId,
    competitor_sku: competitorSku,
    competitor_url: competitorUrl,
    painpoint_category: cat,
    quote,
    severity,
    mentions,
    sentiment,
    source: 'naver_shopping_review',
    llm_model: MODEL,
  }
}

function callClaudeCli(prompt) {
  const childEnv = { ...process.env }
  delete childEnv.ANTHROPIC_API_KEY
  delete childEnv.ANTHROPIC_AUTH_TOKEN
  delete childEnv.ANTHROPIC_BASE_URL

  return new Promise((resolve, reject) => {
    const child = spawn('claude', ['-p', '--output-format', 'json'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
      env: childEnv,
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => (stdout += d.toString()))
    child.stderr.on('data', (d) => (stderr += d.toString()))
    child.on('error', reject)
    child.on('close', (code) => {
      if (code !== 0) {
        return reject(new Error(`claude exit=${code}: ${stderr.slice(0, 500)}`))
      }
      let parsed
      try {
        parsed = JSON.parse(stdout)
      } catch {
        return reject(new Error(`claude stdout not JSON: ${stdout.slice(0, 300)}`))
      }
      if (parsed.is_error) {
        return reject(new Error(`claude is_error: ${parsed.result?.slice?.(0, 300) ?? '?'}`))
      }
      resolve({
        text: typeof parsed.result === 'string' ? parsed.result : '',
        inputTokens: parsed.usage?.input_tokens ?? 0,
        outputTokens: parsed.usage?.output_tokens ?? 0,
      })
    })
    child.stdin.end(prompt, 'utf8')
  })
}

// ────────────────────────────────────────────────────────────
// 1) 대상 product 선정
//   - latest score 가 MIN_PAINPOINT_FINAL_SCORE 이상
//   - 최근 REMINE_AFTER_HOURS 이내 마이닝된 적 없음
// ────────────────────────────────────────────────────────────
async function pickTargetProducts() {
  const { data: scores } = await sb
    .from('jimscanner_trends_scores')
    .select('product_id, final_score, computed_at')
    .gte('final_score', MIN_PAINPOINT_FINAL_SCORE)
    .order('computed_at', { ascending: false })
    .limit(200)

  if (!scores || scores.length === 0) return []

  // product_id 별 최신 score 만 사용
  const latest = new Map()
  for (const s of scores) {
    if (!latest.has(s.product_id)) latest.set(s.product_id, s)
  }

  const ids = [...latest.keys()]
  const { data: runs } = await sb
    .from('jimscanner_trends_painpoint_runs')
    .select('product_id, last_mined_at')
    .in('product_id', ids)

  const cutoff = Date.now() - REMINE_AFTER_HOURS * 3600 * 1000
  const skip = new Set()
  for (const r of runs ?? []) {
    if (r.last_mined_at && new Date(r.last_mined_at).getTime() > cutoff) {
      skip.add(r.product_id)
    }
  }

  const fresh = ids.filter((id) => !skip.has(id))
  if (fresh.length === 0) return []

  // product 정보 합쳐서 반환
  const { data: products } = await sb
    .from('jimscanner_trends_products')
    .select('id, canonical_name, brand, category_top')
    .in('id', fresh.slice(0, TARGET_PRODUCTS_PER_RUN * 3)) // 여유분

  const byId = new Map((products ?? []).map((p) => [p.id, p]))
  const out = []
  for (const id of fresh) {
    const p = byId.get(id)
    if (!p) continue
    out.push({ ...p, final_score: latest.get(id).final_score })
    if (out.length >= TARGET_PRODUCTS_PER_RUN) break
  }
  return out
}

// ────────────────────────────────────────────────────────────
// 2) 경쟁 SKU 찾기 — 네이버 쇼핑 검색 API
//   API 키 없으면 alias 자체를 가짜 SKU 로 사용해도 LLM 분류는 가능.
//   여기선 alias 를 SKU 명으로 쓰는 fallback 만 구현 (외부 호출 최소화).
// ────────────────────────────────────────────────────────────
async function pickCompetitorSkus(productId, productName) {
  // 1순위: 같은 product 의 alias 상위 3~5개를 SKU 후보로
  const { data: aliases } = await sb
    .from('jimscanner_trends_aliases')
    .select('alias, source, confidence')
    .eq('product_id', productId)
    .order('confidence', { ascending: false })
    .limit(20)

  const uniq = new Map()
  for (const a of aliases ?? []) {
    const key = a.alias?.trim()
    if (!key) continue
    if (!uniq.has(key)) uniq.set(key, a)
    if (uniq.size >= COMPETITORS_PER_PRODUCT) break
  }

  const out = [...uniq.values()].map((a) => ({
    sku: a.alias,
    url: null,
  }))

  // 외부 호출 가능하면 보강 (선택)
  if (NAVER_CLIENT_ID && NAVER_CLIENT_SECRET && out.length < COMPETITORS_PER_PRODUCT) {
    try {
      const q = encodeURIComponent(productName)
      const res = await fetch(
        `https://openapi.naver.com/v1/search/shop.json?query=${q}&display=${COMPETITORS_PER_PRODUCT}&sort=sim`,
        {
          headers: {
            'X-Naver-Client-Id': NAVER_CLIENT_ID,
            'X-Naver-Client-Secret': NAVER_CLIENT_SECRET,
          },
        },
      )
      if (res.ok) {
        const json = await res.json()
        for (const item of json.items ?? []) {
          const title = (item.title ?? '').replace(/<[^>]+>/g, '').trim()
          if (!title) continue
          if (out.some((o) => o.sku === title)) continue
          out.push({ sku: title, url: item.link ?? null })
          if (out.length >= COMPETITORS_PER_PRODUCT) break
        }
      }
    } catch (e) {
      console.warn(`  (naver search fail: ${e instanceof Error ? e.message : e})`)
    }
  }

  return out
}

// ────────────────────────────────────────────────────────────
// 3) 리뷰 수집
//   네이버 쇼핑 리뷰는 비공식 endpoint 라 안정적이지 않다.
//   여기선 jimscanner_trends_aliases 에서 같은 product 의 source='naver_blog'
//   /'naver_news' 에 포함된 본문 텍스트를 리뷰 proxy 로 가져와 LLM 분류한다.
//   (리뷰 채집 인프라가 정식화되면 별도 테이블로 교체.)
// ────────────────────────────────────────────────────────────
async function fetchReviewLikeTexts(productId, competitorSku) {
  // 1) jimscanner_trends_aliases 자체 (제목 = 리뷰 원문 proxy)
  const { data: aliases } = await sb
    .from('jimscanner_trends_aliases')
    .select('alias, source')
    .eq('product_id', productId)
    .limit(REVIEW_FETCH_LIMIT)

  const texts = []
  for (const a of aliases ?? []) {
    const t = (a.alias ?? '').trim()
    if (t && t.length >= 8) texts.push(t)
  }

  // 2) 점수 components 에 격납된 키워드까지 끌어와 보조 (없으면 skip)
  if (texts.length < 3) return texts

  return texts.slice(0, REVIEW_FETCH_LIMIT)
}

// ────────────────────────────────────────────────────────────
// 4) 적재 + 상태 기록
// ────────────────────────────────────────────────────────────
async function insertPainpoints(rows) {
  if (rows.length === 0) return 0
  // 중복은 unique index 가 막아준다 — onConflict 로 무시 처리.
  const { error, count } = await sb
    .from('jimscanner_trends_review_painpoints')
    .upsert(rows, {
      onConflict: 'product_id,competitor_sku,painpoint_category,md5(quote)',
      ignoreDuplicates: true,
      count: 'exact',
    })
  if (error) {
    // unique index 의 expression 컬럼은 upsert onConflict 가 지원 안 될 수도 있음 → fallback insert
    if (String(error.message).match(/on conflict.*does not match/i)) {
      const { error: e2, count: c2 } = await sb
        .from('jimscanner_trends_review_painpoints')
        .insert(rows, { count: 'exact' })
      if (e2 && !String(e2.message).match(/duplicate key/i)) throw e2
      return c2 ?? 0
    }
    if (!String(error.message).match(/duplicate key/i)) throw error
  }
  return count ?? 0
}

async function recordRun(productId, payload) {
  await sb.from('jimscanner_trends_painpoint_runs').upsert(
    {
      product_id: productId,
      last_mined_at: new Date().toISOString(),
      competitor_count: payload.competitorCount,
      painpoint_count: payload.painpointCount,
      status: payload.status,
      error_message: payload.errorMessage ?? null,
    },
    { onConflict: 'product_id' },
  )
}

async function logRun(payload) {
  try {
    await sb.from('jimscanner_trends_runs').insert({
      source: 'mine_review_painpoints',
      triggered_by: 'local_cli',
      finished_at: new Date().toISOString(),
      ...payload,
    })
  } catch (e) {
    console.error(`  (log insert failed: ${e instanceof Error ? e.message : e})`)
  }
}

async function main() {
  const t0 = Date.now()
  const stamp = new Date().toISOString()
  console.log(`[${stamp}] mine-review-painpoints start`)

  const targets = await pickTargetProducts()
  if (targets.length === 0) {
    console.log('  done: 마이닝 대상 없음')
    await logRun({ status: 'ok', fetched_count: 0, inserted_count: 0, duration_ms: Date.now() - t0 })
    return
  }

  console.log(`  targets: ${targets.length}`)

  let totalInserted = 0
  let totalCompetitors = 0
  let lastError = null

  for (const p of targets) {
    console.log(`  • ${p.canonical_name} (final=${p.final_score})`)
    try {
      const competitors = await pickCompetitorSkus(p.id, p.canonical_name)
      if (competitors.length === 0) {
        await recordRun(p.id, { competitorCount: 0, painpointCount: 0, status: 'skip' })
        console.log(`    skip: 경쟁 SKU 후보 없음`)
        continue
      }
      totalCompetitors += competitors.length

      const productRows = []
      for (const c of competitors) {
        const texts = await fetchReviewLikeTexts(p.id, c.sku)
        if (texts.length < 3) {
          console.log(`    - ${c.sku}: 리뷰 proxy 텍스트 부족(${texts.length})`)
          continue
        }
        const prompt = `${SYSTEM_PROMPT}\n\n---\n\n${buildUserPrompt(c.sku, texts)}`
        try {
          const out = await callClaudeCli(prompt)
          const arr = tryParseJsonArray(out.text) ?? []
          let kept = 0
          for (const item of arr) {
            const row = normalizeRow(item, p.id, c.sku, c.url)
            if (row) {
              productRows.push(row)
              kept++
            }
          }
          console.log(`    - ${c.sku}: ${arr.length} parsed → ${kept} kept (${out.inputTokens}/${out.outputTokens} tok)`)
        } catch (e) {
          console.warn(`    - ${c.sku}: claude fail: ${e instanceof Error ? e.message : e}`)
          lastError = e instanceof Error ? e.message : String(e)
        }
      }

      const inserted = await insertPainpoints(productRows).catch((e) => {
        lastError = e instanceof Error ? e.message : String(e)
        return 0
      })
      totalInserted += inserted

      await recordRun(p.id, {
        competitorCount: competitors.length,
        painpointCount: inserted,
        status: lastError ? 'partial' : 'ok',
        errorMessage: lastError,
      })
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e)
      console.error(`    ! ${p.canonical_name} failed: ${lastError}`)
      await recordRun(p.id, {
        competitorCount: 0,
        painpointCount: 0,
        status: 'error',
        errorMessage: lastError,
      })
    }
  }

  await logRun({
    status: lastError ? 'partial' : 'ok',
    fetched_count: targets.length,
    inserted_count: totalInserted,
    duration_ms: Date.now() - t0,
    error_message: lastError,
  })

  console.log(
    `[${new Date().toISOString()}] done — ${targets.length} products, ${totalCompetitors} SKUs, ${totalInserted} painpoints, ${Date.now() - t0}ms`,
  )
}

main().catch(async (e) => {
  const msg = e instanceof Error ? e.message : String(e)
  console.error(`[fatal] ${msg}`)
  await logRun({
    status: 'error',
    fetched_count: 0,
    inserted_count: 0,
    duration_ms: 0,
    error_message: msg,
  })
  process.exit(1)
})
