/**
 * 쿠팡 파트너스 상품 검색(candidates) 대기열 — 링크 브로커(C:/Web/coupang_partners_link)가 가져가는 계약 v2 의 프로젝트 쪽.
 * 우리는 파트너스 API 를 직접 부르지 않는다(같은 계정 한도를 브로커 한 곳에서 지킨다). 계약: 브로커 docs/contracts/coupang-partner-links-v2.md
 *
 *   node --env-file=.env.local scripts/partners-price-queue.mjs serve           # 127.0.0.1:39211 — 브로커가 5분마다 GET/PUT
 *   node --env-file=.env.local scripts/partners-price-queue.mjs add <targets.json>  # [{ id, keyword, limit?, meta? }] 추가(같은 id 는 입력 갱신)
 *   node --env-file=.env.local scripts/partners-price-queue.mjs status
 *
 * 속도: 최근 5분 안에 쿠팡을 실제로 부른 결과(processedAt 기준)가 PER_WINDOW 건이면 목록을 비워 낸다(평균 30초에 1건).
 * 저장: _workspace/partners-price/queue.json(대상·결과) + results.jsonl(받은 결과 원본 누적).
 */
import http from 'node:http'
import crypto from 'node:crypto'
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, appendFileSync, openSync, closeSync, statSync, unlinkSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DIR = path.join(ROOT, '_workspace', 'partners-price')
const QUEUE = path.join(DIR, 'queue.json')
const RESULTS = path.join(DIR, 'results.jsonl')
const LOG = path.join(DIR, 'server.log')
const PROJECT = 'jimscanner-personal'
const CONTRACT = 'coupang-partner-links/v2'
const PORT = 39211
// 브로커는 5분마다 오므로 직전 회차 결과(4~5분 전)는 창 밖이어야 한다 — 5분 창이면 한 회차씩 건너뛰어 실제로는 1분에 1건이 됐다(2026-11-05 실측)
const WINDOW_MS = 3 * 60 * 1000
const PER_WINDOW = 10 // 30초에 1건(사장님 2026-11-05 "30초나 20초에 한 번도 돼"). 브로커 회차당 20회 상한을 짐스캐너(회차당 ~6회)와 나눠 쓰므로 20초(15건)는 짐스캐너 몫을 깎는다
const STATUSES = new Set(['OK', 'NOT_LINKABLE', 'FAILED', 'INVALID_REQUEST'])

mkdirSync(DIR, { recursive: true })
const oneLine = (s) => String(s).replace(/[\r\n]+/g, ' ')
const log = (s) => appendFileSync(LOG, `${new Date().toISOString()} ${oneLine(s)}\n`)
const load = () => (existsSync(QUEUE) ? JSON.parse(readFileSync(QUEUE, 'utf8')) : { targets: {}, records: {} })
function save(q) { const tmp = `${QUEUE}.${process.pid}.tmp`; writeFileSync(tmp, JSON.stringify(q)); renameSync(tmp, QUEUE) }
const BAD_IDS = new Set(['__contract_check__', '__proto__', 'constructor', 'prototype'])

// serve(PUT)와 add 가 다른 프로세스에서 queue.json 을 읽고 고쳐 쓰므로 잠금 파일로 직렬화한다
const LOCK = QUEUE + '.lock'
function withLock(fn) {
  const until = Date.now() + 10000
  for (;;) {
    try { closeSync(openSync(LOCK, 'wx')); break } catch (e) {
      if (e.code !== 'EEXIST') throw e
      try { if (Date.now() - statSync(LOCK).mtimeMs > 30000) { unlinkSync(LOCK); continue } } catch { /* 방금 풀림 */ }
      if (Date.now() > until) throw new Error('대기열 잠금 대기 10초 초과')
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50)
    }
  }
  try { return fn() } finally { try { unlinkSync(LOCK) } catch { /* 이미 없음 */ } }
}

/** 계약 7절 — 결과가 아직 필요한가 */
function needsResult(t, rec, now) {
  if (!rec || rec.keyword !== t.keyword) return true
  if (rec.status === 'OK') return false
  return !!rec.retryAfter && Date.parse(rec.retryAfter) <= now
}

