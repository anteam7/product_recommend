/**
 * 루프 엔지니어링 — Master Orchestrator (쿠팡)
 * Sense → Act → Report 순서로 실행
 *
 * 실행:
 *   node scripts/loop-master-coupang.mjs           # APPLY
 *   node scripts/loop-master-coupang.mjs --dry      # DRY-RUN
 *
 * Windows Task Scheduler 등록 예 (매일 KST 04:00):
 *   $action = New-ScheduledTaskAction -Execute "node.exe" `
 *     -Argument "scripts/loop-master-coupang.mjs" `
 *     -WorkingDirectory "C:\Web\jimscanner-personal"
 *   $trigger = New-ScheduledTaskTrigger -Daily -At 4:00am
 *   Register-ScheduledTask -TaskName "jimscanner-loop-coupang" `
 *     -Action $action -Trigger $trigger -RunLevel Limited
 */
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { createClient } from '@supabase/supabase-js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

let raw
try {
  raw = readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8')
} catch (e) {
  console.error('.env.local 읽기 실패:', e.message); process.exit(1)
}
const env = Object.fromEntries(
  raw.split(/\r?\n/)
    .filter(l => l && !l.startsWith('#') && l.includes('='))
    .map(l => {
      const i = l.indexOf('=')
      let v = l.slice(i + 1).trim()
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
      return [l.slice(0, i).trim(), v]
    })
)

for (const key of ['NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']) {
  if (!env[key]) { console.error(`env 누락: ${key}`); process.exit(1) }
}

const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY)
const DRY = process.argv.includes('--dry')
const NODE = process.execPath

function run(scriptName, extraArgs = []) {
  const scriptPath = path.join(__dirname, scriptName)
  console.log(`\n▶ ${scriptName}`)
  const result = spawnSync(NODE, [scriptPath, ...extraArgs], {
    stdio: 'inherit',
    cwd: path.join(__dirname, '..'),
    env: process.env,
  })
  if (result.error) {
    console.error(`  스크립트 실행 오류: ${result.error.message}`)
    return false
  }
  if (result.status !== 0) {
    console.error(`  종료 코드 ${result.status}`)
    return false
  }
  return true
}

const t0 = Date.now()
console.log(`\n${'='.repeat(60)}`)
console.log(`Loop Master — 쿠팡 ${DRY ? '[DRY-RUN]' : '[APPLY]'}`)
console.log(`시작: ${new Date().toLocaleString('ko-KR')}`)
console.log('='.repeat(60))

// 1. Sense
const senseOk = run('loop-sense-coupang.mjs')
if (!senseOk) console.error('\n[WARN] Sense 실패 — Act는 이전 큐로 계속 진행')

// 2. Act
const actArgs = DRY ? ['--dry'] : []
const actOk = run('loop-act-coupang.mjs', actArgs)
if (!actOk) console.error('\n[WARN] Act 단계 실패')

// 3. Report
console.log('\n▶ Report')
const { data: stats, error: statsErr } = await sb
  .from('jimscanner_loop_action_queue')
  .select('action_type, status')
  .eq('market', 'coupang')

if (statsErr) {
  console.error('  리포트 조회 실패:', statsErr.message)
} else {
  const rows = stats ?? []
  const count = (s) => rows.filter(r => r.status === s).length
  const pending     = count('pending')
  const inProgress  = count('in_progress')
  const done        = count('done')
  const humanReview = count('human_review')
  const failed      = count('failed')

  console.log(`\n  대기(pending)    : ${pending}`)
  console.log(`  진행중           : ${inProgress}`)
  console.log(`  완료(done)       : ${done}`)
  console.log(`  검토 필요        : ${humanReview}`)
  console.log(`  실패             : ${failed}`)

  if (humanReview > 0) {
    console.log('\n  ── 인간 검토 필요 항목 ──')
    const { data: hr } = await sb
      .from('jimscanner_loop_action_queue')
      .select('action_type, product_name, error_msg, retry_count')
      .eq('market', 'coupang')
      .eq('status', 'human_review')
      .order('priority', { ascending: false })
      .limit(10)
    for (const r of hr ?? []) {
      const msg = r.error_msg ? ` | ${r.error_msg.slice(0, 60)}` : ''
      console.log(`  🔴 [${r.action_type}] ${(r.product_name ?? '').slice(0, 50)}${msg}`)
    }
  }
}

const elapsed = ((Date.now() - t0) / 1000).toFixed(1)
console.log(`\n${'='.repeat(60)}`)
console.log(`완료: ${elapsed}s | ${new Date().toLocaleString('ko-KR')}`)
console.log('='.repeat(60))
