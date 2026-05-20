#!/usr/bin/env node
/**
 * SERP Competitor Scout — 후보 핀 별로 네이버쇼핑/쿠팡 상위 3~5위
 * 판매자의 리스팅 실행 변수 (옵션 수, 상세컷 수, 동영상, 무배, 배송 SLA,
 * 리뷰 수, 응답률, 저평점 테마) 를 주 1회 수집해
 * jimscanner_serp_competitor_listings 에 적재한다.
 *
 * 본 스크립트는 1차 스캐폴딩 — 실제 네트워크 호출은 환경변수
 * SERP_SCOUT_LIVE=1 일 때만 동작한다. 기본은 dry-run 으로,
 * 최근 final_score 상위 N 개 상품을 골라 placeholder row 만 적재한다.
 * (실제 파서는 후속 PR 에서 playwright 기반으로 붙인다.)
 *
 * 사용:
 *   node --env-file=.env.local scripts/scout-serp-competitors.mjs --top=20
 *   node --env-file=.env.local scripts/scout-serp-competitors.mjs --top=20 --live
 *
 * 요구:
 *   - NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
 */

import { createClient } from '@supabase/supabase-js'

const argv = process.argv.slice(2)
function arg(name, def) {
  const hit = argv.find((a) => a.startsWith(`--${name}=`))
  if (hit) return hit.split('=')[1]
  if (argv.includes(`--${name}`)) return true
  return def
}

const TOP = Number(arg('top', 20))
const LIVE = Boolean(arg('live', false)) || process.env.SERP_SCOUT_LIVE === '1'
const CHANNEL = String(arg('channel', 'naver'))

const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!url || !key) {
  console.error('NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 누락')
  process.exit(1)
}

const sb = createClient(url, key, { auth: { persistSession: false } })

async function pickTopProducts(limit) {
  // 최근 6시간 안의 score row 중 final_score 상위.
  // 같은 product_id 는 latest 1건만 유지.
  const { data, error } = await sb
    .from('jimscanner_trends_scores')
    .select('product_id, final_score, computed_at')
    .order('computed_at', { ascending: false })
    .limit(2000)
  if (error) throw error
  const seen = new Set()
  const ranked = []
  for (const row of data ?? []) {
    if (seen.has(row.product_id)) continue
    seen.add(row.product_id)
    ranked.push(row)
  }
  ranked.sort((a, b) => Number(b.final_score) - Number(a.final_score))
  return ranked.slice(0, limit).map((r) => r.product_id)
}

/**
 * 실 네트워크 파서 — playwright 기반. 본 스캐폴딩에서는 미구현.
 * @returns {Promise<Array<object>>} 5건 (rank 1~5)
 */
async function fetchListingsLive(_productId, _channel) {
  // TODO: playwright 로 네이버쇼핑 검색 → 상위 5건 상세 진입 →
  //  옵션 수 / 상세컷 수 / 동영상 / 배송 / 리뷰 수 / 응답률 / 저평점 테마 수집.
  throw new Error('live mode 미구현 — playwright 파서 후속 PR')
}

function placeholderRows(productId, channel) {
  // dry-run 용: 보드/카드 UI 가 빈 화면이 아니도록 1~3위 placeholder 적재.
  // 의도적으로 NULL 을 많이 두어 UI 가 "데이터 없음" 분기를 자연스럽게 타도록 함.
  return [1, 2, 3].map((rank) => ({
    product_id: productId,
    channel,
    rank,
    seller: null,
    listing_url: null,
    title: null,
    option_count: null,
    detail_image_count: null,
    has_video: null,
    free_shipping: null,
    ship_sla_hr: null,
    review_count: null,
    response_rate: null,
    low_star_themes: [],
    price_krw: null,
  }))
}

async function main() {
  const ids = await pickTopProducts(TOP)
  console.log(`[scout] top ${ids.length} products picked (channel=${CHANNEL}, live=${LIVE})`)

  let inserted = 0
  for (const pid of ids) {
    let rows
    try {
      rows = LIVE ? await fetchListingsLive(pid, CHANNEL) : placeholderRows(pid, CHANNEL)
    } catch (e) {
      console.warn(`[scout] ${pid} skip: ${e.message}`)
      continue
    }
    if (!rows?.length) continue
    const { error } = await sb.from('jimscanner_serp_competitor_listings').insert(rows)
    if (error) {
      console.warn(`[scout] insert fail ${pid}: ${error.message}`)
      continue
    }
    inserted += rows.length
  }
  console.log(`[scout] inserted ${inserted} rows`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
