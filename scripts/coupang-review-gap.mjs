/**
 * 경쟁 리스팅 리뷰 불만 갭 — 차별화 변형 소싱 발굴
 *
 *   후보 키워드의 쿠팡 SERP 상위 리스팅 → 별점 낮은 리뷰 수집 →
 *   반복 불만을 LLM 으로 추출·군집(size/durability/smell/noise/leak/packaging…) →
 *   jimscanner_trends_review_gaps 적재 → 어드민 /admin/trend-radar/review-gaps 노출.
 *
 * 위탁 1인셀러의 차별화 레버 = '시장 1위가 못 고친 불만을 해결한 변형 소싱'.
 *
 * 사용:
 *   node scripts/coupang-review-gap.mjs --kw="무선청소기,저소음 가습기"
 *   node scripts/coupang-review-gap.mjs --kw="무선청소기" --top=3 --maxReviews=40 --dry
 *
 * 옵션:
 *   --kw=...       쉼표구분 검색어 (필수)
 *   --top=N        SERP 상위 N개 리스팅 리뷰 수집 (기본 3)
 *   --maxReviews=N 키워드당 수집할 저별점 리뷰 상한 (기본 40)
 *   --dry          DB 적재 없이 콘솔 출력만
 *
 * 검색 흐름은 scripts/coupang-debug-search.mjs 의 stealth playwright 흐름을 재사용.
 * LLM 은 본업과 동일하게 ANTHROPIC_API_KEY (Claude Haiku) 사용. 키 없으면 룰기반 fallback.
 */
import { chromium } from 'playwright'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { createClient } from '@supabase/supabase-js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const env = Object.fromEntries(
  readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8')
    .split(/\r?\n/)
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => {
      const i = l.indexOf('=')
      let v = l.slice(i + 1).trim()
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
      return [l.slice(0, i).trim(), v]
    }),
)
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY)

const arg = (k, d = null) => {
  const a = process.argv.find((x) => x.startsWith(`--${k}=`))
  return a ? a.split('=').slice(1).join('=') : d
}
const flag = (k) => process.argv.includes(`--${k}`)

const KEYWORDS = (arg('kw') || '').split(',').map((s) => s.trim()).filter(Boolean)
const TOP = parseInt(arg('top', '3'), 10)
const MAX_REVIEWS = parseInt(arg('maxReviews', '40'), 10)
const DRY = flag('dry')

if (KEYWORDS.length === 0) {
  console.error('검색어 필요: --kw="무선청소기,저소음 가습기"')
  process.exit(1)
}

// ── 불만 태그 정규화 사전 (룰기반 fallback + LLM 결과 정규화 공통) ──────────
const TAG_RULES = [
  { tag: 'size', label: '크기/용량 부족', sourcePrefix: '대용량', re: /(작|크기|사이즈|용량|양\s*이?\s*적|금방\s*떨어|얼마\s*안)/, },
  { tag: 'durability', label: '내구성/고장', sourcePrefix: '튼튼한', re: /(고장|부서|망가|약하|금방\s*죽|얼마\s*못|내구|부실|깨[지졌])/, },
  { tag: 'smell', label: '냄새', sourcePrefix: '무취', re: /(냄새|악취|쾌쾌|꿉꿉|향이\s*역|플라스틱\s*냄)/, },
  { tag: 'noise', label: '소음', sourcePrefix: '저소음', re: /(시끄|소음|소리\s*가?\s*크|굉음|울리|진동\s*심)/, },
  { tag: 'leak', label: '누수/샘', sourcePrefix: '누수방지', re: /(샌다|새는|누수|물이\s*[새세]|줄줄|흘러)/, },
  { tag: 'packaging', label: '포장/배송파손', sourcePrefix: '안전포장', re: /(포장|파손|찌그|터[져졌]|박살|깨져\s*[옴왔]|배송\s*중\s*파)/, },
  { tag: 'battery', label: '배터리/지속시간', sourcePrefix: '대용량배터리', re: /(배터리|충전\s*금방|오래\s*못|방전|지속\s*시간\s*짧)/, },
  { tag: 'weak_power', label: '흡입력/성능 약함', sourcePrefix: '강력', re: /(흡입력|힘이\s*약|파워|약하|성능\s*별로|잘\s*안\s*[빨돼])/, },
  { tag: 'hard_to_clean', label: '세척/관리 불편', sourcePrefix: '간편세척', re: /(세척\s*불편|청소\s*어렵|관리\s*힘|분리\s*안|닦기\s*힘)/, },
]

