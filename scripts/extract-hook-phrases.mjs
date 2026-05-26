/**
 * 카테고리 후킹카피 자동 추출 (Hook Mining)
 *
 * jimscanner_market_raw 의 quasarzone_sale / naver_news / naver_blog 텍스트에서
 * 카테고리별 반복 등장 클릭유도 어구를 n-gram 으로 추출하여
 * jimscanner_hook_phrases 에 upsert.
 *
 * 6시간 cron 으로 실행 권장 (Vercel Hobby 한도 시 scripts/run-crons.mjs 우회).
 *
 * 사용:
 *   node scripts/extract-hook-phrases.mjs
 *   node scripts/extract-hook-phrases.mjs --days 14
 *   node scripts/extract-hook-phrases.mjs --min-support 3
 *
 * 의존성 없음 (외부 임베딩 모델 미사용 — n-gram 빈도 기반).
 * KR-BERT 클러스터링은 v2 에서 추가 — 우선 빈도만으로 후킹어구 추출.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { createClient } from '@supabase/supabase-js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

function loadEnv() {
  const out = {}
  try {
    const txt = readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8')
    for (const l of txt.split(/\r?\n/)) {
      if (!l || l.startsWith('#') || !l.includes('=')) continue
      const i = l.indexOf('=')
      let v = l.slice(i + 1).trim()
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
      out[l.slice(0, i).trim()] = v
    }
  } catch {}
  return { ...process.env, ...out }
}
const env = loadEnv()
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY)

const args = process.argv.slice(2)
function argVal(name, def) {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] ? args[i + 1] : def
}
const DAYS = parseInt(argVal('--days', '14'), 10)
const MIN_SUPPORT = parseInt(argVal('--min-support', '2'), 10)
const TOP_PER_CATEGORY = parseInt(argVal('--top', '40'), 10)

// 후킹어구 후보 사전 (한국어 e-commerce CTR 부스트 표현)
// 정규식이 아니라 substring 매칭 — 단순/빠름. 새 어구는 여기 추가만 하면 됨.
const HOOK_LEXICON = [
  '역대급', '미친가격', '미친 가격', '미친 할인', '미친혜택', '단독특가', '단독 특가',
  '품절임박', '품절 임박', '재고 마지막', '마감임박', '마감 임박', '오늘만', '한정수량',
  '한정 수량', '한정판매', '가성비', '가성비 미쳤', '특가', '핫딜', '핫 딜', '초특가',
  '최저가', '최저 가격', '폭탄세일', '폭탄 세일', '대박', '필수템', '강추', '추천템',
  '인생템', '베스트', '신상', '신제품', '리뉴얼', '독점', '단 하루', '단하루',
  '오늘의 특가', '특별가', '리미티드', '한정', '국내최저', '국내 최저', '무료배송',
  '사은품', '1+1', '2+1', '50% 할인', '70% 할인', '반값', '반 값', '클리어런스',
  '재입고', '재 입고', '마지막 기회', '오픈런', '신기록', '품질보장', '품질 보장',
  '정품보장', '정품 보장', '입소문', '대란', '득템', '명품급',
]

// 어구 ↔ 카테고리 매핑이 필요 없음 — 모든 어구를 모든 카테고리 후보에 대해 빈도 계산.

// market_raw 소스 → 카테고리 매핑 정책.
// quasarzone_sale 은 metadata.category / metadata.tags 가 PC/디지털 위주 → 'digital' default.
// naver_news / naver_blog 은 metadata.category (있으면) 사용, 없으면 'all'.
function categorize(row) {
  const meta = row.metadata || {}
  const cat = (meta.category || meta.category_top || '').toLowerCase()
  if (cat) {
    if (cat.includes('health') || cat.includes('건강') || cat.includes('식품') || cat.includes('영양')) return 'health'
    if (cat.includes('living') || cat.includes('생활') || cat.includes('리빙') || cat.includes('주방') || cat.includes('가구')) return 'living'
    if (cat.includes('digital') || cat.includes('가전') || cat.includes('pc') || cat.includes('전자') || cat.includes('모바일')) return 'digital'
  }
  // 소스 휴리스틱
  if (row.source === 'quasarzone_sale') return 'digital'
  // title 휴리스틱
  const t = (row.title || '').toLowerCase()
  if (/(영양제|비타민|콜라겐|프로바이오틱스|오메가|루테인|멜라토닌|효소|건강식품)/i.test(t)) return 'health'
  if (/(주방|수건|침구|화장지|식기|청소|세제|생활|리빙)/i.test(t)) return 'living'
  if (/(노트북|tv|모니터|냉장고|에어컨|폰|스마트워치|이어폰|마우스|키보드|ssd|gpu|cpu)/i.test(t)) return 'digital'
  return 'all'
}

function extractDiscount(row) {
  const meta = row.metadata || {}
  const cand =
    meta.discount_pct ?? meta.discountPct ?? meta.discount ?? meta.sale_rate ?? meta.saleRate
  if (cand == null) return null
  const n = typeof cand === 'string' ? parseFloat(cand.replace(/[^\d.\-]/g, '')) : Number(cand)
  if (!Number.isFinite(n)) return null
  return n > 0 && n <= 100 ? n : null
}

async function main() {
  const since = new Date(Date.now() - DAYS * 86400_000).toISOString()
  console.log(`[hook-mining] since=${since} sources=quasarzone_sale,naver_news,naver_blog`)

  const { data: rows, error } = await sb
    .from('jimscanner_market_raw')
    .select('id, source, title, metadata, source_url, captured_at')
    .in('source', ['quasarzone_sale', 'naver_news', 'naver_blog'])
    .gte('captured_at', since)
    .limit(20000)

  if (error) {
    console.error('[hook-mining] fetch error:', error.message)
    process.exit(1)
  }

  console.log(`[hook-mining] raw rows = ${rows?.length ?? 0}`)

  // {category}::{phrase} → aggregator
  const agg = new Map()

  for (const r of rows || []) {
    const text = `${r.title || ''} ${(r.metadata?.description || r.metadata?.summary || '')}`
    if (!text.trim()) continue
    const cat = categorize(r)
    const discount = extractDiscount(r)

    for (const phrase of HOOK_LEXICON) {
      // 공백 normalize 매칭 — '미친 가격' / '미친가격' 양쪽 잡음
      const haystack = text.replace(/\s+/g, '')
      const needle = phrase.replace(/\s+/g, '')
      if (!haystack.includes(needle)) continue

      // 카테고리별 + all 두 번 집계 (UI 의 'all' 탭이 비지 않게)
      for (const catKey of [cat, 'all']) {
        const k = `${catKey}::${phrase}`
        let v = agg.get(k)
        if (!v) {
          v = { category: catKey, phrase, support: 0, discount_sum: 0, discount_n: 0, examples: [], last_seen: r.captured_at, first_seen: r.captured_at }
          agg.set(k, v)
        }
        v.support++
        if (discount != null) {
          v.discount_sum += discount
          v.discount_n++
        }
        if (v.examples.length < 5) {
          v.examples.push({
            title: r.title?.slice(0, 200),
            source: r.source,
            source_url: r.source_url,
            captured_at: r.captured_at,
            discount_pct: discount,
          })
        }
        if (r.captured_at > v.last_seen) v.last_seen = r.captured_at
        if (r.captured_at < v.first_seen) v.first_seen = r.captured_at
      }
    }
  }

  // 카테고리별 상위 N 만 keep
  const byCat = new Map()
  for (const v of agg.values()) {
    if (v.support < MIN_SUPPORT) continue
    let list = byCat.get(v.category)
    if (!list) { list = []; byCat.set(v.category, list) }
    list.push(v)
  }

  const rowsToUpsert = []
  for (const [cat, list] of byCat) {
    list.sort((a, b) => b.support - a.support)
    for (const v of list.slice(0, TOP_PER_CATEGORY)) {
      rowsToUpsert.push({
        category: cat,
        phrase: v.phrase,
        support: v.support,
        avg_discount: v.discount_n > 0 ? Number((v.discount_sum / v.discount_n).toFixed(2)) : null,
        top_examples: v.examples,
        last_seen: v.last_seen,
        first_seen: v.first_seen,
      })
    }
  }

  console.log(`[hook-mining] upserting ${rowsToUpsert.length} rows`)
  if (rowsToUpsert.length === 0) {
    console.log('[hook-mining] nothing to upsert — exiting')
    return
  }

  // upsert (category, phrase) on conflict
  const { error: upErr } = await sb
    .from('jimscanner_hook_phrases')
    .upsert(rowsToUpsert, { onConflict: 'category,phrase' })

  if (upErr) {
    console.error('[hook-mining] upsert error:', upErr.message)
    process.exit(1)
  }

  console.log('[hook-mining] done')
  // 상위 10개 미리보기
  rowsToUpsert
    .filter((r) => r.category === 'all')
    .slice(0, 10)
    .forEach((r) => {
      console.log(`  [all] ${r.phrase.padEnd(14)} support=${r.support}  avg_discount=${r.avg_discount ?? '—'}`)
    })
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
