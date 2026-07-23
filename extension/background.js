/**
 * 쿠팡 소싱 스카우트 — MV3 service worker (오케스트레이터).
 * 릴레이 폴링(/api/ext/scout/poll) → 명령 실행(콘텐츠 스크립트 지휘) → 결과 청크 업로드(/result).
 * 수명 대응: 유휴=chrome.alarms 30초, 작업 중=루프의 await 체인이 SW 유지. 전 상태 chrome.storage 체크포인트.
 * 프로토콜: docs/scout-protocol.md
 */
import { getSettings, getSelectors } from './lib/settings.js'
import { poll, postResult } from './lib/api.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const jitter = (base, spread) => base + Math.random() * spread
const NAV_TIMEOUT = 35000
const PAGE_JITTER = () => jitter(8000, 4000)      // 페이지 전환 간 8~12초 (검증된 정책)
const SETTLE = () => jitter(1800, 1200)

// ── 차단 회피 페이싱 (쿠팡 Akamai 는 ~20회 급속 검색이면 차단; 느리게·상한·백오프로 지속 가능하게) ──
const COLLECT_TYPES = ['collect_list', 'collect_detail', 'collect_reviews', 'extract_images']
const PACE = {
  keywordCooldownMs: () => jitter(40000, 35000),   // 수집 명령(키워드) 사이 40~75초
  detailCooldownMs: () => jitter(11000, 9000),     // 상세 페이지 사이 11~20초
  blockBackoffMin: [30, 40, 60, 90],               // 차단 시 누적 대기(분) — 첫 차단부터 30분+ (사용자 지정 2026-07-23)
  volumeCap: 12,                                   // 연속 수집 12건 후 장기 휴식
  longRestMs: () => jitter(720000, 360000),        // 장기 휴식 12~18분
}
let blockedThisCmd = false // 이번 명령이 차단을 만났는지(afterCollect 에서 스트릭 리셋 판단)

async function getPacing() {
  const { pacing } = await st.get('pacing')
  return pacing || { cooldownUntil: 0, consecutiveBlocks: 0, collectsSinceRest: 0 }
}
async function setPacing(patch) { const p = await getPacing(); await st.set({ pacing: { ...p, ...patch } }) }

// 차단 감지 → 누적 백오프 대기 설정(전체 큐가 이 시각까지 대기)
async function onBlocked() {
  blockedThisCmd = true
  const p = await getPacing()
  const idx = Math.min(p.consecutiveBlocks, PACE.blockBackoffMin.length - 1)
  const mins = PACE.blockBackoffMin[idx]
  await setPacing({ consecutiveBlocks: p.consecutiveBlocks + 1, cooldownUntil: Date.now() + mins * 60000 })
  notifyPanel({ type: 'progress', ev: { note: `🚫 쿠팡 차단 감지 — ${mins}분 대기 후 자동 재개(백오프)` } })
}

// 수집 명령 종료 후 페이싱 갱신: 성공이면 스트릭 리셋 + 키워드 쿨다운, 상한 도달 시 장기 휴식
async function afterCollect(cmd) {
  if (!COLLECT_TYPES.includes(cmd.command_type)) return
  if (blockedThisCmd) return // onBlocked 가 이미 더 긴 쿨다운을 잡아둠
  const p = await getPacing()
  const collects = p.collectsSinceRest + 1
  if (collects >= PACE.volumeCap) {
    await setPacing({ consecutiveBlocks: 0, collectsSinceRest: 0, cooldownUntil: Date.now() + PACE.longRestMs() })
    notifyPanel({ type: 'progress', ev: { note: `😴 ${PACE.volumeCap}건 수집 완료 — 차단 예방 장기 휴식(12~18분)` } })
  } else {
    await setPacing({ consecutiveBlocks: 0, collectsSinceRest: collects, cooldownUntil: Date.now() + PACE.keywordCooldownMs() })
  }
}

const st = {
  async get(keys) { return chrome.storage.local.get(keys) },
  async set(obj) { return chrome.storage.local.set(obj) },
}