function ruleCluster(reviews) {
  const buckets = new Map()
  for (const r of reviews) {
    for (const rule of TAG_RULES) {
      if (rule.re.test(r.text)) {
        let b = buckets.get(rule.tag)
        if (!b) { b = { tag: rule.tag, label: rule.label, sourcePrefix: rule.sourcePrefix, count: 0, quotes: [] }; buckets.set(rule.tag, b) }
        b.count++
        if (b.quotes.length < 3) b.quotes.push(r.text.slice(0, 120))
      }
    }
  }
  return [...buckets.values()]
}

// ── LLM 군집 (Claude Haiku). 실패/키없음 시 null → 룰기반 사용 ──────────────
async function llmCluster(keyword, reviews) {
  const apiKey = env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY
  if (!apiKey || reviews.length === 0) return null
  const joined = reviews.map((r, i) => `[${i + 1}] (★${r.rating}) ${r.text.slice(0, 200)}`).join('\n')
  const allowedTags = TAG_RULES.map((t) => t.tag).join(', ')
  const prompt = `다음은 쿠팡 "${keyword}" 상위 리스팅의 저별점 리뷰다. 반복되는 불만을 군집해라.
허용 태그: ${allowedTags} (해당 없으면 'other').
각 군집마다: tag, label(한국어 한 줄), severity(1~5, 반품유발=5), evidence_count, sample_quotes(최대3, 원문 인용).
JSON 만 출력: {"clusters":[{"tag","label","severity","evidence_count","sample_quotes":[]}]}

리뷰:
${joined}`
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1500,
        messages: [{ role: 'user', content: prompt }],
      }),
    })
    if (!res.ok) { console.warn('  LLM 호출 실패', res.status); return null }
    const j = await res.json()
    const txt = j.content?.[0]?.text || ''
    const m = txt.match(/\{[\s\S]*\}/)
    if (!m) return null
    const parsed = JSON.parse(m[0])
    return Array.isArray(parsed.clusters) ? parsed.clusters : null
  } catch (e) {
    console.warn('  LLM 파싱 실패:', e.message)
    return null
  }
}

function tagMeta(tag) {
  const rule = TAG_RULES.find((t) => t.tag === tag)
  return {
    label: rule?.label || tag,
    sourcePrefix: rule?.sourcePrefix || '',
  }
}

// ── 쿠팡 SERP → 상위 리스팅 → 저별점 리뷰 수집 ────────────────────────────
async function collectReviews(ctx, keyword) {
  const page = await ctx.newPage()
  const url = 'https://www.coupang.com/np/search?q=' + encodeURIComponent(keyword)
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })
  await page.waitForTimeout(2500)

  const productLinks = await page.evaluate((top) => {
    const seen = new Set()
    const out = []
    for (const a of document.querySelectorAll('a[href*="/vp/products/"]')) {
      const href = a.href.split('?')[0]
      if (seen.has(href)) continue
      seen.add(href)
      const name = (a.querySelector('[class*="name"]')?.textContent || a.textContent || '').trim().slice(0, 120)
      out.push({ href: a.href, name })
      if (out.length >= top) break
    }
    return out
  }, TOP)

  const reviews = []
  let repName = productLinks[0]?.name || keyword
  for (const pl of productLinks) {
    if (reviews.length >= MAX_REVIEWS) break
    try {
      const pp = await ctx.newPage()
      await pp.goto(pl.href, { waitUntil: 'domcontentloaded', timeout: 30000 })
      await pp.waitForTimeout(2500)
      // 리뷰 영역 스크롤 유도
      await pp.evaluate(() => window.scrollTo(0, document.body.scrollHeight * 0.6))
      await pp.waitForTimeout(1500)
      const got = await pp.evaluate(() => {
        const out = []
        // 쿠팡 리뷰 article — 별점 4 이하만 (sd-rating-star 등은 변동성 큼 → 텍스트 위주)
        const articles = document.querySelectorAll('article[class*="review"], div[class*="sdp-review"], article.sdp-review__article__list')
        for (const el of articles) {
          const text = (el.querySelector('[class*="review-content"], [class*="reviewContent"], [class*="content"]')?.textContent || '').trim()
          if (!text || text.length < 8) continue
          // 별점 추출 시도 (data-rating 또는 width style)
          let rating = 0
          const star = el.querySelector('[data-rating]')
          if (star) rating = parseInt(star.getAttribute('data-rating') || '0', 10)
          out.push({ text: text.slice(0, 300), rating })
        }
        return out
      })
      // 저별점 우선 (rating 0=미상은 포함, 4~5 제외)
      for (const g of got) {
        if (g.rating >= 4) continue
        reviews.push(g)
        if (reviews.length >= MAX_REVIEWS) break
      }
      await pp.close()
    } catch (e) {
      console.warn(`  리뷰 수집 실패 (${pl.href.slice(0, 60)}):`, e.message)
    }
  }
  await page.close()
  return { reviews, repName }
}

