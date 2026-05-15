#!/usr/bin/env node
/**
 * Nightly REFRESH of jimscanner_trends_cooccurrence + ggsan_match matviews.
 *
 *   PGPASSWORD=... node scripts/refresh-cooccurrence.mjs
 *   PGPASSWORD=... node scripts/refresh-cooccurrence.mjs --first   # 초기 1회: non-CONCURRENT
 *
 * Vercel cron 한도(2개) 우회 — 로컬 Task Scheduler 에서 호출.
 */

import pg from 'pg'

const { Client } = pg

const password = process.env.PGPASSWORD || process.env.SUPABASE_DB_PASSWORD
if (!password) {
  console.error('PGPASSWORD 또는 SUPABASE_DB_PASSWORD 환경변수 필요')
  process.exit(1)
}

const isFirst = process.argv.includes('--first')

const client = new Client({
  host: 'aws-0-ap-northeast-2.pooler.supabase.com',
  port: 6543,
  user: 'postgres.obxvucyhzlakensopalf',
  password,
  database: 'postgres',
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 15000,
})

const t0 = Date.now()
await client.connect()
console.log(`[refresh-cooccurrence] connected (${isFirst ? 'FIRST run' : 'concurrent'})`)

async function refresh(view) {
  const t = Date.now()
  const sql = isFirst
    ? `REFRESH MATERIALIZED VIEW ${view}`
    : `REFRESH MATERIALIZED VIEW CONCURRENTLY ${view}`
  await client.query(sql)
  console.log(`  ✓ ${view} (${Date.now() - t}ms)`)
}

try {
  await refresh('jimscanner_trends_cooccurrence')
  await refresh('jimscanner_trends_products_ggsan_match')

  const { rows: [stats] } = await client.query(
    `SELECT
        (SELECT count(*)::int FROM jimscanner_trends_cooccurrence) AS pair_count,
        (SELECT count(*)::int FROM jimscanner_trends_products_ggsan_match WHERE has_ggsan_match) AS ggsan_matched,
        (SELECT count(*)::int FROM jimscanner_trends_products_ggsan_match) AS products_total`,
  )
  console.log(
    `[refresh-cooccurrence] pairs=${stats.pair_count} · ggsan_matched=${stats.ggsan_matched}/${stats.products_total}`,
  )
} catch (e) {
  console.error('[refresh-cooccurrence] FAIL:', e instanceof Error ? e.message : e)
  process.exitCode = 1
} finally {
  await client.end()
}

console.log(`[refresh-cooccurrence] done (${Date.now() - t0}ms)`)
