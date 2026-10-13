#!/usr/bin/env node
/**
 * 토스쇼핑 일괄 등록 러너 — 쿠팡 판매중 리스팅 중 토스 미등록분을 "1건 등록 → 검수 완료 확인 → 다음" 으로 순차 처리.
 * (한 번에 대량 등록하지 말고 1건씩 검수 확인 후 다음 — 사장님 지시 2026-08-19. 2026-10-13 자동화)
 *
 *   node scripts/toss-register-batch.mjs --list [--limit=20]                       # 계획만 출력(등록 안 함)
 *   node scripts/toss-register-batch.mjs --limit=20 [--min-sold=0] [--sources=ggsan,upickb2b,bio77,kwholesale]
 *                                        [--parallel=1] [--wait-max=90] [--skip=spid,spid] [--max-fail=3] [--no-resume]
 *   --parallel=N : 검수 결과를 기다리는 동안 최대 N건까지 미리 등록(창). 1이면 엄격한 1건씩. 연속 실패 3건이면 등록을 멈추고 대기분만 끝까지 추적.
 *   --no-resume  : 이전 실행에서 검수 대기로 남은(최근 24h) 건을 이어서 추적하지 않음
 *
 * 후보 규칙: 쿠팡 status APPROVED · auto_paused=false · request_payload 있음 · 매입처 ∈ --sources(식품·영양제) · MSP>0(MSP 구멍 제외)
 *          · 토스 미등록(spid 기준) · 토스에 같은 상품명 없음(중복 리스팅 방지)
 * 우선순위: 최근 90일 쿠팡 판매수량 desc → 매입처 순서(--sources 순) → 쿠팡 판매가 desc
 * 각 건: toss-register.mjs --spid --show 로 등록 → --check 를 60초마다 폴링(최대 --wait-max 분) → COMPLETE/REJECT 기록
 * 중단: 연속 실패(REJECT·등록오류) --max-fail 건이면 등록 중지(썸네일 규칙 변경 등 구조적 문제), TIMEOUT 이 창 크기만큼 연속이면 토스 검수 지연으로 보고 중지
 * 로그: _workspace/toss-batch-<YYYYMMDD>.jsonl (한 줄 = 한 건)
 */
import { readFileSync, mkdirSync, appendFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createClient } from '@supabase/supabase-js'
import { tossRemoveProduct } from './lib/toss-api.mjs'
import { parseRecommendedCategory, resolveLeafByPath } from './lib/toss-categories.mjs'

const execFileP = promisify(execFile)
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..')
const env = Object.fromEntries(readFileSync(path.join(ROOT, '.env.local'), 'utf8').split(/\r?\n/).filter((l) => l && !l.startsWith('#') && l.includes('=')).map((l) => { const i = l.indexOf('='); let v = l.slice(i + 1).trim(); if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1); return [l.slice(0, i).trim(), v] }))
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY)

const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.split('=').slice(1).join('=') : d }
const has = (k) => process.argv.includes(`--${k}`)
const LIST = has('list')
const LIMIT = Math.max(1, parseInt(arg('limit', '20'), 10) || 20)
const MIN_SOLD = parseInt(arg('min-sold', '0'), 10) || 0
const SOURCES = arg('sources', 'ggsan,upickb2b,bio77,kwholesale').split(',').map((s) => s.trim()).filter(Boolean)
const WAIT_MAX_MIN = Math.max(1, parseInt(arg('wait-max', '90'), 10) || 90)
const PARALLEL = Math.max(1, parseInt(arg('parallel', '1'), 10) || 1) // 동시에 검수 대기시킬 최대 건수(창). 1 = 엄격한 1건씩
const MAX_FAIL = Math.max(1, parseInt(arg('max-fail', '3'), 10) || 3)
const SKIP = new Set(arg('skip', '').split(',').map((s) => s.trim()).filter(Boolean))
// 옵션 자동값(수량·중량·용량·캡슐 수)을 제목/속성에서 못 찾은 상품은 자리값("1개")으로 올리지 않고 건너뛴다(기본 on, --allow-placeholder-opts 로 끔)
const REQUIRE_OPTS = !has('allow-placeholder-opts')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const today = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10).replace(/-/g, '') // KST 날짜로 로그 파일명
const LOG_DIR = path.join(ROOT, '_workspace')
const LOG = path.join(LOG_DIR, `toss-batch-${today}.jsonl`)
const log = (rec) => { mkdirSync(LOG_DIR, { recursive: true }); appendFileSync(LOG, JSON.stringify({ at: new Date().toISOString(), ...rec }) + '\n') }
const normName = (s) => (s || '').replace(/\s+/g, ' ').trim().toLowerCase()