let jobActive = false
let lastPollAt = 0

// ── 패널 알림(열려있을 때만 수신됨) ──
function notifyPanel(ev) { chrome.runtime.sendMessage({ ns: 'scout-ui-ev', ...ev }).catch(() => {}) }

// ── 진행/ack 큐 (다음 poll 에 동봉) ──
async function enqueueProgress(ev) {
  const { pendingProgress = [] } = await st.get('pendingProgress')
  pendingProgress.push({ ...ev, ts: new Date().toISOString() })
  await st.set({ pendingProgress: pendingProgress.slice(-50) })
  notifyPanel({ type: 'progress', ev })
}
async function enqueueAck(id) {
  const { pendingAcks = [] } = await st.get('pendingAcks')
  if (!pendingAcks.includes(id)) pendingAcks.push(id)
  await st.set({ pendingAcks: pendingAcks.slice(-50) })
}

// ── 결과 업로드 (실패 시 unsentChunks 버퍼 → 다음 기회 재전송) ──
async function flushUnsent() {
  const { unsentChunks = [] } = await st.get('unsentChunks')
  while (unsentChunks.length) {
    try { await postResult(unsentChunks[0]); unsentChunks.shift() } catch { break }
  }
  await st.set({ unsentChunks })
}
async function sendResult(payload) {
  await flushUnsent()
  try { await postResult(payload) } catch {
    const { unsentChunks = [] } = await st.get('unsentChunks')
    unsentChunks.push(payload)
    await st.set({ unsentChunks: unsentChunks.slice(-30) }) // 폭주 방어(오래된 것부터 유실 허용)
  }
}

// ── 릴레이 폴링 ──
async function doPoll(force = false) {
  if (!force && Date.now() - lastPollAt < 3000) return
  lastPollAt = Date.now()
  const { token } = await getSettings()
  if (!token) return
  await flushUnsent()
  const { pendingAcks = [], pendingProgress = [] } = await st.get(['pendingAcks', 'pendingProgress'])
  let res
  try {
    const S = await getSelectors()
    res = await poll({ extVersion: chrome.runtime.getManifest().version, selectorsVersion: S.version, ack: pendingAcks, progress: pendingProgress })
  } catch (e) { notifyPanel({ type: 'poll_error', message: String(e?.message || e) }); return }
  await st.set({ pendingAcks: [], pendingProgress: [] })

  // 서버가 더 최신 확장 버전을 알고 있으면(코드 변경 후) 사이드패널에 새로고침 알림
  if (res.update?.latestVersion) {
    const cur = chrome.runtime.getManifest().version
    await st.set({ updateAvailable: { latestVersion: res.update.latestVersion, current: cur } })
    notifyPanel({ type: 'update', latestVersion: res.update.latestVersion, current: cur })
  } else {
    await st.set({ updateAvailable: null })
  }

  for (const c of res.control ?? []) await handleControl(c)
  if (res.commands?.length) {
    const { commandQueue = [] } = await st.get('commandQueue')
    const known = new Set(commandQueue.map((c) => c.id))
    for (const c of res.commands) if (!known.has(c.id)) commandQueue.push(c)
    await st.set({ commandQueue })
    runNext()
  }
  // 미아 작업 복구: 체크포인트가 있고 일시정지가 아니면 이어서
  const { checkpoint, jobControl } = await st.get(['checkpoint', 'jobControl'])
  if (!jobActive && checkpoint?.cmd && jobControl !== 'pause') resumeFromCheckpoint()
  else runNext() // 쿨다운 대기 중이던 큐 재확인(쿨다운 경과 시 실행)
}

// ── 탭 관리 ──
const isCoupang = (u) => { try { return /(^|\.)coupang\.com$/.test(new URL(u).hostname) } catch { return false } }

async function getWorkTab() {
  const { workTabId } = await st.get('workTabId')
  if (workTabId) { try { const t = await chrome.tabs.get(workTabId); if (t) return t } catch { /* 사라짐 */ } }
  const tab = await chrome.tabs.create({ url: 'https://www.coupang.com/', active: true })
  await st.set({ workTabId: tab.id })
  await waitComplete(tab.id)
  await sleep(SETTLE())
  return chrome.tabs.get(tab.id)
}

