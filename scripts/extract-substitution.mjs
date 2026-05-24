#!/usr/bin/env node
/**
 * 대체구매 마이그레이션 트래커 추출기.
 *
 * jimscanner_market_raw (naver_blog/news/google_suggest) 와
 * jimscanner_trends_products 의 제목·본문 텍스트에서 '대신·말고·보다·대안·vs·갈아탔'
 * 패턴을 정규식으로 매칭해 (source_term -> target_term, pattern, reason_tag) 트리플을 만들고
 * jimscanner_substitution_edges 에 upsert.
 *
 * cron: scripts/run-crons.mjs 에서 일일 1회 호출 권장 (LLM 의존성 없음 — 순수 regex).
 *
 * 호출:
 *   node --env-file=.env.local scripts/extract-substitution.mjs
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

const RAW_LIMIT = 5000
const RECENT_DAYS = 14

// 핵심 패턴: source -> pattern -> target 의 위치 구조
// 한국어는 어순이 'A 대신 B', 'A 말고 B', 'A 보다 B 가 낫다', 'A 대안으로 B', 'A 에서 B 로 갈아탔'
// 영어/abbrev: 'A vs B' (양방향 — 일단 양쪽 모두 누적, target = B 로 정함)
//
// term 후보: 한국어/영문/숫자 2~30자, 공백 허용 (조사·서술 제거 위해 앞뒤 trim)
const TERM_RE = `[\\p{L}\\p{N}][\\p{L}\\p{N} ·\\-+/.]{1,28}[\\p{L}\\p{N})]`

const PATTERNS = [
  { name: '대신', re: new RegExp(`(${TERM_RE})\\s*(?:은|는|이|가|을|를)?\\s*대신(?:에|해서)?\\s+(${TERM_RE})`, 'gu') },
  { name: '말고', re: new RegExp(`(${TERM_RE})\\s*(?:은|는|이|가|을|를)?\\s*말고\\s+(${TERM_RE})`, 'gu') },
  { name: '보다', re: new RegExp(`(${TERM_RE})\\s*보다\\s+(${TERM_RE})\\s*(?:이|가)?\\s*(?:낫|좋|효과|싸|저렴)`, 'gu') },
  { name: '대안', re: new RegExp(`(${TERM_RE})\\s*(?:의|에)?\\s*대안(?:으로|은|이)?\\s+(${TERM_RE})`, 'gu') },
  { name: 'vs', re: new RegExp(`(${TERM_RE})\\s*(?:vs|VS|Vs)\\s*(${TERM_RE})`, 'gu') },
  { name: '갈아탔', re: new RegExp(`(${TERM_RE})\\s*(?:에서|을|를)?\\s*(${TERM_RE})\\s*(?:으?로)?\\s*갈아(?:탔|타|탑니|탑시)`, 'gu') },
  { name: '바꿨', re: new RegExp(`(${TERM_RE})\\s*(?:에서|을|를)?\\s*(${TERM_RE})\\s*(?:으?로)?\\s*바꿨`, 'gu') },
]

// 이유 태그 사전 — 매칭된 패턴 주변 60자 내 키워드 등장 시 tag 부여
const REASON_LEXICON = [
  { tag: '가격', kw: ['싸', '저렴', '가성비', '할인', '세일', '가격', '비싸'] },
  { tag: '효과', kw: ['효과', '잘 듣', '잘듣', '확실', '체감'] },
  { tag: '부작용', kw: ['부작용', '속쓰', '메스꺼', '두통', '졸리', '거북'] },
  { tag: '구하기 쉬움', kw: ['구하기', '품절', '재고', '쉽게', '편의점', '직구', '국내'] },
  { tag: '품질', kw: ['품질', '퀄리티', '내구', '튼튼'] },
  { tag: '성분', kw: ['성분', '함량', '오리지', '천연', '식물성', '식약처'] },
  { tag: '맛/향', kw: ['맛', '향', '냄새', '먹기'] },
  { tag: '디자인', kw: ['디자인', '예쁘', '이쁘', '핏', '컬러'] },
]

// 의미 없는 토큰 차단 (stopwords-ish)
const STOPWORDS = new Set([
  '오늘', '내일', '어제', '요즘', '진짜', '그냥', '이거', '저거', '그거', '여기', '거기',
  '저기', '뭐', '왜', '어떻게', '근데', '하지만', '그리고', '그래서', '저', '제', '나',
  '너', '우리', '저희', '님', '분', '것', '거', '수', '때', '뜻', '말', '얘기',
  '글', '댓글', '리뷰', '후기', '추천', '비추',
])

function normalizeTerm(s) {
  if (!s) return ''
  let t = s.trim()
  // 양끝 조사/접두 제거
  t = t.replace(/^(저는|나는|난|전|제가|내가|이|그|저|이번|이번에|요즘|혹시|그냥)\s+/, '')
  t = t.replace(/\s+(은|는|이|가|을|를|에|에서|로|으로|의|와|과|랑|이랑|랑은|이라고|라고)$/, '')
  // 따옴표·괄호 제거
  t = t.replace(/^["'"'\[\(<]+|["'"'\]\)>]+$/g, '')
  t = t.trim()
  // 너무 짧거나 stopword 면 컷
  if (t.length < 2 || t.length > 30) return ''
  if (STOPWORDS.has(t)) return ''
  // 숫자만이면 컷
  if (/^\d+$/.test(t)) return ''
  // 일반적 동사/형용사 어미만이면 컷
  if (/^(좋|나쁘|싸|비싸|많|적|크|작)/.test(t) && t.length < 4) return ''
  return t.toLowerCase()
}

function inferReasonTags(snippet) {
  const tags = new Set()
  for (const { tag, kw } of REASON_LEXICON) {
    if (kw.some((k) => snippet.includes(k))) tags.add(tag)
  }
  return [...tags]
}

function extractEdges(text, sourceId) {
  if (!text || text.length < 5) return []
  const edges = []
  for (const { name, re } of PATTERNS) {
    re.lastIndex = 0
    let m
    while ((m = re.exec(text)) !== null) {
      const rawSrc = m[1]
      const rawTgt = m[2]
      const src = normalizeTerm(rawSrc)
      const tgt = normalizeTerm(rawTgt)
      if (!src || !tgt || src === tgt) continue
      const start = Math.max(0, m.index - 30)
      const end = Math.min(text.length, m.index + m[0].length + 30)
      const ctx = text.slice(start, end)
      edges.push({
        source_term: src,
        target_term: tgt,
        pattern: name,
        reason_tags: inferReasonTags(ctx),
        raw_id: sourceId,
        snippet: ctx.slice(0, 300),
      })
    }
  }
  return edges
}

async function fetchMarketRaw() {
  const cutoff = new Date(Date.now() - RECENT_DAYS * 86400000).toISOString()
  const { data, error } = await sb
    .from('jimscanner_market_raw')
    .select('id, source, title, metadata, captured_at')
    .in('source', ['naver_blog', 'naver_news', 'google_suggest', 'clien_park', 'quasarzone_sale'])
    .gte('captured_at', cutoff)
    .order('captured_at', { ascending: false })
    .limit(RAW_LIMIT)
  if (error) throw new Error(`fetch market_raw: ${error.message}`)
  return data ?? []
}

async function fetchTrendsProducts() {
  const { data, error } = await sb
    .from('jimscanner_trends_products')
    .select('id, canonical_name, description')
    .order('updated_at', { ascending: false })
    .limit(RAW_LIMIT)
  if (error) throw new Error(`fetch trends_products: ${error.message}`)
  return data ?? []
}

async function fetchProductNameMap() {
  // term -> product_id 매칭용 (canonical_name 소문자 정확매칭)
  const { data, error } = await sb
    .from('jimscanner_trends_products')
    .select('id, canonical_name')
    .limit(20000)
  if (error) return new Map()
  const m = new Map()
  for (const p of data ?? []) {
    if (p.canonical_name) m.set(p.canonical_name.trim().toLowerCase(), p.id)
  }
  return m
}

function aggregate(rawEdges) {
  const agg = new Map() // key: src||tgt||pattern
  for (const e of rawEdges) {
    const k = `${e.source_term}||${e.target_term}||${e.pattern}`
    let cur = agg.get(k)
    if (!cur) {
      cur = {
        source_term: e.source_term,
        target_term: e.target_term,
        pattern: e.pattern,
        count: 0,
        reason_tags: new Set(),
        raw_ids: new Set(),
        sample_snippets: [],
      }
      agg.set(k, cur)
    }
    cur.count++
    for (const t of e.reason_tags) cur.reason_tags.add(t)
    if (e.raw_id) cur.raw_ids.add(e.raw_id)
    if (cur.sample_snippets.length < 5 && !cur.sample_snippets.includes(e.snippet)) {
      cur.sample_snippets.push(e.snippet)
    }
  }
  return [...agg.values()]
}

async function upsertEdges(edges, productMap) {
  const now = new Date().toISOString()
  let upserted = 0
  for (const e of edges) {
    const src_pid = productMap.get(e.source_term) ?? null
    const tgt_pid = productMap.get(e.target_term) ?? null

    // 기존 row 조회 후 누적 upsert (raw_ids 합집합, count 누적)
    const { data: existing } = await sb
      .from('jimscanner_substitution_edges')
      .select('id, count, reason_tags, raw_ids, sample_snippets, first_seen')
      .eq('source_term', e.source_term)
      .eq('target_term', e.target_term)
      .eq('pattern', e.pattern)
      .maybeSingle()

    const reasonUnion = [...new Set([...(existing?.reason_tags ?? []), ...e.reason_tags])]
    const rawIdsUnion = [...new Set([...(existing?.raw_ids ?? []), ...e.raw_ids])].slice(0, 200)
    const snipUnion = [
      ...new Set([...(existing?.sample_snippets ?? []), ...e.sample_snippets]),
    ].slice(0, 5)

    const payload = {
      source_term: e.source_term,
      target_term: e.target_term,
      pattern: e.pattern,
      count: (existing?.count ?? 0) + e.count,
      reason_tags: reasonUnion,
      raw_ids: rawIdsUnion,
      sample_snippets: snipUnion,
      source_product_id: src_pid,
      target_product_id: tgt_pid,
      first_seen: existing?.first_seen ?? now,
      last_seen: now,
    }

    const { error } = await sb
      .from('jimscanner_substitution_edges')
      .upsert(payload, { onConflict: 'source_term,target_term,pattern' })
    if (error) {
      console.error(`  upsert fail ${e.source_term}->${e.target_term}: ${error.message}`)
      continue
    }
    upserted++
  }
  return upserted
}

async function main() {
  const t0 = Date.now()
  console.log(`[${new Date().toISOString()}] extract-substitution start`)

  const [rawRows, trendRows, productMap] = await Promise.all([
    fetchMarketRaw(),
    fetchTrendsProducts(),
    fetchProductNameMap(),
  ])

  console.log(
    `  fetched ${rawRows.length} market_raw, ${trendRows.length} trends_products, ${productMap.size} product names`,
  )

  const allEdges = []
  for (const r of rawRows) {
    const text = [r.title, r.metadata?.description, r.metadata?.snippet]
      .filter(Boolean)
      .join('\n')
    const edges = extractEdges(text, r.id)
    allEdges.push(...edges)
  }
  for (const p of trendRows) {
    const text = [p.canonical_name, p.description].filter(Boolean).join('\n')
    if (text) allEdges.push(...extractEdges(text, null))
  }

  console.log(`  extracted ${allEdges.length} raw edge matches`)

  const aggregated = aggregate(allEdges)
  console.log(`  aggregated to ${aggregated.length} unique (source,target,pattern) edges`)

  if (aggregated.length === 0) {
    console.log('  no edges to upsert — done')
    return
  }

  const upserted = await upsertEdges(aggregated, productMap)
  console.log(
    `[${new Date().toISOString()}] done — ${upserted} edges upserted (${Date.now() - t0}ms)`,
  )
}

main().catch((e) => {
  console.error(`[fatal] ${e instanceof Error ? e.message : e}`)
  process.exit(1)
})
