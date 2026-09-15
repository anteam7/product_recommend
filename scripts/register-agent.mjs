/**
 * 쿠팡 일괄등록 큐 실행기 — 어드민 /admin/purchase-catalog 에서 체크한 상품을 실제로 등록한다.
 *   node scripts/register-agent.mjs [--once] [--poll=5000] [--batch=20]
 *
 * 구조(order-server.mjs 배치 폴러 + work-agent.mjs CAS 클레임 패턴):
 *   웹(모바일 포함) 체크 → /api/admin/register-jobs 가 jimscanner_register_jobs 에 QUEUED insert
 *   → 집 PC의 이 프로세스가 폴링 → 같은 매입처끼리 묶어 등록 스크립트를 --only= 로 1회 실행
 *   → jimscanner_coupang_listings 를 조회해 건별 성공/실패를 판정하고 잡에 기록
 *
 * 등록 자체는 각 공급처 스크립트가 담당한다(가격·카테고리·속성 공식이 공급처마다 다르므로 여기서 재구현하지 않는다).
 */
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { createClient } from '@supabase/supabase-js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.join(__dirname, '..')
const env = Object.fromEntries(readFileSync(path.join(REPO, '.env.local'), 'utf8').split(/\r?\n/).filter(l => l && !l.startsWith('#') && l.includes('=')).map(l => { const i = l.indexOf('='); let v = l.slice(i + 1).trim(); if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1); return [l.slice(0, i).trim(), v] }))
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY)

const TABLE = 'jimscanner_register_jobs'
const args = process.argv.slice(2)
const ONCE = args.includes('--once')
const argOf = k => args.find(a => a.startsWith(`--${k}=`))?.split('=')[1]
const POLL_MS = +(argOf('poll') || 5000)
const BATCH = +(argOf('batch') || 20)
const RUN_TIMEOUT_MS = +(argOf('timeout') || 30 * 60 * 1000)

// 매입처 → 등록 스크립트. 여기 없는 매입처는 잡을 FAILED 처리한다(조용히 ggsan으로 새는 사고 방지).
const SOURCE_SCRIPTS = {
  wellroot: { script: 'wellroot-register.mjs', extra: [] },
  bio77: { script: 'bio77-register.mjs', extra: [] },
  upickb2b: { script: 'upickb2b-register.mjs', extra: ['--request'] },
  ggsan: { script: 'coupang-register-batch-v2.mjs', extra: [] },
  // beseller: 네이버 전용 — 쿠팡 등록기 없음
}

const sleep = ms => new Promise(s => setTimeout(s, ms))
const nowIso = () => new Date().toISOString()

function runScript(script, scriptArgs) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [path.join(REPO, 'scripts', script), ...scriptArgs], {
      cwd: REPO, env: process.env, shell: false,
    })
    let out = ''
    const push = d => { out += d.toString(); if (out.length > 200_000) out = out.slice(-200_000) }
    child.stdout.on('data', d => { push(d); process.stdout.write(d) })
    child.stderr.on('data', d => { push(d); process.stderr.write(d) })
    const timer = setTimeout(() => { child.kill('SIGKILL'); out += `\n[register-agent] 타임아웃 ${RUN_TIMEOUT_MS}ms 초과로 강제 종료` }, RUN_TIMEOUT_MS)
    child.on('close', code => { clearTimeout(timer); resolve({ code, out }) })
    child.on('error', e => { clearTimeout(timer); resolve({ code: -1, out: out + '\n' + e.message }) })
  })
}