function waitComplete(tabId, timeout = NAV_TIMEOUT) {
  return new Promise((resolve) => {
    let done = false
    const finish = () => { if (!done) { done = true; chrome.tabs.onUpdated.removeListener(onUpd); resolve() } }
    const onUpd = (id, info) => { if (id === tabId && info.status === 'complete') finish() }
    chrome.tabs.onUpdated.addListener(onUpd)
    chrome.tabs.get(tabId).then((t) => { if (t?.status === 'complete') finish() }).catch(finish)
    setTimeout(finish, timeout)
  })
}

async function navigate(tabId, url) {
  await chrome.tabs.update(tabId, { url })
  await sleep(600) // loading 전이 대기
  await waitComplete(tabId)
  await sleep(SETTLE())
}

/** 콘텐츠 스크립트 호출 — 미주입(재시작 직후 등)이면 주입 후 1회 재시도 */
async function contentCall(tabId, msg) {
  const S = await getSelectors()
  const full = { ns: 'scout', selectors: S, ...msg }
  try { return await chrome.tabs.sendMessage(tabId, full) } catch {
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ['content/humanize.js', 'content/collector.js'] })
      await sleep(400)
      return await chrome.tabs.sendMessage(tabId, full)
    } catch (e) { return { error: 'CONTENT_UNREACHABLE', message: String(e?.message || e) } }
  }
}

// ── 제어 ──
async function handleControl(cmd) {
  await enqueueAck(cmd.id)
  const t = cmd.command_type
  if (t === 'job_pause') { await st.set({ jobControl: 'pause' }); await sendResult({ commandId: cmd.id, ok: true, summary: { control: 'pause' } }) }
  else if (t === 'job_stop') { await st.set({ jobControl: 'stop' }); await sendResult({ commandId: cmd.id, ok: true, summary: { control: 'stop' } }) }
  else if (t === 'job_resume') {
    await st.set({ jobControl: null })
    await sendResult({ commandId: cmd.id, ok: true, summary: { control: 'resume' } })
    resumeFromCheckpoint()
  } else if (t === 'get_state') {
    const { checkpoint, commandQueue = [], jobControl } = await st.get(['checkpoint', 'commandQueue', 'jobControl'])
    await sendResult({ commandId: cmd.id, ok: true, summary: { checkpoint: checkpoint?.state ?? null, activeCommand: checkpoint?.cmd?.id ?? null, queued: commandQueue.length, jobControl: jobControl ?? null, jobActive } })
  }
}

class PauseSignal extends Error {}
class StopSignal extends Error {}
async function checkControl(cmdId, ckptState) {
  const { jobControl } = await st.get('jobControl')
  if (jobControl === 'pause') {
    await enqueueProgress({ commandId: cmdId, phase: 'paused', note: '일시정지(체크포인트 저장)', ...summaryOf(ckptState) })
    await doPoll(true)
    throw new PauseSignal()
  }
  if (jobControl === 'stop') throw new StopSignal()
}
const summaryOf = (s) => ({ page: s?.page, items: s?.items })

