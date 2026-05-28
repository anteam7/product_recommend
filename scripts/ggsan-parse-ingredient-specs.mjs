/**
 * ggsan 카탈로그 → 기능성 원료 함량 스펙 파서 (룰 1차분)
 *
 * jimscanner_ggsan_products 의 title + raw_payload 에서
 *   - 기능성 원료명 (루테인·밀크씨슬·MSM·프로바이오틱스·콜라겐·멜라토닌 …)
 *   - 1회 함량 (mg)
 *   - 입수량 (정/포/캡슐)
 * 을 룰로 추출해 jimscanner_ggsan_ingredient_specs 에 UPSERT.
 *
 * LLM 보강(복합제·억CFU·IU)은 후속. confidence < 0.6 행은 수동 검수 대상.
 *
 * 실행: node scripts/ggsan-parse-ingredient-specs.mjs [--dry] [--limit=N]
 */
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

const args = process.argv.slice(2)
const dry = args.includes('--dry')
const limit = parseInt(args.find((a) => a.startsWith('--limit='))?.split('=')[1] ?? '5000')

// 원료명 사전: 정규명 → 매칭 정규식 (title/본문에서 탐지)
const INGREDIENTS = [
  { name: '루테인', re: /루테인|lutein/i },
  { name: '밀크씨슬', re: /밀크\s*씨슬|실리마린|milk\s*thistle/i },
  { name: 'MSM', re: /\bMSM\b|엠에스엠|식이\s*유황/i },
  { name: '프로바이오틱스', re: /프로바이오틱스|유산균|probiotics|락토바실러스/i },
  { name: '콜라겐', re: /콜라겐|collagen/i },
  { name: '멜라토닌', re: /멜라토닌|melatonin/i },
  { name: '오메가3', re: /오메가\s*3|omega\s*3|rTG|EPA|DHA/i },
  { name: '비타민D', re: /비타민\s*D|vitamin\s*d/i },
  { name: '마그네슘', re: /마그네슘|magnesium/i },
  { name: '아연', re: /아연|zinc/i },
  { name: '코엔자임Q10', re: /코엔자임\s*Q\s*10|coq10|코큐텐/i },
  { name: '글루코사민', re: /글루코사민|glucosamine/i },
  { name: '비타민C', re: /비타민\s*C|vitamin\s*c|아스코르브/i },
]

// 텍스트에서 'mg' 함량 추출 (가장 큰 mg 값 = 주성분 함량으로 추정)
function extractMg(text) {
  const matches = [...text.matchAll(/(\d{1,5}(?:[.,]\d+)?)\s*mg\b/gi)]
    .map((m) => parseFloat(m[1].replace(',', '')))
    .filter((n) => Number.isFinite(n) && n > 0 && n < 100000)
  if (matches.length === 0) return null
  return Math.max(...matches)
}

// 입수량 (정/포/캡슐/개입) 추출
function extractServings(text) {
  const m = text.match(/(\d{1,4})\s*(정|포|캡슐|개입|환|구미)/)
  return m ? parseInt(m[1], 10) : null
}

// 1일 섭취 횟수
function extractServingsPerDay(text) {
  const m = text.match(/1\s*일\s*(\d)\s*(?:회|정|포|캡슐)/)
  return m ? parseInt(m[1], 10) : 1
}

async function main() {
  const { data: products, error } = await sb
    .from('jimscanner_ggsan_products')
    .select('goods_no, title, raw_payload')
    .neq('status', 'removed')
    .limit(limit)
  if (error) {
    console.error('❌ products 조회 실패:', error.message)
    process.exit(1)
  }
  console.log(`✓ ${products.length}개 제품 파싱 시작 (dry=${dry})\n`)

  const upserts = []
  let matchedProducts = 0
  for (const p of products) {
    const title = p.title ?? ''
    // raw_payload 의 설명/고시 텍스트 합치기
    const rp = p.raw_payload ?? {}
    const extraText = [
      rp.description, rp.detail, rp.gi_content, rp.option_text,
      JSON.stringify(rp.package_info ?? ''),
    ]
      .filter(Boolean)
      .join(' ')
    const haystack = `${title} ${extraText}`

    const servings = extractServings(haystack)
    const servingsPerDay = extractServingsPerDay(haystack)
    const daysSupply = servings != null ? servings / (servingsPerDay || 1) : null

    let matchedAny = false
    for (const ing of INGREDIENTS) {
      if (!ing.re.test(haystack)) continue
      matchedAny = true
      // 원료명 토큰 주변 ±40자에서 mg 우선, 없으면 전체에서
      const idx = haystack.search(ing.re)
      const window = haystack.slice(Math.max(0, idx - 20), idx + 60)
      const mg = extractMg(window) ?? extractMg(haystack)

      // confidence: mg+servings 둘 다 있으면 0.8, mg만 0.6, 원료명만 0.3
      let confidence = 0.3
      if (mg != null && servings != null) confidence = 0.8
      else if (mg != null) confidence = 0.6

      upserts.push({
        goods_no: p.goods_no,
        ingredient: ing.name,
        ingredient_raw: window.match(ing.re)?.[0] ?? ing.name,
        mg_per_serving: mg,
        servings,
        servings_per_day: servingsPerDay,
        days_supply: daysSupply,
        unit: 'mg',
        parse_method: 'rule',
        parse_confidence: confidence,
        raw_evidence: window.slice(0, 200),
      })
    }
    if (matchedAny) matchedProducts++
  }

  console.log(`원료 매칭: ${matchedProducts}/${products.length} 제품, 스펙행 ${upserts.length}건`)
  const byIng = {}
  for (const u of upserts) byIng[u.ingredient] = (byIng[u.ingredient] ?? 0) + 1
  console.log('원료별:', JSON.stringify(byIng))

  if (dry) {
    console.log('\n[--dry] DB 미반영. 샘플 5건:')
    console.log(JSON.stringify(upserts.slice(0, 5), null, 2))
    return
  }

  // UNIQUE(goods_no, ingredient) 기준 UPSERT
  let ok = 0
  for (let i = 0; i < upserts.length; i += 500) {
    const batch = upserts.slice(i, i + 500)
    const { error: upErr } = await sb
      .from('jimscanner_ggsan_ingredient_specs')
      .upsert(batch, { onConflict: 'goods_no,ingredient' })
    if (upErr) {
      console.error(`❌ batch ${i} upsert 실패:`, upErr.message)
    } else {
      ok += batch.length
    }
  }
  console.log(`\n✓ UPSERT 완료: ${ok}/${upserts.length}건`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
