/**
 * collect-review-velocity.mjs — 리뷰 증가속도 수집기 (WSL 로컬 실행)
 * ─────────────────────────────────────────────────────────────
 * canonical 상품(jimscanner_trends_products)별로 SERP 상위 경쟁 SKU 의
 * 누적 리뷰수를 스냅샷으로 적재한다. RPC(jimscanner_review_velocity_board)가
 * 일간 증가분(Δreview/day)을 계산해 추정 일판매량 밴드를 산출한다.
 *
 * 적재 테이블: jimscanner_review_velocity (supabase/review_velocity.sql)
 *
 * 사용:
 *   node scripts/collect-review-velocity.mjs              # 전체 canonical 상품
 *   node scripts/collect-review-velocity.mjs --limit 20   # 상위 N개만
 *
 * 주의:
 *   - SERP/리뷰수 파서는 마켓 HTML 구조에 의존하므로 fetchCompetitorSkus() 만
 *     교체하면 마켓별로 확장 가능 (쿠팡/네이버/지마켓). 현재는 스텁 + TODO.
 *   - heartbeat 갱신으로 sources 페이지에서 생존 확인.
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
const limitArg = args.indexOf('--limit')
const LIMIT = limitArg >= 0 ? parseInt(args[limitArg + 1], 10) : 200

/**
 * 한 canonical 상품의 SERP 상위 경쟁 SKU 리뷰수를 가져온다.
 * 반환: [{ marketplace, competitor_sku, review_count, rating_avg, sku_title, sku_price_krw, serp_rank }]
 *
 * TODO: 마켓별 SERP 파서 구현.
 *   - 쿠팡: https://www.coupang.com/np/search?q=<canonical_name> → 상위 N개 productId·리뷰수
 *   - 네이버: 쇼핑 SERP nvMid·리뷰수
 *   현재는 빈 배열 반환(스키마·파이프라인 검증용 스텁).
 */
async function fetchCompetitorSkus(product) {
  void product
  // 실제 SERP 크롤은 마켓 차단 회피(헤드리스/지연/쿠키) 필요 — 별도 PR 에서 구현.
  return []
}

async function upsertHeartbeat(status, notes) {
  await sb
    .from('jimscanner_trends_heartbeat')
    .upsert(
      {
        id: 'main',
        heartbeat_at: new Date().toISOString(),
        last_collector: 'collect-review-velocity',
        last_run_status: status,
        notes,
      },
      { onConflict: 'id' },
    )
}

async function main() {
  const { data: products, error } = await sb
    .from('jimscanner_trends_products')
    .select('id, canonical_name, category_top')
    .order('last_seen_at', { ascending: false })
    .limit(LIMIT)

  if (error) {
    console.error('상품 조회 실패:', error.message)
    await upsertHeartbeat('error', `collect-review-velocity: ${error.message}`)
    process.exit(1)
  }

  const observedAt = new Date().toISOString()
  let snapshots = 0
  let withSku = 0

  for (const product of products ?? []) {
    let skus = []
    try {
      skus = await fetchCompetitorSkus(product)
    } catch (e) {
      console.warn(`  [skip] ${product.canonical_name}: ${e.message}`)
      continue
    }
    if (skus.length === 0) continue
    withSku++

    const rows = skus.map((s) => ({
      product_id: product.id,
      marketplace: s.marketplace,
      competitor_sku: s.competitor_sku,
      review_count: s.review_count,
      rating_avg: s.rating_avg ?? null,
      sku_title: s.sku_title ?? null,
      sku_price_krw: s.sku_price_krw ?? null,
      serp_rank: s.serp_rank ?? null,
      observed_at: observedAt,
    }))

    const { error: insErr } = await sb.from('jimscanner_review_velocity').insert(rows)
    if (insErr) {
      console.error(`  적재 실패 (${product.canonical_name}):`, insErr.message)
      continue
    }
    snapshots += rows.length
    console.log(`  ✓ ${product.canonical_name}: ${rows.length} SKU 스냅샷`)
  }

  const status = withSku > 0 ? 'ok' : 'partial'
  const notes = `리뷰속도: 상품 ${products?.length ?? 0}개 중 ${withSku}개 매칭, 스냅샷 ${snapshots}건`
  await upsertHeartbeat(status, notes)
  console.log(`\n완료. ${notes}`)
  if (withSku === 0) {
    console.log('SERP 파서(fetchCompetitorSkus) 미구현 — 스키마·파이프라인 검증 모드.')
  }
}

main().catch(async (e) => {
  console.error(e)
  await upsertHeartbeat('error', `collect-review-velocity: ${e.message}`)
  process.exit(1)
})