// ── 실행 루프 ──
async function runNext() {
  if (jobActive) return
  const { commandQueue = [] } = await st.get('commandQueue')
  if (!commandQueue.length) return
  // 수집 명령은 쿨다운(키워드 간격·차단 백오프·장기 휴식)이 지나야 실행 — 큐에 남겨두고 대기
  const head = commandQueue[0]
  if (COLLECT_TYPES.includes(head.command_type)) {
    const wait = (await getPacing()).cooldownUntil - Date.now()
    if (wait > 0) {
      chrome.alarms.create('scout-cooldown', { when: Date.now() + Math.min(wait, 60000) + 1000 })
      notifyPanel({ type: 'progress', ev: { note: `⏳ 차단 회피 대기 — 약 ${Math.ceil(wait / 1000)}초 후 다음 수집` } })
      return
    }
  }
  const cmd = commandQueue.shift()
  await st.set({ commandQueue })
  jobActive = true
  blockedThisCmd = false
  try {
    await enqueueAck(cmd.id)
    await execute(cmd)
  } catch (e) {
    if (e instanceof PauseSignal) { /* 체크포인트 유지, 재개 대기 */ }
    else if (e instanceof StopSignal) {
      await st.set({ checkpoint: null, jobControl: null })
      await sendResult({ commandId: cmd.id, ok: false, error: { code: 'CANCELLED', message: '사용자 중지' } })
    } else {
      await sendResult({ commandId: cmd.id, ok: false, error: { code: 'RUNTIME', message: String(e?.message || e) } })
      await st.set({ checkpoint: null })
    }
  } finally {
    jobActive = false
    await afterCollect(cmd)
    await doPoll(true)
    runNext()
  }
}

async function resumeFromCheckpoint() {
  const { checkpoint } = await st.get('checkpoint')
  if (!checkpoint?.cmd || jobActive) return
  const { commandQueue = [] } = await st.get('commandQueue')
  if (!commandQueue.find((c) => c.id === checkpoint.cmd.id)) {
    commandQueue.unshift(checkpoint.cmd)
    await st.set({ commandQueue })
  }
  runNext()
}

// ── 차단 감지·복구 ──
async function recoverBlocked(tabId, keyword) {
  await enqueueProgress({ commandId: null, phase: 'blocked_retry', note: 'Access Denied — 메인 재워밍업' })
  await navigate(tabId, 'https://www.coupang.com/')
  await sleep(jitter(2500, 1500))
  if (keyword) {
    const r = await contentCall(tabId, { op: 'do_search', keyword })
    if (r?.navigating) { await waitComplete(tabId); await sleep(SETTLE()) }
  }
  const chk = await contentCall(tabId, { op: 'check_blocked' })
  return !chk?.blocked
}