/** PostgREST 1,000행 상한 우회 — 같은 쿼리를 range 로 끝까지 읽는다(잘리면 등록분 누락 → 중복 등록 위험). */
async function fetchAll(build, orderCol = 'id') {
  const PAGE = 1000, out = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await build().order(orderCol, { ascending: true }).range(from, from + PAGE - 1)
    if (error) throw new Error(`DB 조회 실패: ${error.message}`)
    out.push(...(data ?? []))
    if ((data ?? []).length < PAGE) return out
  }
}

async function candidates() {
  const [toss, cp, orders] = await Promise.all([
    fetchAll(() => sb.from('jimscanner_toss_listings').select('id, coupang_seller_product_id, name, inspection_status')),
    fetchAll(() => sb.from('jimscanner_coupang_listings').select('id, seller_product_id, source, source_goods_no, status, registered_title, list_price_krw, msp_price_krw, auto_paused, request_payload').eq('status', 'APPROVED').eq('auto_paused', false)),
    fetchAll(() => sb.from('jimscanner_coupang_orders').select('id, seller_product_id, shipping_count, purchase_status, shipping_status').gte('ordered_at', new Date(Date.now() - 90 * 86400000).toISOString())),
  ])
  const onToss = new Set(toss.map((t) => Number(t.coupang_seller_product_id)).filter(Boolean))
  const tossNames = new Set(toss.filter((t) => t.inspection_status !== 'REMOVED').map((t) => normName(t.name)))
  const sold = new Map()
  for (const o of orders) { if (o.purchase_status === 'CANCELLED' || ['CANCEL', 'RETURNS'].includes(o.shipping_status)) continue; sold.set(o.seller_product_id, (sold.get(o.seller_product_id) || 0) + (o.shipping_count || 1)) }
  const srcRank = new Map(SOURCES.map((s, i) => [s, i]))
  return cp
    .filter((l) => SOURCES.includes(l.source) && l.request_payload && (l.msp_price_krw || 0) > 0 && !onToss.has(Number(l.seller_product_id)) && !SKIP.has(String(l.seller_product_id)))
    .filter((l) => !tossNames.has(normName(l.registered_title)))
    .map((l) => ({ spid: l.seller_product_id, source: l.source, name: l.registered_title, price: l.list_price_krw, msp: l.msp_price_krw, sold90: sold.get(l.seller_product_id) || 0 }))
    .filter((c) => c.sold90 >= MIN_SOLD)
    .sort((a, b) => b.sold90 - a.sold90 || (srcRank.get(a.source) ?? 9) - (srcRank.get(b.source) ?? 9) || (b.price || 0) - (a.price || 0))
}

function parseRegisterOutput(out) {
  const id = /등록 응답[^\n]*OK id=(\d+)/.exec(out)?.[1] ?? /토스 상품 (\d+) 등록/.exec(out)?.[1]
  const cat = /카테고리 (\d+) ([^\n]+)/.exec(out)
  const opts = /옵션 (\[[^\n]*?\]) \|/.exec(out)?.[1]
  return { tossId: id ? Number(id) : null, category: cat ? `${cat[1]} ${cat[2].trim()}` : null, options: opts ?? null }
}