function requestList(q, now) {
  // 쿠팡을 실제로 부른 결과만 센다 — 브로커 캐시(6시간) 재전송은 processedAt 이 처음 시각이라 창 밖으로 빠진다
  const recent = Object.values(q.records).filter((r) => r.processedAt && now - Date.parse(r.processedAt) < WINDOW_MS).length
  // 먼저 넣은 묶음부터, 같은 묶음 안에서는 파일 순서(order)대로 — 순서가 곧 우선순위
  const pending = Object.entries(q.targets).filter(([id, t]) => needsResult(t, q.records[id], now))
    .sort((a, b) => (a[1].addedAt < b[1].addedAt ? -1 : a[1].addedAt > b[1].addedAt ? 1 : (a[1].order ?? 0) - (b[1].order ?? 0) || (a[0] < b[0] ? -1 : 1)))
  return { pending, room: Math.max(0, PER_WINDOW - recent) }
}

function tokenOk(req) {
  const want = process.env.PARTNERS_LINKS_TOKEN || ''
  const got = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '')
  if (want.length < 32 || got.length !== want.length) return false
  return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want))
}

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(body === undefined ? '' : JSON.stringify(body))
}
const bad = (res, code, message, status = 400) => send(res, status, { error: { code, message } })

function readBody(req, max = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = []
    req.on('data', (c) => { size += c.length; if (size > max) { reject(new Error('본문 1MB 초과')); req.destroy() } else chunks.push(c) })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

const linkOk = (u) => typeof u === 'string' && u.startsWith('https://link.coupang.com/')
function resultShapeOk(r) {
  if (!STATUSES.has(r.status)) return false
  if (r.status !== 'OK') return true
  return Array.isArray(r.candidates) && r.candidates.length <= 10
    && r.candidates.every((c) => Number.isFinite(Number(c.productId)) && typeof c.productName === 'string' && Number.isFinite(Number(c.productPrice)) && (c.productUrl == null || linkOk(c.productUrl)))
}

async function handle(req, res) {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`)
  if (url.pathname !== '/api/partner-links/requests' && url.pathname !== '/api/partner-links/results') return send(res, 404)
  if (!tokenOk(req)) return bad(res, 'UNAUTHORIZED', '토큰 없음 또는 틀림', 401)

  if (req.method === 'GET' && url.pathname === '/api/partner-links/requests') {
    const limitRaw = url.searchParams.get('limit')
    const limit = limitRaw == null ? 50 : Number(limitRaw)
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) return bad(res, 'BAD_REQUEST', 'limit 은 1~100 정수')
    const types = url.searchParams.has('types') ? url.searchParams.get('types').split(',').map((s) => s.trim()) : ['url', 'keyword', 'candidates']
    let q
    try { q = load() } catch (e) { return bad(res, 'UNAVAILABLE', `대기열을 읽지 못함: ${e.message}`, 503) }
    const now = Date.now()
    const { pending, room } = types.includes('candidates') ? requestList(q, now) : { pending: [], room: 0 }
    const requests = pending.slice(0, Math.min(limit, room)).map(([id, t]) => ({ id, type: 'candidates', keyword: t.keyword, limit: t.limit ?? 10 }))
    log(`GET limit=${limit} types=${types.join(',')} → ${requests.length}건 (대기 ${pending.length}, 이번 5분 여유 ${room})`)
    return send(res, 200, { contract: CONTRACT, project: PROJECT, requests, pending: Math.max(pending.length, requests.length) })
  }

  if (req.method === 'PUT' && url.pathname === '/api/partner-links/results') {
    let body
    try { body = JSON.parse(await readBody(req)) } catch (e) { return bad(res, 'BAD_REQUEST', `JSON 아님 또는 너무 큼: ${e.message}`) }
    // 4.5-1 본문 전체 검사 — 하나라도 어긋나면 아무것도 반영하지 않는다
    const results = body?.results
    if (body?.contract !== CONTRACT || body?.project !== PROJECT) return bad(res, 'BAD_REQUEST', 'contract 또는 project 불일치')
    if (!Array.isArray(results) || results.length < 1 || results.length > 50) return bad(res, 'BAD_REQUEST', 'results 는 1~50개 배열')
    const seen = new Set()
    for (const r of results) {
      if (typeof r?.id !== 'string' || typeof r?.type !== 'string' || typeof r?.status !== 'string') return bad(res, 'BAD_REQUEST', 'id·type·status 는 문자열')
      if (seen.has(r.id)) return bad(res, 'BAD_REQUEST', `같은 id 두 번: ${r.id}`)
      seen.add(r.id)
    }
    // 4.5-2 항목별 판정 → 4.5-4 받아들인 항목을 한 번에 저장(전부 아니면 전무). 판정과 저장을 같은 잠금 안에서
    const accepted = [], rejected = [], keep = []
    try {
      withLock(() => {
        const q = load()
        for (const r of results) {
          const t = Object.hasOwn(q.targets, r.id) ? q.targets[r.id] : null
          if (!t || BAD_IDS.has(r.id)) rejected.push({ id: r.id, reason: 'UNKNOWN_ID' })
          else if (r.type !== 'candidates' || r.keyword !== t.keyword) rejected.push({ id: r.id, reason: 'STALE' })
          else if (!resultShapeOk(r)) rejected.push({ id: r.id, reason: 'INVALID' })
          else { accepted.push(r.id); keep.push(r) }
        }
        if (!keep.length) return
        const receivedAt = new Date().toISOString()
        for (const r of keep) {
          q.records[r.id] = { keyword: r.keyword, status: r.status, processedAt: r.processedAt ?? null, retryAfter: r.retryAfter ?? null, message: r.message ?? null, candidates: r.candidates ?? null, receivedAt }
        }
        save(q)
        appendFileSync(RESULTS, keep.map((r) => JSON.stringify({ receivedAt, ...r })).join('\n') + '\n')
      })
    } catch (e) { log(`PUT 저장 실패: ${e.message}`); return bad(res, 'UNAVAILABLE', '저장 실패', 503) }
    log(`PUT ${results.length}건 → 수락 ${accepted.length} · 거절 ${rejected.length}${rejected.length ? ` (${rejected.map((x) => `${x.id}:${x.reason}`).join(', ').slice(0, 200)})` : ''}`)
    return send(res, 200, { accepted, rejected })
  }
  return send(res, 404)
}

const [cmd, arg] = process.argv.slice(2)
if (cmd === 'serve') {
  if ((process.env.PARTNERS_LINKS_TOKEN || '').length < 32) { console.error('.env.local PARTNERS_LINKS_TOKEN(32자 이상) 필요'); process.exit(64) }
  const server = http.createServer((req, res) => { handle(req, res).catch((e) => { log(`오류 ${e.message}`); if (!res.headersSent) bad(res, 'UNAVAILABLE', '처리 오류', 503) }) })
  server.on('error', (e) => { console.error(`[partners-price-queue] 서버 오류: ${e.code === 'EADDRINUSE' ? `포트 ${PORT} 사용 중(이미 실행 중?)` : e.message}`); process.exit(1) })
  server.listen(PORT, '127.0.0.1', () => { log(`serve 127.0.0.1:${PORT}`); console.log(`[partners-price-queue] 127.0.0.1:${PORT} 대기 — 로그 ${LOG}`) })
} else if (cmd === 'add') {
  if (!arg) { console.error('사용법: add <targets.json>'); process.exit(64) }
  const list = JSON.parse(readFileSync(arg, 'utf8'))
  if (!Array.isArray(list)) { console.error('targets.json 은 [{ id, keyword, limit?, meta? }] 배열이어야 함'); process.exit(64) }
  const now = new Date().toISOString()
  let added = 0, changed = 0, skipped = 0, total = 0
  withLock(() => {
    const q = load()
    for (const [i, t] of list.entries()) {
      const keyword = String(t?.keyword ?? '').trim()
      if (typeof t?.id !== 'string' || !t.id || t.id.length > 200 || BAD_IDS.has(t.id) || !keyword || keyword.length > 100) { skipped++; continue }
      const prev = Object.hasOwn(q.targets, t.id) ? q.targets[t.id] : null
      if (!prev) added++; else if (prev.keyword !== keyword) changed++
      q.targets[t.id] = { keyword, limit: Math.min(10, Math.max(1, Number(t.limit) || 10)), meta: t.meta ?? prev?.meta ?? null, addedAt: prev?.addedAt ?? now, order: prev?.order ?? i }
    }
    save(q)
    total = Object.keys(q.targets).length
  })
  console.log(`추가 ${added} · 검색어 변경 ${changed} · 건너뜀 ${skipped} · 전체 대상 ${total}`)
} else if (cmd === 'status') {
  const q = load(), now = Date.now()
  const { pending, room } = requestList(q, now)
  const recs = Object.values(q.records)
  const byStatus = recs.reduce((a, r) => ((a[r.status] = (a[r.status] ?? 0) + 1), a), {})
  console.log(`대상 ${Object.keys(q.targets).length} · 결과 ${recs.length} ${JSON.stringify(byStatus)} · 대기 ${pending.length} · 이번 5분 여유 ${room}`)
} else {
  console.error('사용법: serve | add <targets.json> | status'); process.exit(64)
}