// ── 명령 실행 ──
async function execute(cmd) {
  const p = cmd.payload || {}
  const t = cmd.command_type
  switch (t) {
    case 'ping': {
      const { workTabId } = await st.get('workTabId')
      let url = null
      if (workTabId) { try { url = (await chrome.tabs.get(workTabId))?.url } catch { /* noop */ } }
      const S = await getSelectors()
      return sendResult({ commandId: cmd.id, ok: true, summary: { pong: true, extVersion: chrome.runtime.getManifest().version, selectorsVersion: S.version, workTabUrl: url } })
    }
    case 'navigate': {
      if (!isCoupang(p.url)) return sendResult({ commandId: cmd.id, ok: false, error: { code: 'NAV_FAIL', message: 'coupang.com 도메인만 허용' } })
      if (/\/np\/search\?/.test(p.url)) return sendResult({ commandId: cmd.id, ok: false, error: { code: 'NAV_FAIL', message: '검색 딥링크 금지 — search 명령 사용' } })
      const tab = await getWorkTab()
      await navigate(tab.id, p.url)
      const chk = await contentCall(tab.id, { op: 'check_blocked' })
      return sendResult({ commandId: cmd.id, ok: !chk?.blocked, ...(chk?.blocked ? { error: { code: 'BLOCKED', message: 'Access Denied' } } : { summary: { url: p.url } }) })
    }
    case 'tab': {
      if (p.action === 'open') { const tb = await chrome.tabs.create({ url: 'https://www.coupang.com/', active: true }); await st.set({ workTabId: tb.id }); return sendResult({ commandId: cmd.id, ok: true, summary: { tabId: tb.id } }) }
      if (p.action === 'close') { const { workTabId } = await st.get('workTabId'); if (workTabId) await chrome.tabs.remove(workTabId).catch(() => {}); await st.set({ workTabId: null }); return sendResult({ commandId: cmd.id, ok: true, summary: { closed: true } }) }
      if (p.action === 'activate') { const { workTabId } = await st.get('workTabId'); if (workTabId) await chrome.tabs.update(workTabId, { active: true }).catch(() => {}); return sendResult({ commandId: cmd.id, ok: true, summary: { activated: true } }) }
      const tabs = await chrome.tabs.query({})
      return sendResult({ commandId: cmd.id, ok: true, summary: { tabs: tabs.slice(0, 20).map((x) => ({ id: x.id, url: (x.url || '').slice(0, 120), active: x.active })) } })
    }
    case 'search': {
      const tab = await getWorkTab()
      if (!isCoupang(tab.url)) { await navigate(tab.id, 'https://www.coupang.com/') }
      const r = await contentCall(tab.id, { op: 'do_search', keyword: String(p.keyword || '').slice(0, 100) })
      if (r?.error) return sendResult({ commandId: cmd.id, ok: false, error: { code: r.error, message: r.key || r.message || '' } })
      await waitComplete(tab.id); await sleep(SETTLE())
      const chk = await contentCall(tab.id, { op: 'check_blocked' })
      if (chk?.blocked && !(await recoverBlocked(tab.id, p.keyword))) return sendResult({ commandId: cmd.id, ok: false, error: { code: 'BLOCKED', message: 'Access Denied' } })
      const fin = await chrome.tabs.get(tab.id)
      return sendResult({ commandId: cmd.id, ok: true, summary: { url: (fin.url || '').slice(0, 300) } })
    }
    case 'category': {
      if (!isCoupang(p.url)) return sendResult({ commandId: cmd.id, ok: false, error: { code: 'NAV_FAIL', message: 'coupang.com 카테고리 URL 필요' } })
      const tab = await getWorkTab()
      await navigate(tab.id, p.url)
      const chk = await contentCall(tab.id, { op: 'check_blocked' })
      return sendResult({ commandId: cmd.id, ok: !chk?.blocked, ...(chk?.blocked ? { error: { code: 'BLOCKED', message: 'Access Denied' } } : { summary: { url: p.url } }) })
    }
    case 'scroll': case 'click': case 'input': {
      const tab = await getWorkTab()
      const r = await contentCall(tab.id, t === 'scroll' ? { op: 'scroll', to: p.to } : { op: t, selector: p.selector, nth: p.nth, text: p.text, checked: p.checked })
      return sendResult({ commandId: cmd.id, ok: !r?.error, ...(r?.error ? { error: { code: r.error, message: r.message || r.key || '' } } : { summary: r }) })
    }
    case 'filter':
      // v1: UI 필터 클릭 미지원 — collect_list.applyFilter(수집 후 필터)를 사용 (docs/scout-protocol.md)
      return sendResult({ commandId: cmd.id, ok: false, error: { code: 'UNSUPPORTED', message: 'v1은 collect_list.applyFilter 사용' } })
    case 'collect_list': return collectList(cmd)
    case 'collect_detail': return collectDetail(cmd, false)
    case 'extract_images': return collectDetail(cmd, true)
    case 'collect_reviews': return collectReviews(cmd)
    default:
      return sendResult({ commandId: cmd.id, ok: false, error: { code: 'UNKNOWN_TYPE', message: t } })
  }
}

// 수집 후 필터(applyFilter) — UI 클릭 대신 데이터 필터
function passFilter(it, f) {
  if (!f) return true
  if (Number.isFinite(f.minPrice) && it.price < f.minPrice) return false
  if (Number.isFinite(f.maxPrice) && it.price > f.maxPrice) return false
  if (Number.isFinite(f.minReviews) && (it.review_count ?? 0) < f.minReviews) return false
  if (Number.isFinite(f.minRating) && (it.rating ?? 0) < f.minRating) return false
  if (f.rocketOnly && !/^rocket/.test(it.delivery_badge || '')) return false
  if (f.excludeRocket && /^rocket($|_fresh|_global)/.test(it.delivery_badge || '')) return false
  return true
}

