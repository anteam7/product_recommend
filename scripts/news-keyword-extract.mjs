#!/usr/bin/env node
/**
 * news-keyword-extract — naver_news raw payload 에서 한국어 명사구 키워드를 추출해
 * jimscanner_news_keyword_mentions 에 일자별로 적재.
 *
 * 호출:
 *   node --env-file=.env.local scripts/news-keyword-extract.mjs
 *
 * 동작:
 *  1) jimscanner_market_raw WHERE source='naver_news' AND processed=false 의 row 를 fetch
 *  2) title + description 에서 한국어 토큰(2-15자) 추출 → stopword/조사 컷
 *  3) 동일 raw 내 중복 토큰 제거 → mention_count 1 단위 적재
 *  4) UPSERT (keyword, day) — count 가산
 *  5) raw row 들 processed=true 마킹
 *
 * Vercel cron 으로 옮길 때는 maxDuration 한도 고려 (현재 21건/24h 라 1회 ~1초).
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

const FETCH_LIMIT = 500

// 한국어 일반 stopword (조사·접미사·일반 기능어 등). 명사구만 남기는 게 목표.
const STOPWORDS = new Set([
  // 기본 기능어
  '있다','없다','하다','되다','이다','같다','보다','오다','가다','받다','주다',
  '대한','대해','위해','통해','관련','이번','지난','이날','오늘','어제','내일',
  '기자','뉴스','보도','속보','단독','종합','코로나','코로나19',
  // 정치·일반 (트렌드 노이즈)
  '대통령','국회의원','정부','국회','의원','장관','회의','발표','확인','진행',
  '추진','검토','계획','예정','경우','상황','문제','이유','이상','이하',
  // 시간·단위
  '오전','오후','이번주','지난주','분기','연간','연도','매년','매월','매일',
  // 일반
  '이상','이하','전년','대비','증가','감소','상승','하락','분석','확대','축소',
  '관계자','업계','시장','기업','회사','거래','거래소','관련주','분야','영역',
  '서비스','사업','시작','종료','적용','시행','지원','발표','기간','수준',
  // 수치성
  '천원','만원','억원','조원','달러','퍼센트',
])

// 단일 한글 글자 1개짜리는 무조건 컷 (조사+명사 분리되면서 1글자 명사 남는 케이스 많음)
const HANGUL_RE = /[가-힣]/
const TOKEN_RE = /[가-힣A-Za-z0-9]+/g

function stripHtml(s) {
  if (!s) return ''
  return String(s)
    .replace(/<[^>]+>/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
}

/**
 * Naive 한국어 명사구 토큰화:
 *  - 공백·구두점 split
 *  - 한글 포함 + 2~15자 + 첫 char 가 한글
 *  - 끝의 흔한 조사 1~2글자 strip (을/를/이/가/은/는/에/도/의/와/과/로/으로/에서/한테/까지/부터)
 *  - stopword 컷
 *
 * 형태소 분석기 없이도 "선점창 OPEN" 후보 발굴엔 충분. 정확도 부족분은
 * LLM batch 로 후처리 가능 (다음 PR).
 */
const JOSA_RE = /(으로|에서|에게|한테|까지|부터|이나|보다|마다|조차|뿐|마저|이며|이라|이라고|라고|이다|이라는|라는|입니다|이었|였|되|는|은|이|가|을|를|의|에|도|와|과|로|만|랑)$/
function tokenizeKorean(text) {
  const out = new Set()
  const matches = text.match(TOKEN_RE) ?? []
  for (let raw of matches) {
    if (!HANGUL_RE.test(raw)) continue
    if (!HANGUL_RE.test(raw[0])) continue
    // 끝 조사 strip (단순 한 번)
    let tok = raw.replace(JOSA_RE, '')
    if (tok.length < 2) tok = raw  // 너무 짧아지면 원본 유지
    if (tok.length < 2 || tok.length > 15) continue
    if (STOPWORDS.has(tok)) continue
    // 숫자만은 컷
    if (/^[0-9]+$/.test(tok)) continue
    out.add(tok)
  }
  return [...out]
}

function dayKey(pubDate, capturedAt) {
  // pubDate 우선, 없으면 captured_at
  const src = pubDate || capturedAt
  if (!src) return new Date().toISOString().slice(0, 10)
  const d = new Date(src)
  if (Number.isNaN(d.getTime())) return new Date().toISOString().slice(0, 10)
  // KST 보정 없이 UTC 그대로 — Naver 가 KST 기준이면 자정 근처만 ±1일 오차, 분포엔 영향 미미.
  return d.toISOString().slice(0, 10)
}

