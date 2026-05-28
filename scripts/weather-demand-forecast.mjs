#!/usr/bin/env node
/**
 * 로컬에서 compute-weather-demand cron 을 호출하는 thin wrapper.
 * 실제 로직은 src/app/api/cron/compute-weather-demand/route.ts.
 *
 *   node --env-file=.env.local scripts/weather-demand-forecast.mjs
 */
const BASE_URL =
  process.env.CRON_RUNNER_BASE_URL ?? 'https://product-recommend-nine.vercel.app'
const SECRET = process.env.CRON_SECRET
if (!SECRET) {
  console.error('CRON_SECRET missing (use --env-file=.env.local)')
  process.exit(1)
}
const res = await fetch(`${BASE_URL}/api/cron/compute-weather-demand`, {
  headers: { Authorization: `Bearer ${SECRET}` },
})
const body = await res.json().catch(() => null)
console.log(res.status, JSON.stringify(body, null, 2))
process.exit(res.ok ? 0 : 1)