/** 목록 수집 — 검색→파싱→페이지네이션, 페이지 단위 청크 업로드+체크포인트 */
async function collectList(cmd) {
  const p = cmd.payload || {}
  const maxPages = Math.min(Number(p.maxPages) || 5, 20)
  const maxItems = Math.min(Number(p.maxItems) || 500, 2000)
  const keyword = p.keyword ? String(p.keyword).slice(0, 100) : null
  let { checkpoint } = await st.get('checkpoint')
  let state = checkpoint?.cmd?.id === cmd.id ? checkpoint.state : { page: 0, items: 0, seenIds: [] }
  const saveCkpt = async () => st.set({ checkpoint: { cmd, state } })

  const tab = await getWorkTab()
  // 진입: 검색 또는 카테고리 URL (재개 시에도 재검색 후 클릭으로 페이지 복원 — SERP URL 딥링크 회피)
  if (keyword) {
    if (!isCoupang(tab.url)) await navigate(tab.id, 'https://www.coupang.com/')
    const r = await contentCall(tab.id, { op: 'do_search', keyword })
    if (r?.error) return sendResult({ commandId: cmd.id, ok: false, error: { code: r.error, message: r.key || r.message || '' } })
    await waitComplete(tab.id); await sleep(SETTLE())
  } else if (p.categoryUrl && isCoupang(p.categoryUrl)) {
    await navigate(tab.id, p.categoryUrl)
  } else {
    return sendResult({ commandId: cmd.id, ok: false, error: { code: 'BAD_PAYLOAD', message: 'keyword 또는 categoryUrl 필요' } })
  }

  // 재개 시 저장된 페이지까지 클릭 이동
  for (let i = 0; i < state.page; i++) {
    await sleep(jitter(2500, 1500))
    const nx = await contentCall(tab.id, { op: 'click_next' })
    if (!nx?.clicked) break
    await waitComplete(tab.id); await sleep(SETTLE())
  }

  let blockStreak = 0
  let lastPageInfo = null
  const seen = new Set(state.seenIds || [])
  for (let page = state.page + 1; page <= maxPages; page++) {
    await checkControl(cmd.id, state)
    await contentCall(tab.id, { op: 'scroll_end' })
    const r = await contentCall(tab.id, { op: 'parse_serp' })
    if (r?.error || r?.page?.blocked) {
      blockStreak++
      if (blockStreak >= 3 || !(await recoverBlocked(tab.id, keyword))) {
        await saveCkpt()
        await onBlocked() // 전체 큐에 백오프 쿨다운 적용(다음 키워드가 곧바로 또 막히지 않게)
        return sendResult({ commandId: cmd.id, ok: false, error: { code: 'BLOCKED', message: `차단 ${blockStreak}회 — ${PACE.blockBackoffMin[Math.min((await getPacing()).consecutiveBlocks - 1, PACE.blockBackoffMin.length - 1)]}분 백오프`, paused: true, checkpoint: summaryOf(state) } })
      }
      page--; continue // 같은 페이지 재시도
    }
    blockStreak = 0
    lastPageInfo = r?.page || null
    const items = (r?.items || [])
      .filter((it) => !seen.has(it.product_id) && passFilter(it, p.applyFilter))
      .map((it) => ({ ...it, keyword: keyword || p.categoryUrl || null, page_no: page }))
    items.forEach((it) => seen.add(it.product_id))
    if (items.length) await sendResult({ commandId: cmd.id, ok: true, chunk: { seq: page, final: false }, data: { kind: 'products', items } })
    state = { page, items: state.items + items.length, seenIds: [...seen].slice(-2000) }
    await saveCkpt()
    await enqueueProgress({ commandId: cmd.id, phase: 'paging', page, totalPages: maxPages, items: state.items, pct: Math.round((page / maxPages) * 100), note: `${page}/${maxPages} 페이지 · 누적 ${state.items}건` })
    if (state.items >= maxItems) break
    if (page >= maxPages) break
    if ((r?.page?.maxKnownPage ?? page) <= page) break // 마지막 페이지
    await sleep(PAGE_JITTER())
    await checkControl(cmd.id, state)
    const nx = await contentCall(tab.id, { op: 'click_next' })
    if (!nx?.clicked) break
    await waitComplete(tab.id); await sleep(SETTLE())
  }
  await st.set({ checkpoint: null })
  // 2026 단일 뷰 SERP(페이지네이션 없음): 연관 키워드를 동봉해 두뇌가 추가 표본 수집을 판단하게 한다
  const singleView = lastPageInfo && !lastPageInfo.paginationFound && maxPages > 1
  return sendResult({
    commandId: cmd.id, ok: true, chunk: { seq: 9999, final: true }, data: { kind: 'products', items: [] },
    summary: {
      pages: state.page, items: state.items, keyword,
      ...(singleView ? { single_view: true, note: 'SERP에 페이지네이션 없음(2026 단일 뷰) — maxPages 미적용', relatedKeywords: lastPageInfo.relatedKeywords ?? [] } : {}),
    },
  })
}

