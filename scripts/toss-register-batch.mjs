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
// 자동(LLM) 검수는 1~17분에 끝난다(2026-10-14 실측 100여 건). 이보다 오래 걸리면 수동 검수로 넘어간 것(수 시간, 결과는 대개 반려) —
// 창(--parallel)을 붙잡고 있으면 러너가 1.5시간씩 논다. 이 시간이 지나면 창에서 빼고 계속 추적만 한다(다음 실행도 7일 창으로 이어받음).
const ESCALATE_MIN = Math.max(5, parseInt(arg('escalate-min', '25'), 10) || 25)
const PARALLEL = Math.max(1, parseInt(arg('parallel', '1'), 10) || 1) // 동시에 검수 대기시킬 최대 건수(창). 1 = 엄격한 1건씩
const MAX_FAIL = Math.max(1, parseInt(arg('max-fail', '3'), 10) || 3)
const SKIP = new Set(arg('skip', '').split(',').map((s) => s.trim()).filter(Boolean))
// 옵션 자동값(수량·중량·용량·캡슐 수)을 제목/속성에서 못 찾은 상품은 자리값("1개")으로 올리지 않고 건너뛴다(기본 on, --allow-placeholder-opts 로 끔)
const REQUIRE_OPTS = !has('allow-placeholder-opts')
const RETRY_FAILED = has('retry-failed') // 이전 실행에서 FAILED 로 남긴 spid 도 다시 후보에 넣는다(원인 수정 후)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
// 네트워크·토큰·IP·레이트리밋처럼 상품과 무관한 일시 오류 — FAILED 로 남기지 않는다
const isTransientError = (msg) => /ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|timed? ?out|fetch failed|HTTP 5\d\d|INVALID_IP|토큰|429|rate ?limit|maxBuffer|SIGTERM|killed/i.test(String(msg || ''))
/** 등록 전 단계에서 실패한 후보를 FAILED 행으로 기록(toss_product_id 없음) — 후보 선별이 이 spid 를 건너뛰고, 사람이 /admin·DB 에서 사유를 본다 */
async function markFailed(c, errMsg) {
  const { error } = await sb.from('jimscanner_toss_listings').insert({ coupang_seller_product_id: c.spid, source: c.source, name: c.name, inspection_status: 'FAILED', hidden: true, rejection_reasons: [{ title: '등록 실패', message: String(errMsg || '').slice(0, 500) }], registered_at: new Date().toISOString(), updated_at: new Date().toISOString() })
  if (error) console.log(`  (FAILED 기록 실패: ${error.message} — 다음 실행에서 같은 건을 다시 시도하게 됨)`)
}
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
  // FAILED(등록 자체가 실패해 토스에 없는 행)는 기본 제외, --retry-failed 면 다시 후보에 넣는다(toss-register.mjs 가 성공 시 FAILED 행을 지운다)
  const blocking = toss.filter((t) => !(RETRY_FAILED && t.inspection_status === 'FAILED'))
  const onToss = new Set(blocking.map((t) => Number(t.coupang_seller_product_id)).filter(Boolean))
  const tossNames = new Set(blocking.filter((t) => !['REMOVED', 'FAILED'].includes(t.inspection_status)).map((t) => normName(t.name)))
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
    // 스택 꼬리("at async …:488")가 아니라 실제 예외 메시지 줄을 남긴다 — 2026-10-14 이미지 404 크래시가 스택 꼬리로만 기록돼 원인 추적이 늦어짐
    const errLine = out.split('\n').map((l) => l.trim()).find((l) => /^(?:[A-Za-z]*Error)\b[:\s]/.test(l))
    return { ok: !!p.tossId, ...p, error: (errLine || (out || e.message).split('\n').slice(-3).join(' | ')).slice(0, 400) }
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

/** 이전 실행에서 검수 대기로 남은 최근 7일 등록분도 추적 대상에 넣는다 (--no-resume 로 끔). 첫 폴링에서 1회 확인하고, 여전히 대기면 조용히
 *  빼둔다(TIMEOUT 실패로 세지 않음) — 토스가 일부 상품을 수동 검수로 돌리면 하루 넘게 걸린다(2026-10-14 새벽 16건 3시간+ 관찰) */
