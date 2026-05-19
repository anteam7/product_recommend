#!/usr/bin/env node
/**
 * 패키지 시각속성 자동추출 — 일 50건 배치 (로컬 cron 전용).
 *
 * jimscanner_ggsan_products.image_url + jimscanner_trends_products
 * 의 대표 sample image (aliases 의 첫 image 가 비어있으면 ggsan 매칭으로 fallback)
 * 에 대해 Vision LLM 으로 6속성을 라벨링 → jimscanner_trends_vision_attrs upsert.
 *
 * 호출:
 *   node --env-file=.env.local scripts/extract-vision-attrs.mjs
 *
 * 환경:
 *   - NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (env)
 *   - OPENAI_API_KEY (옵션) or GEMINI_API_KEY (옵션). 둘 다 없으면 dry-run.
 *
 * 노트:
 *   - 일 50건 배치(MAX_PER_RUN). 같은 goods_no/product_id 는 30일 안에 재실행 안 함.
 *   - VAS_DRY_RUN=1 환경변수로 mock 라벨만 채워서 schema 검증 가능.
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

const MAX_PER_RUN = Number(process.env.VAS_MAX_PER_RUN ?? 50)
const REFRESH_AFTER_DAYS = 30
const DRY_RUN =
  process.env.VAS_DRY_RUN === '1' ||
  (!process.env.OPENAI_API_KEY && !process.env.GEMINI_API_KEY)

const SYSTEM_PROMPT = `한국 위탁 판매 상품 이미지 분류기. 패키지 사진을 보고 6속성을 JSON 한 줄로만 응답.

❗ 절대 규칙:
- 응답 첫 글자 '{', 마지막 글자 '}'
- 설명/코드펜스/markdown 금지

스키마:
{
  "primary_color": "beige|pastel|vivid|mono|other",   // 주조색
  "package_form":  "pouch|bottle|box|zipper|stick|other",
  "design_style":  "minimal|retro|natural|kpop|other",
  "model_in_scene": true|false,   // 모델/사용씬 등장 여부
  "has_korean":    true|false,    // 패키지에 한글 표기
  "size_label":    true|false     // 사이즈/용량/수량 명시
}`

function mockLabel(imageUrl) {
  // 결정적 mock — URL 해시 기반
  let h = 0
  for (let i = 0; i < imageUrl.length; i++) h = (h * 31 + imageUrl.charCodeAt(i)) | 0
  const pick = (arr) => arr[Math.abs(h++) % arr.length]
  return {
    primary_color: pick(['beige', 'pastel', 'vivid', 'mono', 'other']),
    package_form: pick(['pouch', 'bottle', 'box', 'zipper', 'stick', 'other']),
    design_style: pick(['minimal', 'retro', 'natural', 'kpop', 'other']),
    model_in_scene: (h & 1) === 0,
    has_korean: (h & 2) === 0,
    size_label: (h & 4) === 0,
    _mock: true,
  }
}

async function classifyOpenAI(imageUrl) {
  const key = process.env.OPENAI_API_KEY
  if (!key) return null
  const body = {
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: [
          { type: 'text', text: '이 패키지 이미지를 분류해줘.' },
          { type: 'image_url', image_url: { url: imageUrl } },
        ],
      },
    ],
    response_format: { type: 'json_object' },
    max_tokens: 200,
    temperature: 0,
  }
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    console.warn(`[openai] HTTP ${res.status}`, (await res.text()).slice(0, 200))
    return null
  }
  const json = await res.json()
  const txt = json?.choices?.[0]?.message?.content
  if (!txt) return null
  try {
    return JSON.parse(txt)
  } catch {
    return null
  }
}

async function classify(imageUrl) {
  if (DRY_RUN) return { attrs: mockLabel(imageUrl), model: 'mock' }
  const r = await classifyOpenAI(imageUrl)
  if (r) return { attrs: r, model: 'gpt-4o-mini' }
  return null
}

async function fetchCandidates() {
  // 1) ggsan 카탈로그 active 상품 중, vision_attrs 없거나 30일 지난 것
  const cutoff = new Date(Date.now() - REFRESH_AFTER_DAYS * 86400_000).toISOString()
  const { data: ggsan } = await sb
    .from('jimscanner_ggsan_products')
    .select('goods_no, image_url, cate_label, last_seen_at')
    .eq('status', 'active')
    .not('image_url', 'is', null)
    .order('last_seen_at', { ascending: false })
    .limit(MAX_PER_RUN * 5)

  // 기존 라벨 매핑 (최근 30일)
  const goodsNos = (ggsan ?? []).map((g) => g.goods_no)
  let recent = new Set()
  if (goodsNos.length > 0) {
    const { data: existing } = await sb
      .from('jimscanner_trends_vision_attrs')
      .select('goods_no, classified_at')
      .in('goods_no', goodsNos)
      .gte('classified_at', cutoff)
    recent = new Set((existing ?? []).map((r) => r.goods_no))
  }

  const fresh = (ggsan ?? []).filter((g) => !recent.has(g.goods_no))

  // ggsan cate_label → category_top 매핑 (rough)
  function mapCategory(label) {
    if (!label) return 'other'
    if (/장|눈|간|관절|혈관|영양|건강|뼈|장건강|면역/.test(label)) return 'health'
    if (/가전|디지털|조명|전자|음향|배터리/.test(label)) return 'digital'
    if (/생활|주방|청소|뷰티|패션|차량|리빙|수납/.test(label)) return 'living'
    return 'other'
  }

  return fresh.slice(0, MAX_PER_RUN).map((g) => ({
    goods_no: g.goods_no,
    product_id: null,
    image_url: g.image_url,
    category_top: mapCategory(g.cate_label),
  }))
}

async function main() {
  console.log(`[vision-attrs] start · DRY_RUN=${DRY_RUN} · MAX_PER_RUN=${MAX_PER_RUN}`)
  const candidates = await fetchCandidates()
  console.log(`[vision-attrs] candidates=${candidates.length}`)
  if (candidates.length === 0) {
    console.log('[vision-attrs] nothing to classify — exit')
    return
  }

  let ok = 0
  let fail = 0
  for (const c of candidates) {
    try {
      const r = await classify(c.image_url)
      if (!r) {
        fail++
        continue
      }
      const { error } = await sb.from('jimscanner_trends_vision_attrs').insert({
        goods_no: c.goods_no,
        product_id: c.product_id,
        category_top: c.category_top,
        image_url: c.image_url,
        attrs: r.attrs,
        embed_version: 'v1',
        vision_model: r.model,
      })
      if (error) {
        console.warn(`[vision-attrs] insert fail goods=${c.goods_no}`, error.message)
        fail++
      } else {
        ok++
      }
    } catch (e) {
      console.warn(`[vision-attrs] error goods=${c.goods_no}`, e?.message ?? e)
      fail++
    }
  }
  console.log(`[vision-attrs] done · ok=${ok} fail=${fail}`)
}

main().catch((e) => {
  console.error('[vision-attrs] fatal', e)
  process.exit(1)
})
