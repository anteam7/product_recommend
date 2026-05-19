#!/usr/bin/env node
/**
 * 네이버 검색광고 API (KeyWordsTool) 로
 * 핀 후보 키워드의 월간 검색량 / 추정 CPC / 경쟁 지수를 수집해
 * jimscanner_trends_keyword_ads 에 적재.
 *
 * 입력: jimscanner_trends_pins (keyword 기준 unique)
 * 출력: jimscanner_trends_keyword_ads (시계열 누적)
 *
 * 사용법:
 *   node --env-file=.env.local scripts/fetch-naver-ads-stats.mjs
 *   node --env-file=.env.local scripts/fetch-naver-ads-stats.mjs --keyword=멜라토닌
 *
 * 필요 환경 변수:
 *   NAVER_ADS_CUSTOMER_ID  (네이버 광고 계정 CUSTOMER_ID)
 *   NAVER_ADS_API_KEY      (API 라이선스 키 — Access License)
 *   NAVER_ADS_SECRET_KEY   (Secret Key)
 *   NEXT_PUBLIC_SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *
 * 미설정 시 모의(mock) 모드로 동작 — 핀 키워드별로 결정적(deterministic)
 * 더미 데이터를 적재해 UI 개발/QA 를 막지 않는다.
 */

import crypto from 'node:crypto'
import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_SVC = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!SUPABASE_URL || !SUPABASE_SVC) {
  console.error('Supabase env missing. Run with --env-file=.env.local')
  process.exit(1)
}

const CUSTOMER_ID = process.env.NAVER_ADS_CUSTOMER_ID
const API_KEY = process.env.NAVER_ADS_API_KEY
const SECRET_KEY = process.env.NAVER_ADS_SECRET_KEY
const HAS_LIVE_CREDS = Boolean(CUSTOMER_ID && API_KEY && SECRET_KEY)

const args = process.argv.slice(2)
const keywordFilter = args.find((a) => a.startsWith('--keyword='))?.split('=')[1]

const sb = createClient(SUPABASE_URL, SUPABASE_SVC, {
  auth: { autoRefreshToken: false, persistSession: false },
})

function signature(timestamp, method, uri) {
  const message = `${timestamp}.${method}.${uri}`
  return crypto.createHmac('sha256', SECRET_KEY).update(message).digest('base64')
}