/** 상세/이미지 수집 — productUrls 순회, 건 단위 청크+체크포인트 */
async function collectDetail(cmd, imagesOnly) {
  const p = cmd.payload || {}
  const urls = (Array.isArray(p.productUrls) ? p.productUrls : [p.productUrl]).filter((u) => isCoupang(u)).slice(0, 100)
  if (!urls.length) return sendResult({ commandId: cmd.id, ok: false, error: { code: 'BAD_PAYLOAD', message: 'productUrl(s) 필요' } })
  const include = imagesOnly ? ['images'] : (Array.isArray(p.include) ? p.include : ['options', 'seller', 'images', 'delivery', 'qna'])
  let { checkpoint } = await st.get('checkpoint')
  let state = checkpoint?.cmd?.id === cmd.id ? checkpoint.state : { idx: 0, items: 0 }
  const tab = await getWorkTab()
  let blockStreak = 0

  for (let i = state.idx; i < urls.length; i++) {
    await checkControl(cmd.id, state)
    await navigate(tab.id, urls[i])
    await contentCall(tab.id, { op: 'scroll', to: 1200 }) // 상세 지연로딩 유도
    const d = await contentCall(tab.id, { op: 'parse_detail', include })
    if (d?.blocked || d?.error === 'CONTENT_UNREACHABLE') {
      blockStreak++
      if (blockStreak >= 3) {
        await st.set({ checkpoint: { cmd, state } })
        await onBlocked() // 큐 전체 백오프
        return sendResult({ commandId: cmd.id, ok: false, error: { code: 'BLOCKED', message: `차단 ${blockStreak}회 — 백오프 대기`, paused: true, checkpoint: { idx: i } } })
      }
      if (!(await recoverBlocked(tab.id, null))) { i--; continue }
      i--; continue
    }
    blockStreak = 0
    if (d?.product_id) {
      await sendResult({ commandId: cmd.id, ok: true, chunk: { seq: i, final: false }, data: { kind: 'product_detail', items: [d] } })
      state = { idx: i + 1, items: state.items + 1 }
      await st.set({ checkpoint: { cmd, state } })
    }
    await enqueueProgress({ commandId: cmd.id, phase: 'parsing', page: i + 1, totalPages: urls.length, pct: Math.round(((i + 1) / urls.length) * 100), note: `상세 ${i + 1}/${urls.length} · 판매자수 ${d?.competing_sellers ?? '?'}` })
    if (i < urls.length - 1) await sleep(PACE.detailCooldownMs())
  }
  await st.set({ checkpoint: null })
  return sendResult({ commandId: cmd.id, ok: true, chunk: { seq: 9999, final: true }, data: { kind: 'product_detail', items: [] }, summary: { products: state.items, imagesOnly } })
}

