#!/usr/bin/env node
/**
 * 경쟁사 Top-N 동시 품절 Cascade 폴링 (로컬 호출)
 *
 * Vercel cron 으로도 등록돼 있지만 (/api/cron/competitor-stock-poll),
 * 로컬에서 즉시 트리거하거나 차단으로 cron 이 실패할 때 우회용으로 사용.
 *
 * 사용법:
 *   node --env-file=.env.local scripts/competitor-stock-poll.mjs
 *   node --env-file=.env.local scripts/competitor-stock-poll.mjs --base https://www.jimscanner.co.kr
 */

const args = process.argv.slice(2)
let base = process.env.CRON_RUNNER_BASE_URL || 'https://www.jimscanner.co.kr'
const baseIdx = args.indexOf('--base')
if (baseIdx >= 0 && args[baseIdx + 1]) base = args[baseIdx + 1]

const secret = process.env.CRON_SECRET
if (!secret) {
  console.error('CRON_SECRET missing. Run with --env-file=.env.local')
  process.exit(1)
}

const url = `${base.replace(/\/+$/, '')}/api/cron/competitor-stock-poll`
const t0 = Date.now()
try {
  const res = await fetch(url, {
    method: 'GET',
    headers: { Authorization: `Bearer ${secret}` },
  })
  const elapsed = Date.now() - t0
  let body
  try {
    body = await res.json()
  } catch {
    body = await res.text().catch(() => null)
  }
  console.log(`[${new Date().toISOString()}] ${res.status} ${elapsed}ms ${url}`)
  console.log(JSON.stringify(body, null, 2))
  process.exit(res.ok ? 0 : 1)
} catch (e) {
  console.error(`fetch error: ${e instanceof Error ? e.message : String(e)}`)
  process.exit(1)
}
