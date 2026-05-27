#!/usr/bin/env node
/**
 * Modifier Demand Vector — 일배치 빌더 (로컬 cron).
 *
 * naver_search_trend / naver_shopping_insight / google_suggest /
 * market_raw 의 쿼리 텍스트를 룰베이스 사전으로 형태소 분해하여
 * 카테고리별 수식어(포지셔닝축) 토큰의 검색량/점유율/7일 기울기를
 * jimscanner_modifier_demand 에 upsert 한다.
 *
 * 호출:
 *   node --env-file=.env.local scripts/build-modifier-demand.mjs
 *   node --env-file=.env.local scripts/build-modifier-demand.mjs --days=30 --period=7
 *
 * 인자:
 *   --days=N        : 분석 윈도우 (기본 30)
 *   --period=N      : 집계 구간(일). 1=일별, 7=주별 (기본 1)
 *   --dry-run       : 적재 안 함
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

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)=(.*)$/)
    return m ? [m[1], m[2]] : [a.replace(/^--/, ''), 'true']
  }),
)
const DAYS = Number.parseInt(args.days ?? '30', 10)
const PERIOD = Number.parseInt(args.period ?? '1', 10)
const DRY_RUN = args['dry-run'] === 'true'

// ──────────────────────────────────────────────────────────────────
// 기본 수식어 사전 (DB에 jimscanner_modifier_dictionary 가 비면 사용)
// 각 modifier 는 표면형 패턴 배열로 매칭한다 (정규식이 아닌 단순 substring).
const DEFAULT_MODIFIERS = [
  // 사이즈 / 용량
  { modifier: '대용량', axis: '사이즈', patterns: ['대용량', '초대용량', '벌크', '점보'] },
  { modifier: '미니',   axis: '사이즈', patterns: ['미니', '소형', '컴팩트', '초소형'] },
  { modifier: '1인용',  axis: '사이즈', patterns: ['1인용', '일인용', '싱글'] },
  { modifier: '2인용',  axis: '사이즈', patterns: ['2인용', '이인용', '커플'] },
  { modifier: '대형',   axis: '사이즈', patterns: ['대형', '특대', 'XL', '맥시'] },

  // 연결방식 / 형식
  { modifier: '무선',     axis: '연결방식', patterns: ['무선', '와이어리스', 'wireless'] },
  { modifier: '유선',     axis: '연결방식', patterns: ['유선'] },
  { modifier: '접이식',   axis: '형식',     patterns: ['접이식', '폴딩', '폴더블', '접는'] },
  { modifier: '휴대용',   axis: '형식',     patterns: ['휴대용', '포터블', 'portable'] },
  { modifier: '접지형',   axis: '형식',     patterns: ['접지형', '접지', '3구', '돼지코'] },
  { modifier: '벽걸이',   axis: '형식',     patterns: ['벽걸이', '월마운트'] },
  { modifier: '스탠드',   axis: '형식',     patterns: ['스탠드형', '스탠드', '수직'] },

  // 가격대 / 등급
  { modifier: '저렴한',   axis: '가격대', patterns: ['저렴한', '저가', '가성비', '초저가'] },
  { modifier: '프리미엄', axis: '가격대', patterns: ['프리미엄', '하이엔드', '럭셔리'] },
  { modifier: '명품',     axis: '가격대', patterns: ['명품'] },

  // 패키징 / 상태
  { modifier: '세트',     axis: '패키징', patterns: ['세트', '패키지', '키트', '번들'] },
  { modifier: '리퍼',     axis: '상태',   patterns: ['리퍼', '리퍼비시', 'refurb'] },
  { modifier: '중고',     axis: '상태',   patterns: ['중고'] },
  { modifier: '한정',     axis: '상태',   patterns: ['한정', '리미티드', 'limited'] },
  { modifier: '신상',     axis: '상태',   patterns: ['신상', '신제품', '신형'] },

  // 라이프스타일 / 가치
  { modifier: '친환경',   axis: '가치', patterns: ['친환경', '에코', 'eco', '비건'] },
  { modifier: '국산',     axis: '가치', patterns: ['국산'] },
  { modifier: '수입',     axis: '가치', patterns: ['수입', '직구', '병행수입'] },
  { modifier: '핸드메이드', axis: '가치', patterns: ['핸드메이드', '수제'] },

  // 색상/디자인
  { modifier: '블랙',     axis: '색상', patterns: ['블랙', 'black'] },
  { modifier: '화이트',   axis: '색상', patterns: ['화이트', 'white'] },
  { modifier: '심플',     axis: '디자인', patterns: ['심플', '미니멀', '모던'] },

  // 디지털 특화
  { modifier: '고출력',   axis: '성능', patterns: ['고출력', '하이파워', '대출력'] },
  { modifier: '저소음',   axis: '성능', patterns: ['저소음', '무소음', '정숙'] },
  { modifier: '방수',     axis: '성능', patterns: ['방수', '생활방수', 'ipx'] },
  { modifier: 'OLED',     axis: '성능', patterns: ['oled'] },
  { modifier: '4K',       axis: '성능', patterns: ['4k', 'uhd', '4케이'] },
]

// 카테고리 키워드 추정 사전 (raw 쿼리에 카테고리 정보가 없을 때 fallback).
const CATEGORY_HEURISTICS = {
  health:  ['오메가', '비타민', '유산균', '단백질', '루테인', '콜라겐', '프로틴', '쉐이크', '글루타', '아연', '마그네슘', '영양제', '건강식품'],
  living:  ['수납', '청소기', '의자', '책상', '소파', '베개', '이불', '커튼', '주방', '컵', '도마', '캠핑', '인테리어', '향수'],
  digital: ['이어폰', '헤드폰', '키보드', '마우스', '모니터', '노트북', '충전기', '케이블', '스피커', 'tv', '카메라', '드론', '태블릿', 'usb', '허브'],
}

function normalize(s) {
  return String(s ?? '').toLowerCase().trim()
}

function guessCategory(text, hintTop) {
  if (hintTop === 'health' || hintTop === 'living' || hintTop === 'digital' || hintTop === 'other') return hintTop
  const t = normalize(text)
  for (const [cat, words] of Object.entries(CATEGORY_HEURISTICS)) {
    for (const w of words) if (t.includes(w)) return cat
  }
  return 'other'
}

function extractModifiers(text, dict) {
  const t = normalize(text)
  if (!t) return []
  const hits = []
  for (const entry of dict) {
    for (const p of entry.patterns) {
      if (t.includes(p.toLowerCase())) {
        hits.push(entry.modifier)
        break
      }
    }
  }
  return hits
}

async function loadDictionary() {
  const { data, error } = await sb
    .from('jimscanner_modifier_dictionary')
    .select('modifier, patterns, category, axis, is_active')
    .eq('is_active', true)
    .limit(1000)
  if (error) {
    console.warn('[modifier-demand] dictionary fetch failed, using DEFAULT_MODIFIERS:', error.message)
    return DEFAULT_MODIFIERS
  }
  if (!data || data.length === 0) {
    console.log(`[modifier-demand] dictionary empty — using ${DEFAULT_MODIFIERS.length} default entries`)
    return DEFAULT_MODIFIERS
  }
  return data.map((d) => ({
    modifier: d.modifier,
    axis: d.axis ?? null,
    patterns: (d.patterns ?? []).length ? d.patterns : [d.modifier],
  }))
}

async function fetchKeywordRows(sinceIso) {
  // jimscanner_trends_keywords 에서 최근 N일치 keyword + category_top + collected_at
  const out = []
  let from = 0
  const PAGE = 1000
  while (true) {
    const { data, error } = await sb
      .from('jimscanner_trends_keywords')
      .select('keyword, category_top, source, collected_at, volume_relative')
      .gte('collected_at', sinceIso)
      .order('collected_at', { ascending: false })
      .range(from, from + PAGE - 1)
    if (error) {
      console.error('[modifier-demand] trends_keywords fetch error:', error.message)
      break
    }
    if (!data || data.length === 0) break
    out.push(...data)
    if (data.length < PAGE) break
    from += PAGE
    if (out.length >= 50000) break
  }
  return out
}

function dateKey(iso, periodDays) {
  const d = new Date(iso)
  d.setUTCHours(0, 0, 0, 0)
  if (periodDays > 1) {
    // bucket 시작 = 가장 가까운 periodDays 의 배수 (epoch 기준)
    const epochDays = Math.floor(d.getTime() / 86400_000)
    const bucketStartDays = epochDays - (epochDays % periodDays)
    d.setTime(bucketStartDays * 86400_000)
  }
  return d.toISOString().slice(0, 10)
}

function regressionSlope(points) {
  // points: [{x: dayIndex, y: count}]. 단순 최소제곱 기울기.
  if (points.length < 2) return null
  const n = points.length
  let sx = 0, sy = 0, sxx = 0, sxy = 0
  for (const p of points) {
    sx += p.x
    sy += p.y
    sxx += p.x * p.x
    sxy += p.x * p.y
  }
  const denom = n * sxx - sx * sx
  if (denom === 0) return null
  return (n * sxy - sx * sy) / denom
}

async function main() {
  const startedAt = Date.now()
  const sinceIso = new Date(Date.now() - DAYS * 86400_000).toISOString()
  console.log(`[modifier-demand] days=${DAYS} period=${PERIOD} since=${sinceIso} dry=${DRY_RUN}`)

  const dict = await loadDictionary()
  console.log(`[modifier-demand] dictionary entries: ${dict.length}`)

  const rows = await fetchKeywordRows(sinceIso)
  console.log(`[modifier-demand] keyword rows fetched: ${rows.length}`)

  // 집계: key = `${category}|${modifier}|${periodStart}` → count
  // 분모: `${category}|${periodStart}` → sum(count)  (점유율 계산용)
  const bucket = new Map()
  const denom = new Map()

  for (const r of rows) {
    const txt = r.keyword
    if (!txt) continue
    const periodStart = dateKey(r.collected_at, PERIOD)
    const category = guessCategory(txt, r.category_top)
    const weight = Math.max(1, Math.round(r.volume_relative ?? 1))
    const mods = extractModifiers(txt, dict)
    if (mods.length === 0) {
      // 카테고리 분모만 가산 (수식어 미포함도 카테고리 검색량)
      const dk = `${category}|${periodStart}`
      denom.set(dk, (denom.get(dk) ?? 0) + weight)
      continue
    }
    for (const mod of mods) {
      const k = `${category}|${mod}|${periodStart}`
      bucket.set(k, (bucket.get(k) ?? 0) + weight)
    }
    const dk = `${category}|${periodStart}`
    denom.set(dk, (denom.get(dk) ?? 0) + weight)
  }

  // share 계산 + slope_7d 를 위해 카테고리/모디파이어 별 시계열 모음
  const byCatMod = new Map() // `${category}|${modifier}` → [{periodStart, count, share}]
  for (const [k, count] of bucket.entries()) {
    const [category, modifier, periodStart] = k.split('|')
    const total = denom.get(`${category}|${periodStart}`) ?? 0
    const share = total > 0 ? count / total : 0
    const cm = `${category}|${modifier}`
    const arr = byCatMod.get(cm) ?? []
    arr.push({ periodStart, count, share })
    byCatMod.set(cm, arr)
  }

  // rank_in_category (가장 최근 periodStart 기준 share desc)
  const latestByCat = new Map() // category → [{modifier, share}]
  // 가장 최근 periodStart 찾기 위해 정렬
  const upserts = []
  for (const [cm, series] of byCatMod.entries()) {
    series.sort((a, b) => a.periodStart.localeCompare(b.periodStart))
    const [category, modifier] = cm.split('|')

    // 7일 회귀 기울기 (마지막 7개 포인트, count 기준)
    const tail = series.slice(-7)
    const slope = regressionSlope(tail.map((s, i) => ({ x: i, y: s.count })))

    const last = series[series.length - 1]
    const arr = latestByCat.get(category) ?? []
    arr.push({ modifier, share: last.share })
    latestByCat.set(category, arr)

    for (const s of series) {
      upserts.push({
        category,
        modifier,
        period_start: s.periodStart,
        period_days: PERIOD,
        query_count: s.count,
        share: s.share,
        slope_7d: slope,
        rank_in_category: null, // 아래에서 채움
      })
    }
  }

  // rank_in_category 부여 (최신 share desc) — 최신 periodStart 행에만 의미 있는 값.
  // 단순화를 위해 (category, modifier) 마다 rank 를 부여하고 모든 행에 동일하게 박는다.
  const rankByCM = new Map()
  for (const [category, list] of latestByCat.entries()) {
    list.sort((a, b) => b.share - a.share)
    list.forEach((x, i) => rankByCM.set(`${category}|${x.modifier}`, i + 1))
  }
  for (const r of upserts) {
    r.rank_in_category = rankByCM.get(`${r.category}|${r.modifier}`) ?? null
  }

  console.log(`[modifier-demand] upsert rows: ${upserts.length}`)
  if (DRY_RUN) {
    console.log('[modifier-demand] dry-run — sample:')
    console.log(JSON.stringify(upserts.slice(0, 5), null, 2))
    return
  }
  if (upserts.length === 0) {
    console.log('[modifier-demand] nothing to write')
    return
  }

  // chunked upsert (PostgREST payload limit 회피)
  const CHUNK = 500
  let written = 0
  for (let i = 0; i < upserts.length; i += CHUNK) {
    const chunk = upserts.slice(i, i + CHUNK)
    const { error } = await sb
      .from('jimscanner_modifier_demand')
      .upsert(chunk, { onConflict: 'category,modifier,period_start,period_days' })
    if (error) {
      console.error('[modifier-demand] upsert error:', error.message)
      break
    }
    written += chunk.length
  }
  console.log(`[modifier-demand] wrote ${written} rows in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`)
}

main().catch((e) => {
  console.error('[modifier-demand] fatal:', e)
  process.exit(1)
})