async function resumePending() {
  if (has('no-resume')) return []
  const since = new Date(Date.now() - 7 * 86400_000).toISOString()
  const { data, error } = await sb.from('jimscanner_toss_listings').select('toss_product_id, coupang_seller_product_id, name, source, registered_at, last_response').eq('inspection_status', 'LLM_INSPECTION_READY').gte('registered_at', since)
  if (error) { console.log(`(검수 대기분 조회 실패: ${error.message})`); return [] }
  // 썸네일을 이미 한 번 교체한 건(last_response.lastInspectionRequestedAt)은 다시 반려돼도 재교체하지 않는다 — 2026-10-14 글루타치온이 수동 교체 후 러너가 또 교체해 4회째 반려
  return (data ?? []).map((r) => ({ spid: r.coupang_seller_product_id, name: r.name, source: r.source, tossId: r.toss_product_id, t0: Date.parse(r.registered_at) || Date.now(), resumed: true, rethumb: !!r.last_response?.lastInspectionRequestedAt }))
}

/** 최근 24h 반려분(이전 실행에서 자동 조치 안 된 것) — 시작 시 tryRecat(카테고리 불일치) / tryRethumb(여백) / tryRequant(옵션 수량) / tryRetag(검색태그 금칙어) / tryRedetail(상세 이미지 폭) 대상 */
/** 이전 회차 자동 조치가 만든 상품(재등록 tossId / 썸네일 PUT 한 tossId)과 그 단계 — 로그 jsonl 에서. 24h 창이라 어제 파일까지 본다 */
function priorSteps() {
  const map = new Map()
  for (const d of [0, 1]) {
    const day = new Date(Date.now() + 9 * 3600_000 - d * 86400_000).toISOString().slice(0, 10).replace(/-/g, '')
    let txt = ''; try { txt = readFileSync(path.join(LOG_DIR, `toss-batch-${day}.jsonl`), 'utf8') } catch { continue }
    for (const line of txt.split(/\r?\n/)) {
      if (!line.trim()) continue
      let r; try { r = JSON.parse(line) } catch { continue }
      if (!r.ok || !r.tossId || !/^(recat|requant|retag|redetail|rethumb)$/.test(r.step)) continue
      const k = String(r.tossId); if (!map.has(k)) map.set(k, new Set()); map.get(k).add(r.step)
    }
  }
  return map
}
async function pastRejects() {
  if (has('no-resume')) return []
  const since = new Date(Date.now() - 24 * 3600_000).toISOString()
  const { data, error } = await sb.from('jimscanner_toss_listings').select('toss_product_id, coupang_seller_product_id, name, source, registered_at, rejection_reasons, last_response').eq('inspection_status', 'REJECT').gte('registered_at', since)
  if (error) { console.log(`(반려분 조회 실패: ${error.message})`); return [] }
  // 이미 썸네일 교체(PUT) 한 건은 last_response.lastInspectionRequestedAt 이 남는다 → 재시도 1회 제한.
  // 이전 회차 자동 조치(재등록·PUT)로 생긴 상품이 또 같은 유형으로 반려된 것이면 그 단계는 반복하지 않는다 — 2세대 반려는 사람 몫
  // (2026-10-14 호로파: 금칙어 재등록이 같은 금칙어로 다시 반려 → 매 회차 삭제·재등록을 반복할 뻔)
  const prior = priorSteps()
  return (data ?? []).map((r) => { const ps = prior.get(String(r.toss_product_id)); return { spid: r.coupang_seller_product_id, name: r.name, source: r.source, tossId: r.toss_product_id, t0: Date.parse(r.registered_at) || Date.now(), reasons: r.rejection_reasons, recat: !!ps?.has('recat'), requant: !!ps?.has('requant'), retag: !!ps?.has('retag'), redetail: !!ps?.has('redetail'), rethumb: !!r.last_response?.lastInspectionRequestedAt || !!ps?.has('rethumb') } })
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

const isOptionReject = (reasons) => (Array.isArray(reasons) ? reasons : []).some((r) => /옵션/.test(`${r?.message ?? ''}`) && /수량|가격/.test(`${r?.message ?? ''}`))

/**
 * "옵션 정보가 잘못 입력되었어요. 옵션 수량 또는 가격 정보를 확인" 반려 → 수량 옵션이 1개가 아니면 기존 상품을 삭제하고 등록기 기본값(수량 1개 세트)으로
 * 재등록(검수 대기에 다시 넣음). spid 당 1회. 2026-10-14 09:30~09:50 수량 2개·6개 묶음 8건이 같은 사유로 연속 반려(수량>1 은 29건 중 3건만 통과).
 * 수량이 이미 1개면 가격 등 다른 원인이라 자동 조치 없이 반려로 둔다(수동 확인).
 */
async function tryRequant(p, reasons) {
  if (!isOptionReject(reasons) || p.requant) return false
  const { data: row, error: rowErr } = await sb.from('jimscanner_toss_listings').select('category_id, request_payload').eq('toss_product_id', p.tossId).maybeSingle()
  if (rowErr) { console.log(`  ↪ 옵션 반려 자동 조치 보류 — DB 조회 실패: ${rowErr.message}`); return false } // 카테고리 모른 채 삭제·재등록하지 않는다
  let opts = row?.request_payload?.stocks?.[0]?.options
  if (!Array.isArray(opts)) { try { opts = JSON.parse(p.options || '[]') } catch { opts = [] } }
  if (!Array.isArray(opts)) opts = []
  const qty = opts.find((o) => o?.groupName === '수량')?.valueName ?? null
  if (!qty || qty === '1개') { console.log(`  ↪ 옵션 반려인데 수량이 ${qty ?? '미상'} — 자동 조치 없음(가격 등 다른 원인, 수동 확인)`); return false }
  const catArgs = row?.category_id ? [`--cat=${row.category_id}`] : []
  console.log(`  ↪ 옵션 반려(수량 ${qty}) → 수량 1개(세트)로 재등록 (기존 ${p.tossId} 삭제)`)
  const dry = await dryCheck(p.spid, [...catArgs, '--force'])
  if (!dry.ok) { console.log(`  ↪ 재등록 보류(${dry.reason}) — 기존 상품 유지`); log({ spid: p.spid, name: p.name, step: 'requant', ok: false, prevQty: qty, error: dry.reason }); return false }
  const rm = await tossRemoveProduct(p.tossId)
  if (!rm.ok) { console.log(`  ↪ 기존 상품 삭제 실패: ${JSON.stringify(rm.error).slice(0, 120)}`); log({ spid: p.spid, name: p.name, step: 'requant', ok: false, prevQty: qty, error: 'remove failed' }); return false }
  const { error: dbErr } = await sb.from('jimscanner_toss_listings').update({ inspection_status: 'REMOVED', exposure_status: 'REMOVED', updated_at: new Date().toISOString() }).eq('toss_product_id', p.tossId)
  if (dbErr) console.log(`  ↪ (DB REMOVED 표시 실패: ${dbErr.message} — 토스에선 삭제됨)`)
  const reg = await runRegister(p.spid, [...catArgs, '--force'])
  log({ spid: p.spid, name: p.name, source: p.source, step: 'requant', ok: reg.ok, removedTossId: p.tossId, prevQty: qty, tossId: reg.tossId ?? null, error: reg.ok ? null : reg.error })
  if (!reg.ok) {
    // 기존 상품은 이미 삭제됨(되돌릴 수 없음, tryRecat 과 같은 설계: dryCheck 로 사전 확인) — 사람이 보도록 RECAT_FAILED 로 남긴다(후보 중복 제외 유지)
    const { error: markErr } = await sb.from('jimscanner_toss_listings').update({ inspection_status: 'RECAT_FAILED', updated_at: new Date().toISOString() }).eq('toss_product_id', p.tossId)
    console.log(`  ↪ 재등록 실패(기존 ${p.tossId} 는 삭제됨, DB ${markErr ? 'REMOVED 그대로 — RECAT_FAILED 표시 실패: ' + markErr.message : 'RECAT_FAILED'}): ${reg.error} → 수동: node scripts/toss-register.mjs --spid=${p.spid} ${catArgs.join(' ')} --force --show`)
    return false
  }
  console.log(`  ↪ 재등록 OK id=${reg.tossId} | ${reg.category} | ${reg.options}`)
  pending.push({ spid: p.spid, name: p.name, source: p.source, tossId: reg.tossId, t0: Date.now(), category: reg.category, options: reg.options, requant: true })
  return true
}

const isTagReject = (reasons) => (Array.isArray(reasons) ? reasons : []).some((r) => /금칙어/.test(`${r?.title ?? ''} ${r?.message ?? ''}`))
const parseBannedWords = (reasons) => [...new Set((Array.isArray(reasons) ? reasons : []).flatMap((r) => { const m = `${r?.message ?? ''}`.match(/금칙어\s*:\s*([^)\n]+)/); return m ? m[1].split(/[,\s/]+/).map((w) => w.trim()).filter(Boolean) : [] }))]