// ── 메인 ──────────────────────────────────────────────────────────────────
const browser = await chromium.launch({ headless: true, args: ['--disable-blink-features=AutomationControlled'] })
const ctx = await browser.newContext({
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  locale: 'ko-KR',
  viewport: { width: 1366, height: 768 },
})
await ctx.addInitScript(() => {
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined })
})

const rowsToUpsert = []
for (const keyword of KEYWORDS) {
  console.log(`\n=== "${keyword}" SERP 리뷰 수집 ===`)
  const { reviews, repName } = await collectReviews(ctx, keyword)
  console.log(`  저별점 리뷰 ${reviews.length}건 (대표: ${repName})`)
  if (reviews.length === 0) { console.log('  → 수집 0, skip'); continue }

  let clusters = await llmCluster(keyword, reviews)
  let via = 'llm_haiku'
  if (!clusters) {
    via = 'rule'
    clusters = ruleCluster(reviews).map((b) => ({
      tag: b.tag,
      label: b.label,
      severity: Math.min(5, Math.max(1, Math.round(b.count / Math.max(1, reviews.length) * 5) + 1)),
      evidence_count: b.count,
      sample_quotes: b.quotes,
    }))
  }
  // freq = evidence_count / 전체 부정리뷰
  const denom = Math.max(1, reviews.length)
  for (const c of clusters) {
    if (!c.tag) continue
    const meta = tagMeta(c.tag)
    const ev = Number(c.evidence_count) || 0
    const sev = Math.min(5, Math.max(1, parseInt(c.severity, 10) || 1))
    const prefix = meta.sourcePrefix
    rowsToUpsert.push({
      search_keyword: keyword,
      source_product_name: repName,
      complaint_tag: c.tag,
      complaint_label: c.label || meta.label,
      freq: Math.min(1, ev / denom),
      severity: sev,
      evidence_count: ev,
      sample_quotes: (c.sample_quotes || []).slice(0, 3),
      sourcing_query: prefix ? `${prefix} ${keyword}` : keyword,
    })
  }
  const top3 = [...clusters].sort((a, b) => (b.severity * (b.evidence_count || 1)) - (a.severity * (a.evidence_count || 1))).slice(0, 3)
  console.log(`  [${via}] 불만 Top3:`)
  for (const t of top3) console.log(`    · ${t.label} (sev ${t.severity}, ${t.evidence_count}건) → 소싱: ${tagMeta(t.tag).sourcePrefix} ${keyword}`)
}

await browser.close()

if (rowsToUpsert.length === 0) {
  console.log('\n적재할 불만 군집 없음.')
  process.exit(0)
}

if (DRY) {
  console.log(`\n[DRY] 적재 예정 ${rowsToUpsert.length}건:`)
  console.log(JSON.stringify(rowsToUpsert, null, 2))
  process.exit(0)
}

const { error } = await sb
  .from('jimscanner_trends_review_gaps')
  .upsert(rowsToUpsert, { onConflict: 'search_keyword,complaint_tag' })
if (error) {
  console.error('적재 실패:', error.message)
  process.exit(1)
}
console.log(`\n✅ jimscanner_trends_review_gaps 적재 ${rowsToUpsert.length}건`)
