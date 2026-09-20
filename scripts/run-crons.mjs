#!/usr/bin/env node
/**
 * 로컬 cron runner — Vercel Hobby 플랜의 cron 한도 우회용.
 *
 * 현재는 환율(update-rates — 이 배포의 HTTP cron)과 배대지 요율(refresh-shipping-rates — 메인 레포의
 * 수집 배치를 로컬에서 실행, 2026-09-20~) 갱신을 수행한다. (트렌드 수집/LLM 분류 cron은 비활성화되어 제거됨)
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
]

// 배대지 요율 수집(refresh-shipping-rates)은 HTTP 호출이 아니라 **메인 레포의 수집 배치**를 돌린다 (2026-09-20 사장님 지시).
//   예전에는 이 배포(product-recommend-nine)의 /api/cron/refresh-shipping-rates 를 불렀는데, 이 레포의 수집기 사본이 낡아서
//   메인에서 고친 요율을 매일 03:30 에 되돌렸다 — 해운 요금을 '항공'으로 싣고(10곳), 몰테일 일본·중국에 NJ 행을 다시 넣고,
//   메인에서 꺼 둔 bidpot 을 계속 받고, 급변 가드도 없다. 수집기는 메인 레포 한 곳에만 둔다.
//   다른 단계(환율·ops-sweep·소싱·비셀러)의 순서·시각에 영향이 없도록 **맨 마지막**에 돌린다(파일 끝 참고).
const LOCAL_STEPS = ['refresh-shipping-rates']
const MAIN_REPO = process.env.JIMSCANNER_MAIN_REPO ?? 'C:/Web/jimscanner/jimpass-agent-platform'

const SECRET = process.env.CRON_SECRET
if (!SECRET) {
  console.error('CRON_SECRET missing. Did you run with --env-file=.env.local ?')
  process.exit(1)
}

const args = process.argv.slice(2)
if (args.includes('--list')) {
  console.log('Registered cron endpoints:')
  for (const p of CRONS) console.log(`  ${p}`)
  console.log('Local steps (메인 레포 배치):')
  for (const s of LOCAL_STEPS) console.log(`  ${s}`)
  process.exit(0)
}

const filter = args[0]
const matches = (name) => name.endsWith(filter) || name === filter || name.includes(filter)
const targets = filter ? CRONS.filter(matches) : CRONS
// 이름을 지정해 돌릴 때는 그 단계만 — 지정이 없으면 전부
const runShippingRates = filter ? LOCAL_STEPS.some(matches) : true

if (targets.length === 0 && !runShippingRates) {
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

// ops-sweep 루프: cron 완료 후 자동 실행 (Loop Engineering L1)
async function runOpsLoop() {
  try {
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    const execFileAsync = promisify(execFile)
    const scriptPath = new URL('./local-loop-ops-sweep.mjs', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1')
    const envFilePath = new URL('../.env.local', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1')
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [`--env-file=${envFilePath}`, scriptPath],
      { timeout: 60_000 }
    )
    if (stdout) process.stdout.write(stdout)
    if (stderr) process.stderr.write(stderr)
  } catch (e) {
    console.error('[ops-loop] 실행 실패:', e instanceof Error ? e.message : String(e))
  }
}

// 위탁 소싱 도출 루프: 짐스캐너 트렌드 → 도매매(위탁) → 시장가 → 마진 후보 갱신 (cron 완료 후)
// 쿠팡 CDP(9222)가 안 떠 있으면 스크립트가 자동으로 네이버 시장가만 사용한다.
async function runSourcingLoop() {
  try {
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    const execFileAsync = promisify(execFile)
    const scriptPath = new URL('./domeme-sourcing-from-trends.mjs', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1')
    const envFilePath = new URL('../.env.local', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1')
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [`--env-file=${envFilePath}`, scriptPath, '--days=14', '--limit=200', '--max-per-kw=5'],
      { timeout: 600_000, maxBuffer: 16 * 1024 * 1024 },
    )
    if (stdout) process.stdout.write(stdout)
    if (stderr) process.stderr.write(stderr)
  } catch (e) {
    console.error('[sourcing-loop] 실행 실패:', e instanceof Error ? e.message : String(e))
  }
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

// ops-sweep 루프 자동 실행 (Loop Engineering: cron 완료 후 건강 상태 기록)
console.log(`[${new Date().toISOString()}] ops-sweep 루프 시작...`)
try {
  await runOpsLoop()
} catch (e) {
  console.error('[ops-loop] 예상치 못한 오류:', e instanceof Error ? e.message : String(e))
}

// 위탁 소싱 도출 루프 자동 실행 (트렌드 → 도매매 → 시장가 → 마진 후보)
console.log(`[${new Date().toISOString()}] 위탁 소싱 도출 루프 시작...`)
try {
  await runSourcingLoop()
} catch (e) {
  console.error('[sourcing-loop] 예상치 못한 오류:', e instanceof Error ? e.message : String(e))
}

// 비셀러 품절 갱신 (일 1회 — 목록스캔+미노출 상세확인, beseller-stock-refresh.mjs)
console.log(`[${new Date().toISOString()}] 비셀러 품절 갱신 시작...`)
try {
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const execFileAsync = promisify(execFile)
  const scriptPath = new URL('./beseller-stock-refresh.mjs', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1')
  const envFilePath = new URL('../.env.local', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1')
  const { stdout, stderr } = await execFileAsync(
    process.execPath,
    [`--env-file=${envFilePath}`, scriptPath],
    { timeout: 900_000, maxBuffer: 16 * 1024 * 1024 },
  )
  if (stdout) process.stdout.write(stdout)
  if (stderr) process.stderr.write(stderr)
} catch (e) {
  console.error('[beseller-refresh] 실행 실패:', e instanceof Error ? e.message : String(e))
}

// 배대지 요율 수집 — 메인 레포의 배치를 그대로 돌린다(맨 위 LOCAL_STEPS 주석 참고). 맨 마지막이라 앞 단계에 영향이 없다.
//   --days 0 = 수집기가 있는 배대지 전부. 메인의 수집기·급변 가드·WSL/Windows 실행 분기를 그대로 쓴다.
//   메인의 04:30 작업(JimScanner Rate Refresh Daily)은 여기서 못 받은 곳만 다시 받는 안전망으로 남는다.
if (runShippingRates) {
  console.log(`[${new Date().toISOString()}] 배대지 요율 수집(메인 레포 배치) 시작...`)
  const startedAt = Date.now()
  try {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const { spawn } = await import('node:child_process')
    const script = path.join(MAIN_REPO, 'scripts', 'cron', 'refresh-stale-rates-daily.mjs')
    if (!fs.existsSync(script)) throw new Error(`메인 레포 배치를 찾지 못했습니다: ${script}`)

    // 이 러너는 personal 레포의 .env.local 을 물고 돈다. 메인 배치의 하위 실행기는 "이미 있는 환경변수는 덮어쓰지 않는다" —
    // 그대로 넘기면 메인 배치가 personal 쪽 키로 돌 수 있으므로, 이 레포 .env.local 에서 온 키는 빼고 넘긴다(메인이 자기 .env.local 을 읽는다).
    const childEnv = { ...process.env }
    try {
      const text = fs.readFileSync(new URL('../.env.local', import.meta.url), 'utf8')
      for (const line of text.split(/\r?\n/)) {
        const i = line.indexOf('=')
        if (i > 0 && !line.trimStart().startsWith('#')) delete childEnv[line.slice(0, i).trim()]
      }
    } catch (e) {
      // .env.local 을 못 읽으면 그대로 넘긴다 — 메인 배치는 자기 .env.local 로 DB 에 붙는다
      console.error('[shipping-rates] 이 레포 .env.local 을 읽지 못해 환경변수를 그대로 넘깁니다:', e instanceof Error ? e.message : String(e))
    }

    const code = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [script, '--days', '0'], { cwd: MAIN_REPO, env: childEnv, stdio: ['ignore', 'inherit', 'inherit'] })
      const timer = setTimeout(() => {
        // 배치는 하위 프로세스(npx → tsx → node, 브라우저)를 띄운다 — Windows 에서는 트리째 끝내야 남는 게 없다
        if (process.platform === 'win32' && child.pid) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
        else child.kill('SIGTERM')
        reject(new Error('45분 안에 끝나지 않아 중단했습니다'))
      }, 45 * 60_000)
      child.on('error', (e) => {
        clearTimeout(timer)
        reject(e)
      })
      child.on('close', (c) => {
        clearTimeout(timer)
        resolve(c)
      })
    })
    const tag = code === 0 ? 'OK ' : 'ERR'
    console.log(`  ${tag} exit=${code} ${String(Date.now() - startedAt).padStart(6)}ms  refresh-shipping-rates (메인 레포 배치)`)
    if (code !== 0) failCount++
  } catch (e) {
    failCount++
    console.error('[shipping-rates] 실행 실패:', e instanceof Error ? e.message : String(e))
  }
}

process.exit(failCount > 0 ? 1 : 0)