/**
 * "검색태그 금칙어" 반려(2026-10-14 더존건강 '명품 황제 …' 3건: "검색태그에 상품명 금칙어와 동일한 단어는 입력할 수 없어요 (금칙어: 명품)") →
 * 메시지에서 금칙어를 뽑아 기존 상품을 삭제하고 --ban=<단어> 로 재등록(등록기가 상품명·검색태그 토큰에서 제거). 토스 금칙어 목록은 비공개라
 * 반려 문구가 유일한 소스 — 등록기 기본값(명품)에 없는 단어가 나오면 이 경로로 1회 구제하고, 반복되면 등록기 NAME_BANNED 에 추가한다. spid 당 1회.
 */
async function tryRetag(p, reasons) {
  if (!isTagReject(reasons) || p.retag) return false
  const words = parseBannedWords(reasons)
  if (!words.length) { console.log(`  ↪ 금칙어 반려인데 메시지에서 단어를 못 읽음 — 수동 확인: ${JSON.stringify(reasons).slice(0, 160)}`); return false }
  // 금칙어가 상품명 토큰의 일부(호로파 ⊃ 호로)면 토큰 제거로 못 고친다 — 토스는 상품명도 부분일치로 막아(2026-10-14 호로파 60정 "상품명 / 옵션명 금칙어") 이름을 바꿔야 하므로 사람 판단
  const stuck = words.filter((w) => (p.name || '').includes(w) && !(p.name || '').split(' ').includes(w))
  if (stuck.length) { console.log(`  ↪ 금칙어(${stuck.join(', ')})가 상품명 단어 일부라 자동 제거 불가 — 상품명 변경은 수동 판단: ${p.name}`); log({ spid: p.spid, name: p.name, step: 'retag', ok: false, words, error: 'banned word inside name token' }); return false }
  const { data: row, error: rowErr } = await sb.from('jimscanner_toss_listings').select('category_id').eq('toss_product_id', p.tossId).maybeSingle()
  if (rowErr) { console.log(`  ↪ 금칙어 반려 자동 조치 보류 — DB 조회 실패: ${rowErr.message}`); return false } // 카테고리 모른 채 삭제·재등록하지 않는다
  const extra = [...(row?.category_id ? [`--cat=${row.category_id}`] : []), '--force', `--ban=${words.join(',')}`]
  console.log(`  ↪ 검색태그 금칙어(${words.join(', ')}) → 금칙어 제외하고 재등록 (기존 ${p.tossId} 삭제)`)
  const dry = await dryCheck(p.spid, extra)
  if (!dry.ok) { console.log(`  ↪ 재등록 보류(${dry.reason}) — 기존 상품 유지`); log({ spid: p.spid, name: p.name, step: 'retag', ok: false, words, error: dry.reason }); return false }
  const rm = await tossRemoveProduct(p.tossId)
  if (!rm.ok) { console.log(`  ↪ 기존 상품 삭제 실패: ${JSON.stringify(rm.error).slice(0, 120)}`); log({ spid: p.spid, name: p.name, step: 'retag', ok: false, words, error: 'remove failed' }); return false }
  const { error: dbErr } = await sb.from('jimscanner_toss_listings').update({ inspection_status: 'REMOVED', exposure_status: 'REMOVED', updated_at: new Date().toISOString() }).eq('toss_product_id', p.tossId)
  if (dbErr) console.log(`  ↪ (DB REMOVED 표시 실패: ${dbErr.message} — 토스에선 삭제됨)`)
  const reg = await runRegister(p.spid, extra)
  log({ spid: p.spid, name: p.name, source: p.source, step: 'retag', ok: reg.ok, removedTossId: p.tossId, words, tossId: reg.tossId ?? null, error: reg.ok ? null : reg.error })
  if (!reg.ok) {
    // 기존 상품은 이미 삭제됨(dryCheck 로 사전 확인한 뒤라 드묾) — 사람이 보도록 RECAT_FAILED 로 남긴다(후보 중복 제외 유지)
    const { error: markErr } = await sb.from('jimscanner_toss_listings').update({ inspection_status: 'RECAT_FAILED', updated_at: new Date().toISOString() }).eq('toss_product_id', p.tossId)
    console.log(`  ↪ 재등록 실패(기존 ${p.tossId} 는 삭제됨, DB ${markErr ? 'REMOVED 그대로 — RECAT_FAILED 표시 실패: ' + markErr.message : 'RECAT_FAILED'}): ${reg.error} → 수동: node scripts/toss-register.mjs --spid=${p.spid} ${extra.join(' ')} --show`)
    return false
  }
  console.log(`  ↪ 재등록 OK id=${reg.tossId} | ${reg.category} | ${reg.options}`)
  pending.push({ spid: p.spid, name: p.name, source: p.source, tossId: reg.tossId, t0: Date.now(), category: reg.category, options: reg.options, retag: true })
  return true
}

