#!/usr/bin/env node
/**
 * 카테고리 약점 차원 발굴 — Aspect-Sentiment 추출 (로컬 전용, PR-WEAKAXIS-1).
 *
 * 경쟁 SKU 리뷰를 Claude(Haiku) 로 attribute × sentiment 분해해
 * jimscanner_review_aspects 에 적재. 집계는 v_category_aspect_weakness 뷰.
 *
 * 리뷰 소스:
 *   jimscanner_ggsan_products.raw_payload 의 `reviews`(string[]) 또는
 *   `review_blob`(string) 필드. (쿠팡/네이버 SERP 수집기가 채워둔다고 가정.)
 *   리뷰가 없는 SKU 는 건너뜀.
 *
 * 호출:
 *   node --env-file=.env.local scripts/extract-review-aspects.mjs
 *   node --env-file=.env.local scripts/extract-review-aspects.mjs --limit 30
 *
 * 요구 사항:
 *   - claude CLI 가 PATH 에 있고 인증 완료 (classify-trends-llm 과 동일)
 *   - NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
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

const MODEL_TAG = 'claude-haiku-cli'
const HAIKU_MODEL = process.env.WEAKAXIS_MODEL || 'claude-haiku-4-5-20251001'
const args = process.argv.slice(2)
const limitIdx = args.indexOf('--limit')
const SKU_LIMIT = limitIdx >= 0 ? Number(args[limitIdx + 1]) || 40 : 40
const REVIEWS_PER_SKU = 12          // SKU 당 최대 샘플 리뷰
const MAX_SKU_PER_RUN = SKU_LIMIT
const REASSESS_AFTER_DAYS = 14      // 같은 SKU 재추출 주기

// aspect 표준 키 (DB·UI 와 일치해야 함)
const ASPECTS = ['delivery', 'packaging', 'quality', 'taste', 'size_fit', 'design', 'price', 'usability']
const SENTIMENTS = ['pos', 'neg', 'neu']

const SYSTEM_PROMPT = `너는 한국 이커머스 리뷰 분석기다. 입력은 한 상품의 리뷰 묶음.
각 리뷰에서 명시적으로 언급된 속성(aspect)만 감정(sentiment)과 함께 추출해 JSON 배열로 응답.

❗ 절대 규칙:
- 응답 첫 글자는 '[', 마지막 글자는 ']'
- 설명·코드펜스(\`\`\`)·markdown 금지
- 언급 안 된 속성은 만들지 말 것 (추측 금지)

각 항목 필드:
- aspect: delivery | packaging | quality | taste | size_fit | design | price | usability
  · delivery 배송(빠름/늦음/누락)  · packaging 포장(파손/과대/부실)
  · quality 품질(효과/내구성/하자) · taste 맛·향(맛/냄새/향)
  · size_fit 사이즈·핏(크기/용량/핏) · design 디자인(외관/색)
  · price 가격(가성비/비쌈)        · usability 사용감(편의/조작/흡수)
- sentiment: pos(긍정) | neg(부정) | neu(중립)
- snippet: 근거가 된 리뷰 문구 발췌 (한국어, 40자 이내)
- confidence: 0~1 (명확하면 0.9, 애매하면 0.5)

예시 출력: [{"aspect":"packaging","sentiment":"neg","snippet":"박스가 찌그러져서 왔어요","confidence":0.9}]`

function buildUserPrompt(title, reviews) {
  const lines = reviews.map((r, i) => `${i + 1}. ${r}`)
  return `상품명: ${title}\n리뷰(${reviews.length}건):\n${lines.join('\n')}`
}

function tryParseJsonArray(text) {
  if (!text) return null
  try {
    const v = JSON.parse(text)
    if (Array.isArray(v)) return v
  } catch {}
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) {
    try {
      const v = JSON.parse(fence[1])
      if (Array.isArray(v)) return v
    } catch {}
  }
  const m = text.match(/\[[\s\S]*\]/)
  if (m) {
    try {
      const v = JSON.parse(m[0])
      if (Array.isArray(v)) return v
    } catch {}
  }
  return null
}

function normalizeAspect(o) {
  if (!o || typeof o !== 'object') return null
  const aspect = String(o.aspect ?? '').trim()
  const sentiment = String(o.sentiment ?? '').trim()
  if (!ASPECTS.includes(aspect)) return null
  if (!SENTIMENTS.includes(sentiment)) return null
  let conf = Number(o.confidence)
  if (!Number.isFinite(conf)) conf = 0.7
  conf = Math.min(1, Math.max(0, conf))
  return {
    aspect,
    sentiment,
    snippet: typeof o.snippet === 'string' ? o.snippet.trim().slice(0, 120) : null,
    confidence: conf,
  }
}

// ggsan cate_label → category_top (health | living | digital | other)
function mapCategoryTop(label) {
  const s = String(label ?? '')
  if (/건강|영양|유산균|관절|혈행|면역|간|눈|장|수면|다이어트|홍삼/.test(s)) return 'health'
  if (/주방|생활|청소|뷰티|패션|위생|세탁|욕실|반려|차량/.test(s)) return 'living'
  if (/디지털|가전|전자|조명|충전|케이블/.test(s)) return 'digital'
  return 'health' // ggsan 도매몰 기본값(대부분 건강식품)
}

function extractReviews(rawPayload) {
  if (!rawPayload || typeof rawPayload !== 'object') return []
  let arr = []
  if (Array.isArray(rawPayload.reviews)) {
    arr = rawPayload.reviews
  } else if (typeof rawPayload.review_blob === 'string') {
    arr = rawPayload.review_blob.split(/\n+/)
  }
  return arr
    .map((r) => (typeof r === 'string' ? r : r?.content ?? r?.text ?? ''))
    .map((s) => String(s).trim())
    .filter((s) => s.length >= 4)
    .slice(0, REVIEWS_PER_SKU)
}

function callClaudeCli(prompt) {
  // ANTHROPIC_API_KEY 류 제거 → claude.ai 구독으로 인증 (classify 와 동일 규칙).
  const childEnv = { ...process.env }
  delete childEnv.ANTHROPIC_API_KEY
  delete childEnv.ANTHROPIC_AUTH_TOKEN
  delete childEnv.ANTHROPIC_BASE_URL

  return new Promise((resolve, reject) => {
    const child = spawn('claude', ['-p', '--output-format', 'json', '--model', HAIKU_MODEL], {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
      env: childEnv,
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => {
      stdout += d.toString()
    })
    child.stderr.on('data', (d) => {
      stderr += d.toString()
    })
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
        costUsd: parsed.total_cost_usd ?? 0,
      })
    })
    child.stdin.end(prompt, 'utf8')
  })
}

async function fetchCandidateSkus() {
  // 최근 본 ggsan 상품 중, 최근 추출 안 한 SKU 우선.
  const { data, error } = await sb
    .from('jimscanner_ggsan_products')
    .select('goods_no, title, cate_label, raw_payload, last_seen_at')
    .eq('status', 'active')
    .order('last_seen_at', { ascending: false })
    .limit(MAX_SKU_PER_RUN * 5)
  if (error) {
    console.error(`  fetchCandidateSkus error: ${error.message}`)
    return []
  }

  // 이미 최근 추출된 SKU 제외
  const ids = (data ?? []).map((r) => r.goods_no)
  const since = new Date(Date.now() - REASSESS_AFTER_DAYS * 86400_000).toISOString()
  const recent = new Set()
  if (ids.length) {
    const { data: done } = await sb
      .from('jimscanner_review_aspects')
      .select('sku_external_id')
      .in('sku_external_id', ids)
      .gte('captured_at', since)
    for (const r of done ?? []) recent.add(r.sku_external_id)
  }

  const out = []
  for (const r of data ?? []) {
    if (recent.has(r.goods_no)) continue
    const reviews = extractReviews(r.raw_payload)
    if (reviews.length === 0) continue
    out.push({
      sku_external_id: r.goods_no,
      title: r.title,
      category_top: mapCategoryTop(r.cate_label),
      reviews,
    })
    if (out.length >= MAX_SKU_PER_RUN) break
  }
  return out
}

async function logRun(payload) {
  try {
    await sb.from('jimscanner_trends_runs').insert({
      source: 'extract_review_aspects',
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
  console.log(`[${new Date().toISOString()}] extract-review-aspects start (model=${HAIKU_MODEL})`)

  const skus = await fetchCandidateSkus()
  if (skus.length === 0) {
    console.log('  done: 리뷰 보유 + 미추출 SKU 없음 (0 candidates)')
    await logRun({ status: 'ok', fetched_count: 0, inserted_count: 0, duration_ms: Date.now() - t0 })
    return
  }
  console.log(`  candidates: ${skus.length}`)

  const now = new Date().toISOString()
  const rows = []
  let reqCount = 0
  let totalCostUsd = 0
  let lastError = null

  for (const sku of skus) {
    const prompt = `${SYSTEM_PROMPT}\n\n---\n\n${buildUserPrompt(sku.title, sku.reviews)}`
    try {
      const out = await callClaudeCli(prompt)
      reqCount++
      totalCostUsd += out.costUsd
      const arr = tryParseJsonArray(out.text) ?? []
      let kept = 0
      for (const item of arr) {
        const n = normalizeAspect(item)
        if (!n) continue
        rows.push({
          sku_external_id: sku.sku_external_id,
          source: 'ggsan',
          product_title: sku.title?.slice(0, 200) ?? null,
          category_top: sku.category_top,
          aspect: n.aspect,
          sentiment: n.sentiment,
          snippet: n.snippet,
          confidence: n.confidence,
          captured_at: now,
        })
        kept++
      }
      console.log(`  sku ${sku.sku_external_id}: ${sku.reviews.length} reviews → ${kept} aspects ($${out.costUsd.toFixed(4)})`)
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e)
      console.error(`  sku ${sku.sku_external_id} failed: ${lastError}`)
      break
    }
  }

  if (rows.length > 0) {
    // 500건씩 청크 삽입
    for (let i = 0; i < rows.length; i += 500) {
      const chunk = rows.slice(i, i + 500)
      const { error } = await sb.from('jimscanner_review_aspects').insert(chunk)
      if (error) {
        lastError = error.message
        console.error(`  insert error: ${error.message}`)
        break
      }
    }
  }

  await logRun({
    status: lastError ? 'partial' : 'ok',
    fetched_count: skus.length,
    inserted_count: rows.length,
    duration_ms: Date.now() - t0,
    error_message: lastError,
  })

  console.log(
    `[${new Date().toISOString()}] done — ${reqCount} req, ${rows.length} aspect rows inserted, $${totalCostUsd.toFixed(4)} in ${Date.now() - t0}ms`,
  )
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