async function fetchUnprocessed() {
  const { data, error } = await sb
    .from('jimscanner_market_raw')
    .select('id, title, metadata, captured_at')
    .eq('source', 'naver_news')
    .eq('processed', false)
    .order('captured_at', { ascending: true })
    .limit(FETCH_LIMIT)
  if (error) throw new Error(`fetch raw: ${error.message}`)
  return data ?? []
}

async function upsertMentions(buckets) {
  // bucket key = `${keyword}|${day}` → { keyword, day, count, titles[], raw_ids[] }
  const entries = [...buckets.values()]
  if (entries.length === 0) return 0

  // 기존 row 와 합산 — read-then-write (entries 수가 작아 트랜잭션 부담 적음)
  let written = 0
  for (const e of entries) {
    const { data: existing } = await sb
      .from('jimscanner_news_keyword_mentions')
      .select('mention_count, sample_titles, raw_ids')
      .eq('keyword', e.keyword)
      .eq('day', e.day)
      .maybeSingle()

    const prevTitles = (existing?.sample_titles ?? [])
    const prevRaw = (existing?.raw_ids ?? [])
    const mergedTitles = [...new Set([...prevTitles, ...e.titles])].slice(0, 5)
    const mergedRaw = [...new Set([...prevRaw, ...e.raw_ids])].slice(0, 20)
    const newCount = (existing?.mention_count ?? 0) + e.count

    const { error: upErr } = await sb
      .from('jimscanner_news_keyword_mentions')
      .upsert(
        {
          keyword: e.keyword,
          day: e.day,
          mention_count: newCount,
          sample_titles: mergedTitles,
          raw_ids: mergedRaw,
          last_seen_at: new Date().toISOString(),
        },
        { onConflict: 'keyword,day' },
      )
    if (upErr) {
      console.error(`  upsert ${e.keyword}/${e.day}: ${upErr.message}`)
      continue
    }
    written++
  }
  return written
}

async function markProcessed(ids) {
  if (ids.length === 0) return
  // chunk 100
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100)
    const { error } = await sb
      .from('jimscanner_market_raw')
      .update({ processed: true })
      .in('id', chunk)
    if (error) console.error(`  mark processed: ${error.message}`)
  }
}

async function logRun(payload) {
  try {
    await sb.from('jimscanner_trends_runs').insert({
      source: 'news_keyword_extract',
      triggered_by: 'local_cron',
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
  console.log(`[${stamp}] news-keyword-extract start`)

  const rows = await fetchUnprocessed()
  console.log(`  unprocessed naver_news: ${rows.length}`)
  if (rows.length === 0) {
    await logRun({
      status: 'ok',
      fetched_count: 0,
      inserted_count: 0,
      duration_ms: Date.now() - t0,
    })
    return
  }

  // bucket key = `${keyword}|${day}`
  const buckets = new Map()
  const processedIds = []
  let tokenSum = 0

  for (const r of rows) {
    processedIds.push(r.id)
    const desc = stripHtml(r.metadata?.description ?? '')
    const title = stripHtml(r.title ?? '')
    const text = `${title}\n${desc}`
    const tokens = tokenizeKorean(text)
    tokenSum += tokens.length
    const day = dayKey(r.metadata?.pubDate, r.captured_at)
    for (const tok of tokens) {
      const k = `${tok}|${day}`
      let b = buckets.get(k)
      if (!b) {
        b = { keyword: tok, day, count: 0, titles: [], raw_ids: [] }
        buckets.set(k, b)
      }
      b.count++
      if (title && !b.titles.includes(title) && b.titles.length < 5) b.titles.push(title)
      if (!b.raw_ids.includes(r.id) && b.raw_ids.length < 20) b.raw_ids.push(r.id)
    }
  }

  console.log(`  tokens extracted: ${tokenSum}, unique (kw,day) buckets: ${buckets.size}`)

  const written = await upsertMentions(buckets)
  await markProcessed(processedIds)

  await logRun({
    status: 'ok',
    fetched_count: rows.length,
    inserted_count: written,
    duration_ms: Date.now() - t0,
  })

  console.log(
    `[${new Date().toISOString()}] done — ${rows.length} raw, ${buckets.size} buckets, ${written} written, ${Date.now() - t0}ms`,
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