async function runRegister(spid, extra = []) {
  const args = [path.join(__dirname, 'toss-register.mjs'), `--spid=${spid}`, '--show', ...(REQUIRE_OPTS ? ['--require-opts'] : []), ...extra]
  try {
    const { stdout, stderr } = await execFileP(process.execPath, args, { cwd: ROOT, timeout: 40 * 60_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true })
    const out = `${stdout}\n${stderr}`
    const p = parseRegisterOutput(out)
    return { ok: !!p.tossId, ...p, tail: out.trim().split('\n').slice(-3).join(' | ').slice(0, 400) }
  } catch (e) {
    // exit≠0 이어도 등록 API 자체는 성공했을 수 있다(후속 단계 실패) → stdout 에서 id 를 먼저 건진다. 토스엔 있는데 로그만 실패로 남는 상황 방지.
    const out = `${e.stdout || ''}\n${e.stderr || ''}`.trim()
    const p = parseRegisterOutput(out)
    const optsUnknown = /OPTS_UNKNOWN:\s*([^\n]*)/.exec(out)?.[1] ?? null
    if (!p.tossId && optsUnknown) return { ok: false, skip: 'OPTS_UNKNOWN', ...p, error: `옵션 자동값 없음(${optsUnknown.slice(0, 120)}) → 수동: --opts` }
    // 매입처 실시간 품절(ggsan 상세 확인)은 상품 문제가 아니라 재고 문제 → 건너뜀(재입고 후 다음 실행에서 자동 후보)
    if (!p.tossId && /품절 — 등록 중단/.test(out)) return { ok: false, skip: 'SOLD_OUT', ...p, error: '매입처 품절 → 건너뜀(재입고 후 자동 후보)' }
    return { ok: !!p.tossId, ...p, error: (out || e.message).split('\n').slice(-3).join(' | ').slice(0, 400) }
  }
}

// ── 검수 추적 (병렬 창) ──
/** 등록 없이 변환만(--dry) 돌려 옵션·카테고리가 채워지는지 확인. {ok, reason} */
async function dryCheck(spid, extra = []) {
  const args = [path.join(__dirname, 'toss-register.mjs'), `--spid=${spid}`, '--dry', ...(REQUIRE_OPTS ? ['--require-opts'] : []), ...extra]
  try { await execFileP(process.execPath, args, { cwd: ROOT, timeout: 10 * 60_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true }); return { ok: true } }
  catch (e) {
    const out = `${e.stdout || ''}\n${e.stderr || ''}`
    const optsUnknown = /OPTS_UNKNOWN:\s*([^\n]*)/.exec(out)?.[1]
    return { ok: false, reason: optsUnknown ? `옵션 자동값 없음(${optsUnknown.slice(0, 100)})` : out.trim().split('\n').slice(-2).join(' | ').slice(0, 200) }
  }
}

/** 단건 검수 상태 1회 조회 — toss-register.mjs --check (DB 갱신 포함) */
async function checkInspection(tossId) {
  try {
    const { stdout } = await execFileP(process.execPath, [path.join(__dirname, 'toss-register.mjs'), `--check=${tossId}`], { cwd: ROOT, timeout: 5 * 60_000, windowsHide: true })
    const inspection = /inspection=(\w+)/.exec(stdout)?.[1] ?? null
    const item = /요약: (\w+)/.exec(stdout)?.[1] ?? null
    let reasons = null
    if (inspection === 'REJECT') { const { data } = await sb.from('jimscanner_toss_listings').select('rejection_reasons').eq('toss_product_id', tossId).maybeSingle(); reasons = data?.rejection_reasons ?? null }
    return { inspection, item, reasons, err: null }
  } catch (e) { return { inspection: null, item: null, reasons: null, err: String(e.message).slice(0, 120) } }
}

/** 이전 실행에서 검수 대기로 남은 최근 24h 등록분도 추적 대상에 넣는다 (--no-resume 로 끔) */
async function resumePending() {
  if (has('no-resume')) return []
  const since = new Date(Date.now() - 24 * 3600_000).toISOString()
  const { data, error } = await sb.from('jimscanner_toss_listings').select('toss_product_id, coupang_seller_product_id, name, source, registered_at').eq('inspection_status', 'LLM_INSPECTION_READY').gte('registered_at', since)
  if (error) { console.log(`(검수 대기분 조회 실패: ${error.message})`); return [] }
  return (data ?? []).map((r) => ({ spid: r.coupang_seller_product_id, name: r.name, source: r.source, tossId: r.toss_product_id, t0: Date.parse(r.registered_at) || Date.now(), resumed: true }))
}

/** 최근 24h 반려분(이전 실행에서 자동 조치 안 된 것) — 시작 시 tryRecat(카테고리 불일치) / tryRethumb(여백) 대상 */
async function pastRejects() {
  if (has('no-resume')) return []
  const since = new Date(Date.now() - 24 * 3600_000).toISOString()
  const { data, error } = await sb.from('jimscanner_toss_listings').select('toss_product_id, coupang_seller_product_id, name, source, registered_at, rejection_reasons, last_response').eq('inspection_status', 'REJECT').gte('registered_at', since)
  if (error) { console.log(`(반려분 조회 실패: ${error.message})`); return [] }
  // 이미 썸네일 교체(PUT) 한 건은 last_response.lastInspectionRequestedAt 이 남는다 → 재시도 1회 제한
  return (data ?? []).map((r) => ({ spid: r.coupang_seller_product_id, name: r.name, source: r.source, tossId: r.toss_product_id, t0: Date.parse(r.registered_at) || Date.now(), reasons: r.rejection_reasons, rethumb: !!r.last_response?.lastInspectionRequestedAt }))
}

