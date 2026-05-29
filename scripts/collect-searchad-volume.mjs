#!/usr/bin/env node
/**
 * Naver 검색광고(SearchAd) 월간검색수 수집 — 절대규모 캘리브레이션 앵커.
 *
 * DataLab 의 0~100 ratio 는 그룹마다 내부 max=100 으로 독립 정규화돼 그룹간
 * 비교가 불가능하다. SearchAd getKeywordStat(/keywordstool) 의
 * monthlyPcQcCnt + monthlyMobileQcCnt = 절대 월간검색수를 수집해
 * 각 DataLab 그룹의 앵커(절대 수요 규모)로 저장한다.
 *
 * 결과는 jimscanner_trends_keyword_volume 테이블에 적재되고,
 * jimscanner_trends_volume_anchors() / jimscanner_trends_calibrated_keywords()
 * RPC 가 이를 ratio 재스케일에 사용한다.
 *
 * 사용법:
 *   node --env-file=.env.local scripts/collect-searchad-volume.mjs
 *
 * 필요 환경변수 (네이버 검색광고 > 도구 > API 사용관리):
 *   NAVER_SEARCHAD_API_KEY      액세스 라이선스
 *   NAVER_SEARCHAD_SECRET_KEY   비밀키
 *   NAVER_SEARCHAD_CUSTOMER_ID  고객 ID (숫자)
 *   NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY
 */

import crypto from 'node:crypto'
import { createClient } from '@supabase/supabase-js'

const SEARCHAD_BASE = 'https://api.searchad.naver.com'

const API_KEY = process.env.NAVER_SEARCHAD_API_KEY
const SECRET_KEY = process.env.NAVER_SEARCHAD_SECRET_KEY
const CUSTOMER_ID = process.env.NAVER_SEARCHAD_CUSTOMER_ID
const SB_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!API_KEY || !SECRET_KEY || !CUSTOMER_ID) {
  console.error(
    'NAVER_SEARCHAD_API_KEY / NAVER_SEARCHAD_SECRET_KEY / NAVER_SEARCHAD_CUSTOMER_ID 환경변수 필요',
  )
  process.exit(1)
}
if (!SB_URL || !SB_KEY) {
  console.error('NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 환경변수 필요')
  process.exit(1)
}

const sb = createClient(SB_URL, SB_KEY, { auth: { persistSession: false } })

/** SearchAd HMAC-SHA256 서명 헤더 */
function signedHeaders(method, path) {
  const timestamp = String(Date.now())
  const message = `${timestamp}.${method}.${path}`
  const signature = crypto
    .createHmac('sha256', SECRET_KEY)
    .update(message)
    .digest('base64')
  return {
    'Content-Type': 'application/json; charset=UTF-8',
    'X-Timestamp': timestamp,
    'X-API-KEY': API_KEY,
    'X-Customer': String(CUSTOMER_ID),
    'X-Signature': signature,
  }
}

/**
 * getKeywordStat — hintKeywords 최대 5개씩. 공백 제거 + 대문자 정규화는 API 쪽 규칙.
 * @returns relKeywordList: [{ relKeyword, monthlyPcQcCnt, monthlyMobileQcCnt, compIdx }]
 */
async function getKeywordStat(keywords) {
  const path = '/keywordstool'
  // SearchAd 는 공백 없는 키워드를 권장. '< 10' 같은 문자열도 그대로 받음.
  const hint = keywords.map((k) => k.replace(/\s+/g, '')).join(',')
  const url = `${SEARCHAD_BASE}${path}?hintKeywords=${encodeURIComponent(hint)}&showDetail=1`
  const res = await fetch(url, { method: 'GET', headers: signedHeaders('GET', path) })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`SearchAd ${path} HTTP ${res.status}: ${text.slice(0, 300)}`)
  }
  const json = await res.json()
  return Array.isArray(json.keywordList) ? json.keywordList : []
}

/** '< 10' 등 비숫자 표기를 정수로 정규화 */
function toCount(v) {
  if (typeof v === 'number') return v
  if (typeof v === 'string') {
    const n = parseInt(v.replace(/[^0-9]/g, ''), 10)
    return Number.isFinite(n) ? n : 0
  }
  return 0
}

async function main() {
  const startedAt = Date.now()

  // 검색어 트렌드 시드에서 그룹 → 키워드 매핑 로드. 각 그룹의 키워드를 SearchAd 로 조회.
  const { data: seeds, error: sErr } = await sb
    .from('jimscanner_trends_seeds')
    .select('label, config')
    .eq('source', 'naver_search_trend')
    .eq('is_active', true)
    .order('display_order')
  if (sErr) {
    console.error('seed 로드 실패:', sErr.message)
    process.exit(1)
  }

  const seedList = seeds ?? []
  if (seedList.length === 0) {
    console.error('활성 naver_search_trend 시드 없음')
    process.exit(1)
  }

  const rows = []
  let fetched = 0
  let lastErr = null

  for (const seed of seedList) {
    const groupLabel = seed.config?.groupName ?? seed.label
    const keywords = Array.isArray(seed.config?.keywords) ? seed.config.keywords : []
    if (keywords.length === 0) continue

    // hintKeywords 5개 제한
    for (let i = 0; i < keywords.length; i += 5) {
      const slice = keywords.slice(i, i + 5)
      try {
        const stats = await getKeywordStat(slice)
        fetched++
        // 요청한 키워드만 추림(연관검색어 폭주 방지)
        const wanted = new Set(slice.map((k) => k.replace(/\s+/g, '')))
        for (const s of stats) {
          const rel = String(s.relKeyword ?? '')
          if (!wanted.has(rel.replace(/\s+/g, ''))) continue
          const pc = toCount(s.monthlyPcQcCnt)
          const mobile = toCount(s.monthlyMobileQcCnt)
          rows.push({
            keyword: rel,
            group_label: groupLabel,
            monthly_pc: pc,
            monthly_mobile: mobile,
            monthly_total: pc + mobile,
            comp_idx: s.compIdx ?? null,
          })
        }
      } catch (e) {
        lastErr = e instanceof Error ? e.message : String(e)
        console.error(`  [${groupLabel}] ${slice.join(',')} → ${lastErr}`)
      }
      // SearchAd rate limit 보호
      await new Promise((r) => setTimeout(r, 250))
    }
  }

  let inserted = 0
  if (rows.length > 0) {
    const { error: insErr } = await sb.from('jimscanner_trends_keyword_volume').insert(rows)
    if (insErr) {
      lastErr = insErr.message
      console.error('insert 실패:', insErr.message)
    } else {
      inserted = rows.length
    }
  }

  // run 감사 로그 (기존 트렌드 cron 과 동일 테이블)
  const status = lastErr ? (inserted > 0 ? 'partial' : 'error') : 'ok'
  await sb.from('jimscanner_trends_runs').insert({
    source: 'naver_searchad_volume',
    status,
    fetched_count: fetched,
    inserted_count: inserted,
    duration_ms: Date.now() - startedAt,
    error_message: lastErr,
    triggered_by: 'cli',
    started_at: new Date(startedAt).toISOString(),
    finished_at: new Date().toISOString(),
  })

  console.log(
    `[searchad-volume] status=${status} fetched=${fetched} inserted=${inserted}${lastErr ? ` err=${lastErr}` : ''}`,
  )
  process.exit(status === 'error' ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