/** 리뷰 수집 — 상품별 리뷰 탭 진입 후 페이지 순회 */
async function collectReviews(cmd) {
  const p = cmd.payload || {}
  const urls = (Array.isArray(p.productUrls) ? p.productUrls : [p.productUrl]).filter((u) => isCoupang(u)).slice(0, 30)
  if (!urls.length) return sendResult({ commandId: cmd.id, ok: false, error: { code: 'BAD_PAYLOAD', message: 'productUrl(s) 필요' } })
  const maxPages = Math.min(Number(p.maxPages) || 5, 30)
  let { checkpoint } = await st.get('checkpoint')
  let state = checkpoint?.cmd?.id === cmd.id ? checkpoint.state : { idx: 0, items: 0 }
  const tab = await getWorkTab()
  let seq = 0

  for (let i = state.idx; i < urls.length; i++) {
    await checkControl(cmd.id, state)
    await navigate(tab.id, urls[i])
    const nav = await contentCall(tab.id, { op: 'goto_reviews' })
    if (!nav?.done) {
      await enqueueProgress({ commandId: cmd.id, phase: 'parsing', note: `리뷰 섹션 미발견: ${urls[i].slice(-14)}` })
    } else {
      for (let rp = 1; rp <= maxPages; rp++) {
        await checkControl(cmd.id, state)
        const r = await contentCall(tab.id, { op: 'parse_reviews' })
        if (r?.blocked) break
        const items = (r?.items || []).map((it) => ({ ...it, content_hash: simpleHash(`${it.review_date}|${(it.content || '').slice(0, 200)}`) }))
        if (items.length) {
          await sendResult({ commandId: cmd.id, ok: true, chunk: { seq: seq++, final: false }, data: { kind: 'reviews', items } })
          state.items += items.length
        }
        await enqueueProgress({ commandId: cmd.id, phase: 'paging', page: rp, totalPages: maxPages, items: state.items, note: `리뷰 ${i + 1}/${urls.length} 상품 · ${rp}페이지 · 누적 ${state.items}건` })
        if (rp < maxPages) {
          await sleep(jitter(2500, 2000))
          const nx = await contentCall(tab.id, { op: 'click_review_next' })
          if (!nx?.clicked) break
        }
      }
    }
    state = { idx: i + 1, items: state.items }
    await st.set({ checkpoint: { cmd, state } })
    if (i < urls.length - 1) await sleep(PAGE_JITTER())
  }
  await st.set({ checkpoint: null })
  return sendResult({ commandId: cmd.id, ok: true, chunk: { seq: 9999, final: true }, data: { kind: 'reviews', items: [] }, summary: { products: urls.length, reviews: state.items } })
}

function simpleHash(s) {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0
  return h.toString(16).padStart(8, '0') + s.length.toString(16)
}

// ── 패널 ↔ SW ──
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.ns !== 'scout-ui') return
  ;(async () => {
    if (msg.op === 'wake') { await doPoll(); return { ok: true } }
    if (msg.op === 'control') {
      if (msg.action === 'pause') await st.set({ jobControl: 'pause' })
      if (msg.action === 'stop') await st.set({ jobControl: 'stop' })
      if (msg.action === 'resume') { await st.set({ jobControl: null }); resumeFromCheckpoint() }
      return { ok: true }
    }
    if (msg.op === 'status') {
      const { checkpoint, commandQueue = [], jobControl, updateAvailable } = await st.get(['checkpoint', 'commandQueue', 'jobControl', 'updateAvailable'])
      return { jobActive, jobControl: jobControl ?? null, checkpoint: checkpoint ? { commandId: checkpoint.cmd?.id, type: checkpoint.cmd?.command_type, ...summaryOf(checkpoint.state) } : null, queued: commandQueue.length, updateAvailable: updateAvailable ?? null }
    }
    return { error: 'unknown' }
  })().then(sendResponse)
  return true
})

// ── 부팅/알람 ──
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {})
  chrome.alarms.create('scout-poll', { periodInMinutes: 0.5 })
})
chrome.runtime.onStartup.addListener(() => { chrome.alarms.create('scout-poll', { periodInMinutes: 0.5 }) })
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === 'scout-poll') doPoll()          // 폴링 + 쿨다운 경과분 실행(doPoll 말미 runNext)
  else if (a.name === 'scout-cooldown') runNext() // 쿨다운 만료 시 큐 재개
})
