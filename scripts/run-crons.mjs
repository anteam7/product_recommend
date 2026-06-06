#!/usr/bin/env node
/**
 * 로컬 cron runner — Vercel Hobby 플랜의 cron 한도 우회용.
 *
 * 현재는 환율/요율(update-rates)과 배송료(refresh-shipping-rates) 갱신만
 * 수행한다. (트렌드 수집/LLM 분류 cron은 비활성화되어 제거됨)
 *
 * 사용법:
 *   node --env-file=.env.local scripts/run-crons.mjs              # 전체 실행
 *   node --env-file=.env.local scripts/run-crons.mjs <name>       # 특정 cron 만 실행
 *   node --env-file=.env.local scripts/run-crons.mjs --list       # 목록
 *
 * Windows Task Scheduler 등록 예 (PowerShell, 매일 KST 03:30):
 *   $action = New-ScheduledTaskAction -Execute "node.exe" `
 *     -Argument "--env-file=.env.local scripts/run-crons.mjs" `
 *     -WorkingDirectory "C:\Web\jimscanner-personal"
 *   $trigger = New-ScheduledTaskTrigger -Daily -At 3:30am
 *   Register-ScheduledTask -TaskName "jimscanner-product-recommend-crons" `
 *     -Action $action -Trigger $trigger -RunLevel Limited
 */

const BASE_URL =
  process.env.CRON_RUNNER_BASE_URL ?? 'https://product-recommend-nine.vercel.app'

const CRONS = [
  '/api/cron/update-rates',
  '/api/cron/refresh-shipping-rates',
]

const SECRET = process.env.CRON_SECRET
if (!SECRET) {
  console.error('CRON_SECRET missing. Did you run with --env-file=.env.local ?')
  process.exit(1)
}

const args = process.argv.slice(2)
if (args.includes('--list')) {
  console.log('Registered cron endpoints:')
  for (const p of CRONS) console.log(`  ${p}`)
  process.exit(0)
}

const filter = args[0]
const targets = filter
  ? CRONS.filter((p) => p.endsWith(filter) || p === filter || p.includes(filter))
  : CRONS

if (targets.length === 0) {
  console.error(`No cron matched filter: ${filter}`)
  console.error('Run with --list to see available cron paths.')
  process.exit(1)
}

async function callCron(path) {
  const url = `${BASE_URL}${path}`
  const t0 = Date.now()
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${SECRET}` },
    })
    const elapsed = Date.now() - t0
    let body = null
    try {
      body = await res.json()
    } catch {
      body = await res.text().catch(() => null)
    }
    return { path, status: res.status, ok: res.ok, ms: elapsed, body }
  } catch (e) {
    return {
      path,
      status: 0,
      ok: false,
      ms: Date.now() - t0,
      body: { error: e instanceof Error ? e.message : String(e) },
    }
  }
}

function summarize(body) {
  if (!body || typeof body !== 'object') return ''
  const keys = ['ok', 'inserted', 'classified', 'processed', 'message', 'skipped', 'error']
  const picked = {}
  for (const k of keys) if (k in body) picked[k] = body[k]
  return Object.keys(picked).length ? JSON.stringify(picked) : ''
}

const t0 = Date.now()
console.log(`[${new Date().toISOString()}] running ${targets.length} cron(s) → ${BASE_URL}`)

let okCount = 0
let failCount = 0
for (const path of targets) {
  const r = await callCron(path)
  const tag = r.ok ? 'OK ' : 'ERR'
  const detail = summarize(r.body)
  console.log(`  ${tag} ${r.status} ${r.ms.toString().padStart(6)}ms  ${path}  ${detail}`)
  if (r.ok) okCount++
  else failCount++
}

const totalMs = Date.now() - t0
console.log(
  `[${new Date().toISOString()}] HTTP crons done — ${okCount} ok, ${failCount} fail in ${totalMs}ms`,
)

process.exit(failCount > 0 ? 1 : 0)
