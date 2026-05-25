#!/usr/bin/env node
/**
 * OEM 공유공장 클러스터링 — batch 잡 (스캐폴드)
 * ────────────────────────────────────────────────────────────
 * 사용법:
 *   node --env-file=.env.local scripts/cluster-factory.mjs
 *   node --env-file=.env.local scripts/cluster-factory.mjs --dry-run
 *
 * 동작 (현 스캐폴드 단계):
 *   1) jimscanner_ggsan_products 에서 최근 N일 SKU pull
 *   2) #28 dedup 임베딩이 살아있으면 cosine 0.82~0.95 밴드로
 *      'gấp 다른 SKU 후보' pair 추출 → connected components 로 묶음
 *   3) 사양·인증번호·제조원·원산지·박스·바코드 prefix 신호로
 *      confidence 보정
 *   4) jimscanner_factory_clusters / _members 에 upsert
 *
 * 본 파일은 스키마 + admin 페이지 PR 의 짝이며, 임베딩 파이프라인
 * 연결은 후속 PR(#28 hookup) 에서 채운다. 지금은 '실행 가능한
 * 빈 잡' 으로 두어 cron 추가/배포 경로만 확보한다.
 *
 * scout cron 등록:
 *   scripts/run-crons.mjs 의 CRONS 배열에는 HTTP endpoint 만 들어가므로
 *   별도 Vercel cron 으로 띄우거나, Windows Task Scheduler 에
 *   본 스크립트를 직접 등록한다 (주 1회 권장 — 이미지 유사도
 *   N^2 비용 때문).
 * ────────────────────────────────────────────────────────────
 */

import { createClient } from '@supabase/supabase-js'

const DRY = process.argv.includes('--dry-run')
const COSINE_MIN = Number(process.env.FACTORY_CLUSTER_COSINE_MIN ?? 0.82)
const COSINE_MAX = Number(process.env.FACTORY_CLUSTER_COSINE_MAX ?? 0.95)
const DAYS = Number(process.env.FACTORY_CLUSTER_DAYS ?? 90)

const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!url || !key) {
  console.error('[cluster-factory] NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 가 없습니다.')
  console.error('  node --env-file=.env.local scripts/cluster-factory.mjs')
  process.exit(1)
}

const sb = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false },
})

async function loadSkus() {
  const since = new Date(Date.now() - DAYS * 86400_000).toISOString()
  const { data, error } = await sb
    .from('jimscanner_ggsan_products')
    .select('goods_no, title, price_krw, image_url, detail_url, last_seen_at')
    .gte('last_seen_at', since)
    .limit(5000)
  if (error) {
    console.error('[cluster-factory] ggsan products 조회 실패:', error.message)
    process.exit(1)
  }
  return data ?? []
}

function logPlan(skus) {
  console.log(`[cluster-factory] candidate SKUs: ${skus.length}`)
  console.log(`[cluster-factory] cosine band: ${COSINE_MIN} ~ ${COSINE_MAX}`)
  console.log(`[cluster-factory] lookback: ${DAYS}d`)
  console.log('[cluster-factory] TODO: load image embeddings (#28 hookup)')
  console.log('[cluster-factory] TODO: pairwise cosine in band → connected components')
  console.log('[cluster-factory] TODO: spec/cert/manufacturer/origin signal scoring')
  console.log('[cluster-factory] TODO: upsert jimscanner_factory_clusters + _members')
}

async function main() {
  const skus = await loadSkus()
  logPlan(skus)

  if (DRY) {
    console.log('[cluster-factory] --dry-run: no writes.')
    return
  }

  // 스캐폴드: 아직 임베딩 파이프라인이 붙지 않았으므로
  // upsert 는 실행하지 않는다. 다음 PR 에서 채움.
  console.log('[cluster-factory] embedding source not wired yet — skipping upsert.')
  console.log('[cluster-factory] done.')
}

main().catch((err) => {
  console.error('[cluster-factory] fatal:', err)
  process.exit(1)
})