const isDetailReject = (reasons) => (Array.isArray(reasons) ? reasons : []).some((r) => /상세 이미지 검증 실패/.test(`${r?.title ?? ''}`) && /가로 크기/.test(`${r?.message ?? ''}`))

/**
 * "상세 이미지 검증 실패 — N번 상세 이미지 가로 크기가 최소 600 이상" 반려(2026-10-14 7건) → 등록기가 이제 600px 미만 상세컷을 확대 업로드로 교체하므로
 * 기존 상품을 삭제하고 같은 카테고리로 재등록(1회). 토스 상품 이미지는 등록 후 PUT 으로 못 바꾸는 상세컷이라 재등록이 유일한 경로. spid 당 1회.
 */
async function tryRedetail(p, reasons) {
  if (!isDetailReject(reasons) || p.redetail) return false
  const { data: row, error: rowErr } = await sb.from('jimscanner_toss_listings').select('category_id').eq('toss_product_id', p.tossId).maybeSingle()
  if (rowErr) { console.log(`  ↪ 상세 이미지 반려 자동 조치 보류 — DB 조회 실패: ${rowErr.message}`); return false }
  const extra = [...(row?.category_id ? [`--cat=${row.category_id}`] : []), '--force']
  console.log(`  ↪ 상세 이미지 가로 600px 미만 → 확대 업로드로 재등록 (기존 ${p.tossId} 삭제)`)
  const dry = await dryCheck(p.spid, extra)
  if (!dry.ok) { console.log(`  ↪ 재등록 보류(${dry.reason}) — 기존 상품 유지`); log({ spid: p.spid, name: p.name, step: 'redetail', ok: false, error: dry.reason }); return false }
  const rm = await tossRemoveProduct(p.tossId)
  if (!rm.ok) { console.log(`  ↪ 기존 상품 삭제 실패: ${JSON.stringify(rm.error).slice(0, 120)}`); log({ spid: p.spid, name: p.name, step: 'redetail', ok: false, error: 'remove failed' }); return false }
  const { error: dbErr } = await sb.from('jimscanner_toss_listings').update({ inspection_status: 'REMOVED', exposure_status: 'REMOVED', updated_at: new Date().toISOString() }).eq('toss_product_id', p.tossId)
  if (dbErr) console.log(`  ↪ (DB REMOVED 표시 실패: ${dbErr.message} — 토스에선 삭제됨)`)
  const reg = await runRegister(p.spid, extra)
  log({ spid: p.spid, name: p.name, source: p.source, step: 'redetail', ok: reg.ok, removedTossId: p.tossId, tossId: reg.tossId ?? null, error: reg.ok ? null : reg.error })
  if (!reg.ok) {
    const { error: markErr } = await sb.from('jimscanner_toss_listings').update({ inspection_status: 'RECAT_FAILED', updated_at: new Date().toISOString() }).eq('toss_product_id', p.tossId)
    console.log(`  ↪ 재등록 실패(기존 ${p.tossId} 는 삭제됨, DB ${markErr ? 'REMOVED 그대로 — RECAT_FAILED 표시 실패: ' + markErr.message : 'RECAT_FAILED'}): ${reg.error} → 수동: node scripts/toss-register.mjs --spid=${p.spid} ${extra.join(' ')} --show`)
    return false
  }
  console.log(`  ↪ 재등록 OK id=${reg.tossId} | ${reg.category} | ${reg.options}`)
  pending.push({ spid: p.spid, name: p.name, source: p.source, tossId: reg.tossId, t0: Date.now(), category: reg.category, options: reg.options, redetail: true })
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
  if (!(await tryRecat(r, r.reasons)) && !(await tryRethumb(r, r.reasons)) && !(await tryRequant(r, r.reasons)) && !(await tryRetag(r, r.reasons))) await tryRedetail(r, r.reasons)
}
let idx = 0
const settle = (p, insp) => {
  const mins = +(((Date.now() - p.t0) / 60000).toFixed(1))
  const ok = insp.inspection === 'COMPLETE'
  if (ok) { okCount++; failStreak = 0; timeoutStreak = 0 }
  else if (insp.inspection === 'TIMEOUT') timeoutStreak++ // 토스 검수 자체가 멈춘 경우 — 실패 streak 과 분리
  // 이전 실행에서 이어받은 건의 반려는 그때 설정(옵션·썸네일 규칙)의 결과라 지금 등록 설정의 문제가 아니다 — streak 에 안 셈
  // (2026-10-14 10시 수동 검수로 넘어갔던 전날 등록분이 한꺼번에 "옵션 정보" 반려로 돌아와 새 등록이 전부 통과하는데도 "연속 실패"로 멈출 뻔)
  else if (!p.resumed) failStreak++
  console.log(`  ${ok ? '✓' : '✗'} ${p.tossId} ${String(p.name || '').slice(0, 36)} — ${insp.inspection}${insp.item ? ` (${insp.item})` : ''}${insp.reasons ? ' ' + JSON.stringify(insp.reasons).slice(0, 160) : ''}${insp.err ? ` check 오류: ${insp.err}` : ''} — ${mins}분`)
  log({ spid: p.spid, name: p.name, source: p.source, step: 'inspection', tossId: p.tossId, category: p.category ?? null, options: p.options ?? null, inspection: insp.inspection, item: insp.item, reasons: insp.reasons, lastErr: insp.err ?? null, minutes: mins, resumed: !!p.resumed })
  results.push({ spid: p.spid, name: p.name, tossId: p.tossId, result: insp.inspection })
}
while (idx < plan.length || pending.length) {
  // 1) 중단 사유 없으면 빈 슬롯만큼 등록 (검수 창 = 이번 실행에서 새로 등록해 검수 대기 중인 건수. 이전 실행에서 이어받은
  //    건(resumed)은 토스 검수가 수십 분째 멈춘 것들이라 창에서 빼지 않으면 러너가 놀게 된다 — 2026-10-14 00:11 관찰)
  const fresh = () => pending.filter((p) => !p.resumed && !p.escalated).length
  while (!halt && idx < plan.length && fresh() < PARALLEL) {
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
      // 상품 자체의 문제(이미지 404·브랜드 금지어·MSP 미달·고시 불가 등)는 DB 에 FAILED 로 남겨 다음 실행 후보에서 빠지게 한다 — 안 남기면 매 실행
      // 같은 3건에서 "연속 실패 3건" 으로 멈추는 공회전(2026-10-14 감독 루프 38회 관찰). 네트워크·토큰·IP 같은 일시 오류는 남기지 않는다(재시도 대상).
      if (!isTransientError(reg.error)) await markFailed(c, reg.error)
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
      // 카테고리 불일치 → 추천 카테고리로 재등록(1회), 썸네일 "여백" → strict 패키지샷 교체 재검수(1회), 옵션(수량>1) → 수량 1개로 재등록(1회), 검색태그 금칙어 → 금칙어 제외 재등록(1회), 상세 이미지 600px 미만 → 확대 업로드 재등록(1회) — 모두 실패 streak 에 안 셈
      if (insp.inspection === 'REJECT' && (await tryRecat(p, insp.reasons) || await tryRethumb(p, insp.reasons) || await tryRequant(p, insp.reasons) || await tryRetag(p, insp.reasons) || await tryRedetail(p, insp.reasons))) continue
      settle(p, insp)
    }
    else if (Date.now() - p.t0 > WAIT_MAX_MIN * 60_000) {
      pending.splice(pending.indexOf(p), 1)
      // 이전 실행에서 이어받은 건·수동 검수로 넘어간 건은 계속 대기여도 실패·TIMEOUT 으로 세지 않고 다음 실행에 넘긴다(7일 창으로 자동 재확인)
      if (p.resumed || p.escalated) { console.log(`  ⏳ ${p.tossId} ${String(p.name || '').slice(0, 36)} — 검수 대기 지속 ${((Date.now() - p.t0) / 3600_000).toFixed(1)}시간 (다음 실행에서 재확인)`); continue }
      settle(p, { inspection: 'TIMEOUT', item: null, reasons: null, err: insp.err })
    }
    else if (!p.resumed && !p.escalated && Date.now() - p.t0 > ESCALATE_MIN * 60_000) {
      // 자동 검수 시간을 넘김 → 수동 검수 추정: 창에서 빼서(fresh() 제외) 새 등록을 계속하고, 결과는 계속 폴링한다
      p.escalated = true
      console.log(`  ⏳ ${p.tossId} ${String(p.name || '').slice(0, 36)} — ${ESCALATE_MIN}분 넘게 검수 중(수동 검수 추정) → 검수 창에서 제외, 결과는 계속 추적`)
    }
  }
  if (!halt && failStreak >= MAX_FAIL) halt = `연속 실패 ${failStreak}건`
  if (!halt && timeoutStreak >= PARALLEL) halt = `검수 대기 ${WAIT_MAX_MIN}분 초과 ${timeoutStreak}건 연속(토스 검수 지연 의심)`
}
if (halt) console.log(`\n${halt} → 등록 중단. 남은 후보 ${plan.length - idx}건 — 원인 확인 후 재실행(검수 대기분은 다음 실행이 자동으로 이어서 추적). 로그 ${LOG}`)
const fails = results.filter((r) => r.result !== 'COMPLETE')
console.log(`\n완료: 성공 ${okCount} / 실패·보류 ${fails.length} / 처리 ${results.length} — 로그 ${LOG}`)
if (fails.length) for (const f of fails) console.log(`  - ${f.spid ?? '-'} ${f.result} ${String(f.name || '').slice(0, 40)}`)