/** QUEUED 중 가장 오래된 잡의 매입처를 골라, 같은 매입처 잡을 BATCH 개까지 CAS로 선점한다. */
async function claimBatch() {
  const { data: head } = await sb.from(TABLE).select('id, source').eq('status', 'QUEUED').order('requested_at', { ascending: true }).limit(1)
  const source = head?.[0]?.source
  if (!source) return null
  const { data: pool } = await sb.from(TABLE).select('id, source, goods_no, attempts').eq('status', 'QUEUED').eq('source', source)
    .order('requested_at', { ascending: true }).limit(BATCH)
  const claimed = []
  for (const job of pool ?? []) {
    // CAS — 실행기를 두 개 띄워도 같은 잡을 중복 실행하지 않는다(work-agent.mjs 패턴)
    const { data: upd } = await sb.from(TABLE)
      .update({ status: 'RUNNING', started_at: nowIso(), attempts: (job.attempts ?? 0) + 1 })
      .eq('id', job.id).eq('status', 'QUEUED').select('id, source, goods_no')
    if (upd?.[0]) claimed.push(upd[0])
  }
  return claimed.length ? { source, jobs: claimed } : null
}

/** 등록 결과 판정 — listings 에 행이 생겼는지로 건별 성공/실패를 가른다. */
async function finishBatch(source, jobs, result) {
  const goodsNos = jobs.map(j => j.goods_no)
  const { data: listings } = await sb.from('jimscanner_coupang_listings')
    .select('id, source_goods_no, seller_product_id, status, rejection_reason')
    .eq('source', source).in('source_goods_no', goodsNos)
  const byGoods = new Map()
  for (const l of listings ?? []) {
    const prev = byGoods.get(l.source_goods_no)
    // SKIPPED/FAILED 보다 실제 등록된 행을 대표로
    if (!prev || (prev.status === 'SKIPPED' || prev.status === 'FAILED')) byGoods.set(l.source_goods_no, l)
  }
  const logTail = result.out.split('\n').slice(-40).join('\n').slice(-6000)
  for (const job of jobs) {
    const l = byGoods.get(job.goods_no)
    const ok = !!l && l.status !== 'FAILED' && l.status !== 'SKIPPED'
    await sb.from(TABLE).update({
      status: ok ? 'DONE' : 'FAILED',
      finished_at: nowIso(),
      seller_product_id: l?.seller_product_id ?? null,
      listing_id: l?.id ?? null,
      error: ok ? null : (l?.rejection_reason ?? (l ? `상태 ${l.status}` : `등록 결과 없음 (스크립트 종료코드 ${result.code})`)).slice(0, 1000),
      log: logTail,
    }).eq('id', job.id)
  }
  const done = jobs.filter(j => { const l = byGoods.get(j.goods_no); return l && l.status !== 'FAILED' && l.status !== 'SKIPPED' }).length
  console.log(`[register-agent] ${source} ${jobs.length}건 처리 → 성공 ${done} / 실패 ${jobs.length - done}`)
}

async function tick() {
  const claim = await claimBatch()
  if (!claim) return false
  const { source, jobs } = claim
  const conf = SOURCE_SCRIPTS[source]
  if (!conf) {
    await sb.from(TABLE).update({ status: 'FAILED', finished_at: nowIso(), error: `쿠팡 등록기가 없는 매입처(${source})` }).in('id', jobs.map(j => j.id))
    console.log(`[register-agent] ✗ ${source}: 등록기 없음 — ${jobs.length}건 실패 처리`)
    return true
  }
  const only = jobs.map(j => j.goods_no).join(',')
  console.log(`\n[register-agent] ${source} ${jobs.length}건 등록 시작 → ${conf.script} --only=${only.slice(0, 120)}${only.length > 120 ? '…' : ''}`)
  const result = await runScript(conf.script, [`--only=${only}`, ...conf.extra])
  await finishBatch(source, jobs, result)
  return true
}

console.log(`register-agent 가동 — 큐 폴링 ${POLL_MS}ms · 배치 ${BATCH}건 · cwd=${REPO}`)
if (ONCE) {
  const worked = await tick()
  if (!worked) console.log('[register-agent] 대기 중인 잡 없음')
  process.exit(0)
}
for (;;) {
  try {
    const worked = await tick()
    if (!worked) await sleep(POLL_MS)
  } catch (e) {
    console.error('[register-agent] 루프 오류:', e instanceof Error ? e.message : e)
    await sleep(POLL_MS)
  }
}