const isMarginReject = (reasons) => (Array.isArray(reasons) ? reasons : []).some((r) => /여백/.test(`${r?.title ?? ''}`))

/**
 * "여백"(썸네일 구도) 반려 → --rethumb --strict --apply 로 풀블리드 클린 패키지샷 재생성 + PUT 교체 → 재검수 대기. spid 당 1회.
 * (memory: 세로로 긴 구도·정사각 구도는 통과, 와이드·반사·잘림은 반려. strict = 3회 생성 중 가장 정사각에 가까운 결과를 cover 크롭)
 */
async function tryRethumb(p, reasons) {
  if (!isMarginReject(reasons) || p.rethumb) return false
  console.log(`  ↪ 썸네일 "여백" 반려 → strict 패키지샷으로 교체 재검수 (${p.tossId})`)
  const args = [path.join(__dirname, 'toss-register.mjs'), `--rethumb=${p.tossId}`, '--apply', '--strict']
  try {
    const { stdout } = await execFileP(process.execPath, args, { cwd: ROOT, timeout: 15 * 60_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true })
    const ok = /PUT 응답: OK/.test(stdout)
    log({ spid: p.spid, name: p.name, source: p.source, step: 'rethumb', ok, tossId: p.tossId, tail: stdout.trim().split('\n').slice(-2).join(' | ').slice(0, 200) })
    if (!ok) { console.log(`  ↪ 썸네일 교체 실패: ${stdout.trim().split('\n').slice(-2).join(' | ').slice(0, 160)}`); return false }
    console.log(`  ↪ 썸네일 교체 OK → 재검수 대기`)
    pending.push({ spid: p.spid, name: p.name, source: p.source, tossId: p.tossId, t0: Date.now(), category: p.category ?? null, options: p.options ?? null, rethumb: true })
    return true
  } catch (e) {
    const out = `${e.stdout || ''}\n${e.stderr || ''}`.trim().split('\n').slice(-2).join(' | ').slice(0, 200)
    log({ spid: p.spid, name: p.name, source: p.source, step: 'rethumb', ok: false, tossId: p.tossId, error: out || e.message })
    console.log(`  ↪ 썸네일 교체 실패: ${out || e.message}`)
    return false
  }
}

/**
 * "카테고리 불일치" 반려 → 토스가 추천한 경로를 leaf id 로 풀어 기존 상품 삭제 후 --cat 으로 재등록(검수 대기에 다시 넣음).
 * 사용자 요청(2026-10-13): 올리브오일 같은 일반 식품도 등록되게. 한 spid 당 1회만 시도. 성공 시 true (실패 streak 에 안 셈).
 */