async function fetchKeywordStats(keyword) {
  const uri = '/keywordstool'
  const method = 'GET'
  const timestamp = String(Date.now())
  const sig = signature(timestamp, method, uri)
  const url = `https://api.naver.com${uri}?hintKeywords=${encodeURIComponent(keyword)}&showDetail=1`
  const res = await fetch(url, {
    method,
    headers: {
      'X-Timestamp': timestamp,
      'X-API-KEY': API_KEY,
      'X-Customer': CUSTOMER_ID,
      'X-Signature': sig,
    },
  })
  if (!res.ok) {
    throw new Error(`naver ads ${res.status}: ${await res.text().catch(() => '')}`)
  }
  const json = await res.json()
  const list = Array.isArray(json?.keywordList) ? json.keywordList : []
  // 정확 일치 우선 — 없으면 첫 row
  const exact = list.find(
    (r) =>
      String(r.relKeyword ?? '').replace(/\s+/g, '') === keyword.replace(/\s+/g, '')
  )
  const row = exact ?? list[0]
  if (!row) return null
  const toNum = (v) => {
    if (v === '< 10' || v === '<10') return 5
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  return {
    monthly_pc_qc: toNum(row.monthlyPcQcCnt),
    monthly_mobile_qc: toNum(row.monthlyMobileQcCnt),
    monthly_pc_clk: toNum(row.monthlyAvePcClkCnt),
    monthly_mobile_clk: toNum(row.monthlyAveMobileClkCnt),
    monthly_pc_ctr: toNum(row.monthlyAvePcCtr),
    monthly_mobile_ctr: toNum(row.monthlyAveMobileCtr),
    pl_avg_depth: toNum(row.plAvgDepth),
    competition_idx: row.compIdx ?? null,
    raw_payload: row,
  }
}

// 결정적(deterministic) 모의 데이터 — 키워드 해시 기반
function mockKeywordStats(keyword) {
  const h = crypto.createHash('sha1').update(keyword).digest()
  const pc = 100 + (h.readUInt16BE(0) % 8000)
  const mo = 500 + (h.readUInt16BE(2) % 50000)
  const cpc = 200 + (h.readUInt16BE(4) % 2800)
  const comp = ['낮음', '중간', '높음'][h[6] % 3]
  return {
    monthly_pc_qc: pc,
    monthly_mobile_qc: mo,
    monthly_pc_clk: Math.round(pc * 0.03),
    monthly_mobile_clk: Math.round(mo * 0.05),
    monthly_pc_ctr: 0.5 + (h[7] % 20) / 10,
    monthly_mobile_ctr: 1.0 + (h[8] % 30) / 10,
    pl_avg_depth: 5 + (h[9] % 10),
    avg_cpc: cpc,
    competition_idx: comp,
    raw_payload: { mock: true, keyword },
  }
}

function deriveAvgCpc(stats) {
  // 네이버 API 는 CPC 단가를 직접 제공하지 않음.
  // 추정치: bid_floor = (월 클릭수 가중) 기반 휴리스틱 — 향후 estimate-performance API 로 정밀화.
  if (typeof stats.avg_cpc === 'number') return stats.avg_cpc
  const compMult = stats.competition_idx === '높음' ? 1.6 : stats.competition_idx === '중간' ? 1.0 : 0.6
  const depth = Number(stats.pl_avg_depth) || 5
  // 노출 깊이가 높을수록 입찰 단가 상향 압력.
  return Math.round(300 * compMult * Math.max(1, depth / 5))
}

async function loadPinKeywords() {
  const { data, error } = await sb
    .from('jimscanner_trends_pins')
    .select('keyword, source')
  if (error) throw error
  const set = new Set()
  for (const row of data ?? []) {
    const k = String(row.keyword ?? '').trim()
    if (k) set.add(k)
  }
  return [...set]
}

async function main() {
  let keywords = keywordFilter ? [keywordFilter] : await loadPinKeywords()
  if (keywords.length === 0) {
    console.log('No pin keywords found. Skipping.')
    return
  }
  console.log(`Mode: ${HAS_LIVE_CREDS ? 'live' : 'mock'} · ${keywords.length} keyword(s)`)

  let ok = 0
  let fail = 0
  for (const kw of keywords) {
    try {
      const stats = HAS_LIVE_CREDS ? await fetchKeywordStats(kw) : mockKeywordStats(kw)
      if (!stats) {
        console.warn(`  ! ${kw}: no data`)
        fail++
        continue
      }
      const avg_cpc = deriveAvgCpc(stats)
      const { error } = await sb.from('jimscanner_trends_keyword_ads').insert({
        keyword: kw,
        monthly_pc_qc: stats.monthly_pc_qc,
        monthly_mobile_qc: stats.monthly_mobile_qc,
        monthly_pc_clk: stats.monthly_pc_clk,
        monthly_mobile_clk: stats.monthly_mobile_clk,
        monthly_pc_ctr: stats.monthly_pc_ctr,
        monthly_mobile_ctr: stats.monthly_mobile_ctr,
        avg_cpc,
        pl_avg_depth: stats.pl_avg_depth,
        competition_idx: stats.competition_idx,
        raw_payload: stats.raw_payload,
      })
      if (error) throw error
      ok++
      console.log(`  ✓ ${kw} · qc=${(stats.monthly_pc_qc ?? 0) + (stats.monthly_mobile_qc ?? 0)} · cpc=${avg_cpc} · comp=${stats.competition_idx}`)
      // 네이버 API rate-limit 보호
      if (HAS_LIVE_CREDS) await new Promise((r) => setTimeout(r, 350))
    } catch (e) {
      fail++
      console.warn(`  ! ${kw}: ${e?.message ?? e}`)
    }
  }
  console.log(`Done. ok=${ok} fail=${fail}`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
