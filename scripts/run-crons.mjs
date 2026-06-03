#!/usr/bin/env node
/**
 * 로컬 cron runner — Vercel Hobby 플랜의 cron 한도(2개) 우회용.
 *
 * vercel.json 에 정의된 12개 HTTP cron endpoint 를 순차 호출한 뒤,
 * 마지막에 classify-trends-llm 을 로컬 Claude Code CLI 로 처리한다
 * (Vercel 에선 claude 바이너리가 없어 못 돌리므로 분리).
 *
 * 사용법:
 *   node --env-file=.env.local scripts/run-crons.mjs              # 전체 실행
 *   node --env-file=.env.local scripts/run-crons.mjs <name>       # 특정 cron 만 실행
 *   node --env-file=.env.local scripts/run-crons.mjs --list       # 목록
 *   node --env-file=.env.local scripts/run-crons.mjs --no-classify  # classify 단계 생략
 *   node --env-file=.env.local scripts/run-crons.mjs --no-serp     # 쿠팡 SERP 실측 생략
 *
 * Windows Task Scheduler 등록 예 (PowerShell, 매일 KST 03:30):
 *   $action = New-ScheduledTaskAction -Execute "node.exe" `
 *     -Argument "--env-file=.env.local scripts/run-crons.mjs" `
 *     -WorkingDirectory "C:\Web\jimscanner-personal"
 *   $trigger = New-ScheduledTaskTrigger -Daily -At 3:30am
 *   Register-ScheduledTask -TaskName "jimscanner-product-recommend-crons" `
 *     -Action $action -Trigger $trigger -RunLevel Limited
 */

import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve as resolvePath } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))

const BASE_URL =
  process.env.CRON_RUNNER_BASE_URL ?? 'https://product-recommend-nine.vercel.app'

const CRONS = [
  '/api/cron/update-rates',
  '/api/cron/refresh-shipping-rates',
  '/api/cron/collect-naver-search-trends',
  '/api/cron/collect-naver-shopping-trends',
  '/api/cron/collect-google-suggest',
  '/api/cron/collect-naver-news',
  '/api/cron/collect-naver-blog',
  '/api/cron/collect-clien-park',
  '/api/cron/collect-quasarzone-sale',
  '/api/cron/collect-kca-press',
  '/api/cron/collect-gsc-daily',
  '/api/cron/collect-naver-tvtime',
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

// classify-trends-llm: 로컬 Claude CLI 단계.
//   filter 가 걸리면 (특정 cron 만 돌리는 경우) 건너뜀.
//   --no-classify 플래그도 지원.
const skipClassify = args.includes('--no-classify') || !!filter
if (!skipClassify) {
  console.log(`[${new Date().toISOString()}] launching classify-trends-llm (claude CLI)`)
  const scriptPath = resolvePath(__dirname, 'classify-trends-llm.mjs')
  const classifyExit = await new Promise((resolve) => {
    const child = spawn(process.execPath, [scriptPath], {
      stdio: 'inherit',
      env: process.env,
    })
    child.on('exit', (code) => resolve(code ?? 0))
    child.on('error', (err) => {
      console.error(`  classify spawn error: ${err.message}`)
      resolve(1)
    })
  })
  if (classifyExit !== 0) failCount++
}

// collect-coupang-serp: 로컬 Playwright 단계 (쿠팡 SERP 실측 → competition_score 접지).
//   Vercel 엔 헤드리스 브라우저가 없어 로컬에서만 돈다. classify 와 동일하게
//   filter 가 걸리거나 --no-serp 플래그면 건너뜀.
const skipSerp = args.includes('--no-serp') || !!filter
if (!skipSerp) {
  console.log(`[${new Date().toISOString()}] launching collect-coupang-serp (쿠팡 SERP 실측)`)
  const serpPath = resolvePath(__dirname, 'collect-coupang-serp.mjs')
  const serpExit = await new Promise((resolve) => {
    const child = spawn(process.execPath, [serpPath], {
      stdio: 'inherit',
      env: process.env,
    })
    child.on('exit', (code) => resolve(code ?? 0))
    child.on('error', (err) => {
      console.error(`  serp spawn error: ${err.message}`)
      resolve(1)
    })
  })
  if (serpExit !== 0) failCount++
}

process.exit(failCount > 0 ? 1 : 0)