async function tryRecat(p, reasons) {
  const rec = parseRecommendedCategory(reasons)
  if (!rec || p.recat) return false
  const leaf = resolveLeafByPath(rec)
  if (!leaf) { console.log(`  ↪ 추천 카테고리 해석 실패(leaf 캐시에 없음): ${rec}`); log({ spid: p.spid, name: p.name, step: 'recat', ok: false, recommended: rec, error: 'leaf not found' }); return false }
  console.log(`  ↪ 카테고리 불일치 → ${leaf.id} ${leaf.path} 로 재등록 (기존 ${p.tossId} 삭제)`)
  // 삭제 전에 새 카테고리 템플릿으로 옵션이 채워지는지 dry-run 으로 확인 — 옵션 미확보면 삭제하지 않고 반려로 둔다(수동 --opts 대상)
  const dry = await dryCheck(p.spid, [`--cat=${leaf.id}`, '--force'])
  if (!dry.ok) { console.log(`  ↪ 재등록 보류(${dry.reason}) — 기존 상품 유지`); log({ spid: p.spid, name: p.name, step: 'recat', ok: false, recommended: rec, categoryId: leaf.id, error: dry.reason }); return false }
  const rm = await tossRemoveProduct(p.tossId)
  if (!rm.ok) { console.log(`  ↪ 기존 상품 삭제 실패: ${JSON.stringify(rm.error).slice(0, 120)}`); log({ spid: p.spid, name: p.name, step: 'recat', ok: false, recommended: rec, error: 'remove failed' }); return false }
  const { error: dbErr } = await sb.from('jimscanner_toss_listings').update({ inspection_status: 'REMOVED', exposure_status: 'REMOVED', updated_at: new Date().toISOString() }).eq('toss_product_id', p.tossId)
  if (dbErr) console.log(`  ↪ (DB REMOVED 표시 실패: ${dbErr.message} — 토스에선 삭제됨, 다음 --check 가 "존재하지 않는 상품"으로 알려줌)`)
  const reg = await runRegister(p.spid, [`--cat=${leaf.id}`, '--force'])
  log({ spid: p.spid, name: p.name, source: p.source, step: 'recat', ok: reg.ok, removedTossId: p.tossId, recommended: rec, categoryId: leaf.id, tossId: reg.tossId ?? null, error: reg.ok ? null : reg.error })
  if (!reg.ok) {
    // 기존 상품은 이미 삭제됨 — 사람이 보도록 RECAT_FAILED 로 남긴다(후보 중복 제외는 유지되므로 수동: node scripts/toss-register.mjs --spid=… --cat=… --force)
    await sb.from('jimscanner_toss_listings').update({ inspection_status: 'RECAT_FAILED', updated_at: new Date().toISOString() }).eq('toss_product_id', p.tossId)
    console.log(`  ↪ 재등록 실패(기존 ${p.tossId} 는 삭제됨, DB RECAT_FAILED): ${reg.error} → 수동: node scripts/toss-register.mjs --spid=${p.spid} --cat=${leaf.id} --force --show`)
    return false
  }
  console.log(`  ↪ 재등록 OK id=${reg.tossId} | ${reg.category} | ${reg.options}`)
  pending.push({ spid: p.spid, name: p.name, source: p.source, tossId: reg.tossId, t0: Date.now(), category: reg.category, options: reg.options, recat: true })
  return true
}

const cands = await candidates()
const plan = cands.slice(0, LIMIT)
console.log(`후보 ${cands.length}건 (sources=${SOURCES.join(',')}, min-sold=${MIN_SOLD}) → 이번 실행 ${plan.length}건${LIST ? ' [계획만]' : ''} · 검수 창 ${PARALLEL}건 · 대기 최대 ${WAIT_MAX_MIN}분`)
for (const [i, c] of plan.entries()) console.log(`  ${String(i + 1).padStart(3)}. ${c.spid} ${c.source.padEnd(9)} sold90=${String(c.sold90).padStart(2)} ${String(c.price).padStart(6)}원 (MSP ${c.msp}) ${c.name.slice(0, 48)}`)
if (LIST) process.exit(0)

let okCount = 0, failStreak = 0, timeoutStreak = 0, halt = null
const results = []
const pending = await resumePending()
if (pending.length) console.log(`이전 실행의 검수 대기 ${pending.length}건 이어서 추적: ${pending.map((p) => p.tossId).join(', ')}`)
for (const r of await pastRejects()) {
  console.log(`\n이전 반려 ${r.tossId} ${String(r.name || '').slice(0, 36)} — ${JSON.stringify((r.reasons ?? []).map((x) => x?.title)).slice(0, 60)}`)
  if (!(await tryRecat(r, r.reasons))) await tryRethumb(r, r.reasons)
}
let idx = 0
const settle = (p, insp) => {
  const mins = +(((Date.now() - p.t0) / 60000).toFixed(1))
  const ok = insp.inspection === 'COMPLETE'
  if (ok) { okCount++; failStreak = 0; timeoutStreak = 0 }
  else if (insp.inspection === 'TIMEOUT') timeoutStreak++ // 토스 검수 자체가 멈춘 경우 — 실패 streak 과 분리
  else failStreak++
  console.log(`  ${ok ? '✓' : '✗'} ${p.tossId} ${String(p.name || '').slice(0, 36)} — ${insp.inspection}${insp.item ? ` (${insp.item})` : ''}${insp.reasons ? ' ' + JSON.stringify(insp.reasons).slice(0, 160) : ''}${insp.err ? ` check 오류: ${insp.err}` : ''} — ${mins}분`)
  log({ spid: p.spid, name: p.name, source: p.source, step: 'inspection', tossId: p.tossId, category: p.category ?? null, options: p.options ?? null, inspection: insp.inspection, item: insp.item, reasons: insp.reasons, lastErr: insp.err ?? null, minutes: mins, resumed: !!p.resumed })
  results.push({ spid: p.spid, name: p.name, tossId: p.tossId, result: insp.inspection })
}
while (idx < plan.length || pending.length) {
  // 1) 중단 사유 없으면 빈 슬롯만큼 등록 (검수 창 = 동시에 검수 대기시킬 최대 건수)
  while (!halt && idx < plan.length && pending.length < PARALLEL) {
    const c = plan[idx++]
    console.log(`\n[${idx}/${plan.length}] ${c.spid} ${c.name.slice(0, 40)} — 등록 중… (검수 대기 ${pending.length}건)`)
    const reg = await runRegister(c.spid)
    if (reg.skip) {
      // 옵션 자동값 없음 — 상품 문제가 아니라 제목 정보 부족이라 실패 streak 에 안 셈. 로그에 남겨 나중에 --opts 로 수동 등록
      console.log(`  ↷ 건너뜀(${reg.skip}): ${reg.error}`)
      log({ spid: c.spid, name: c.name, source: c.source, step: 'register', ok: false, skip: reg.skip, error: reg.error })
      results.push({ ...c, result: reg.skip })
      continue
    }
    if (!reg.ok) {
      failStreak++
      console.log(`  ✗ 등록 실패: ${reg.error}`)
      log({ spid: c.spid, name: c.name, source: c.source, step: 'register', ok: false, error: reg.error })
      results.push({ ...c, result: 'REGISTER_FAIL' })
      if (failStreak >= MAX_FAIL) break
      continue
    }
    console.log(`  등록 OK id=${reg.tossId} | ${reg.category} | ${reg.options}`)
    pending.push({ ...c, tossId: reg.tossId, t0: Date.now(), category: reg.category, options: reg.options })
  }
  if (!halt && failStreak >= MAX_FAIL) halt = `연속 실패 ${failStreak}건`
  if (!halt && timeoutStreak >= PARALLEL) halt = `검수 대기 ${WAIT_MAX_MIN}분 초과 ${timeoutStreak}건 연속(토스 검수 지연 의심)`
  if (halt && !pending.length) break // 더 등록 안 하고, 남은 검수 대기분은 끝까지 추적
  if (!pending.length) break
  // 2) 검수 대기분 폴링(60초)
  await sleep(60_000)
  for (const p of [...pending]) {
    const insp = await checkInspection(p.tossId)
    if (insp.inspection && insp.inspection !== 'LLM_INSPECTION_READY') {
      pending.splice(pending.indexOf(p), 1)
      // 카테고리 불일치 → 추천 카테고리로 재등록(1회), 썸네일 "여백" → strict 패키지샷 교체 재검수(1회) — 둘 다 실패 streak 에 안 셈
      if (insp.inspection === 'REJECT' && (await tryRecat(p, insp.reasons) || await tryRethumb(p, insp.reasons))) continue
      settle(p, insp)
    }
    else if (Date.now() - p.t0 > WAIT_MAX_MIN * 60_000) { pending.splice(pending.indexOf(p), 1); settle(p, { inspection: 'TIMEOUT', item: null, reasons: null, err: insp.err }) }
  }
  if (!halt && failStreak >= MAX_FAIL) halt = `연속 실패 ${failStreak}건`
  if (!halt && timeoutStreak >= PARALLEL) halt = `검수 대기 ${WAIT_MAX_MIN}분 초과 ${timeoutStreak}건 연속(토스 검수 지연 의심)`
}
if (halt) console.log(`\n${halt} → 등록 중단. 남은 후보 ${plan.length - idx}건 — 원인 확인 후 재실행(검수 대기분은 다음 실행이 자동으로 이어서 추적). 로그 ${LOG}`)
const fails = results.filter((r) => r.result !== 'COMPLETE')
console.log(`\n완료: 성공 ${okCount} / 실패·보류 ${fails.length} / 처리 ${results.length} — 로그 ${LOG}`)
if (fails.length) for (const f of fails) console.log(`  - ${f.spid ?? '-'} ${f.result} ${String(f.name || '').slice(0, 40)}`)
