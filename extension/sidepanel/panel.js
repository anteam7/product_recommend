/** 사이드패널 채팅 — WorkConsole.tsx 의 3초 폴링·중복 방지·스크롤 stick 로직 이식 */
import { getSettings, saveSettings } from '../lib/settings.js'
import { postMessage, getMessages } from '../lib/api.js'

const $ = (id) => document.getElementById(id)
const thread = $('thread')
const seenIds = new Set()          // gte 커서 중복 제거
let sessionId = null
let cursor = null                  // 마지막 메시지 created_at
let stick = true                   // 맨 아래 추적 여부
let polling = false

function fmtTime(iso) { try { return new Date(iso).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' }) } catch { return '' } }

function addMsg(m) {
  if (seenIds.has(m.id)) return
  seenIds.add(m.id)
  const div = document.createElement('div')
  div.className = `msg ${m.role === 'user' ? 'user' : m.role === 'brain' ? 'brain' : 'system'}`
  div.textContent = m.content || ''
  if (m.role !== 'system') {
    const t = document.createElement('span')
    t.className = 'time'
    t.textContent = fmtTime(m.created_at)
    div.appendChild(t)
  }
  thread.appendChild(div)
  if (m.created_at && (!cursor || m.created_at > cursor)) cursor = m.created_at
  if (stick) thread.scrollTop = thread.scrollHeight
  else $('toBottom').hidden = false
}
function sysNote(text) { addMsg({ id: `local-${Date.now()}-${Math.random()}`, role: 'system', content: text, created_at: null }) }

thread.addEventListener('scroll', () => {
  stick = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 48
  if (stick) $('toBottom').hidden = true
})
$('toBottom').addEventListener('click', () => { stick = true; thread.scrollTop = thread.scrollHeight; $('toBottom').hidden = true })

// ── 로컬 작업 상태 표시줄 + 제어(SW 직결 — 서버 왕복 없음) ──
async function refreshJobbar() {
  let s
  try { s = await chrome.runtime.sendMessage({ ns: 'scout-ui', op: 'status' }) } catch { return }
  const bar = $('jobbar')
  if (!s || (!s.jobActive && !s.checkpoint && !s.queued)) { bar.hidden = true; return }
  bar.hidden = false
  const paused = s.jobControl === 'pause'
  $('jobtext').textContent = s.checkpoint
    ? `${s.checkpoint.type ?? '작업'} ${paused ? '⏸ 일시정지' : '실행중'}${s.checkpoint.page ? ` · ${s.checkpoint.page}p` : ''}${s.checkpoint.items ? ` · ${s.checkpoint.items}건` : ''}${s.queued ? ` · 대기 ${s.queued}` : ''}`
    : `대기 명령 ${s.queued}건`
  $('btnPause').hidden = paused
  $('btnResume').hidden = !paused
}
$('btnPause').addEventListener('click', async () => { await chrome.runtime.sendMessage({ ns: 'scout-ui', op: 'control', action: 'pause' }); sysNote('⏸ 일시정지 요청'); refreshJobbar() })
$('btnResume').addEventListener('click', async () => { await chrome.runtime.sendMessage({ ns: 'scout-ui', op: 'control', action: 'resume' }); sysNote('▶ 재개 요청'); refreshJobbar() })
$('btnStop').addEventListener('click', async () => { if (confirm('진행 중 작업을 중지할까요? (체크포인트 폐기)')) { await chrome.runtime.sendMessage({ ns: 'scout-ui', op: 'control', action: 'stop' }); sysNote('⏹ 중지 요청'); refreshJobbar() } })

// SW 진행 이벤트 실시간 반영
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.ns !== 'scout-ui-ev') return
  if (msg.type === 'progress' && msg.ev?.note) sysNote(`⚙ ${msg.ev.note}`)
  if (msg.type === 'poll_error') $('conn').textContent = `연결 오류: ${msg.message}`, $('conn').className = 'conn err'
  refreshJobbar()
})

// ── 서버 폴링 (3초) ──
async function pollLoop() {
  if (polling) return
  polling = true
  try {
    if (sessionId) {
      const r = await getMessages(sessionId, cursor)
      for (const m of r.messages ?? []) addMsg(m)
      const act = (r.activeCommands ?? []).filter((c) => c.status === 'running' || c.status === 'paused')
      $('conn').textContent = act.length
        ? `⚙ ${act.map((c) => `${c.command_type}${c.progress?.note ? ` — ${c.progress.note}` : ''}`).join(' · ')}`
        : '연결됨'
      $('conn').className = 'conn ok'
    } else {
      $('conn').textContent = '연결됨 (새 대화)'
      $('conn').className = 'conn ok'
    }
    chrome.runtime.sendMessage({ ns: 'scout-ui', op: 'wake' }).catch(() => {}) // SW 폴링 촉진
  } catch (e) {
    $('conn').textContent = `연결 오류: ${String(e?.message || e)}`
    $('conn').className = 'conn err'
  } finally { polling = false }
  refreshJobbar()
}

// ── 전송 ──
async function send() {
  const content = $('input').value.trim()
  if (!content) return
  $('send').disabled = true
  try {
    const r = await postMessage({ sessionId, content })
    if (r.sessionId && r.sessionId !== sessionId) { sessionId = r.sessionId; await saveSettings({ sessionId }) }
    $('input').value = ''
    stick = true
    await pollLoop()
  } catch (e) { sysNote(`✗ 전송 실패: ${String(e?.message || e)}`) } finally { $('send').disabled = false }
}
$('send').addEventListener('click', send)
$('input').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } })

$('newSession').addEventListener('click', async (e) => {
  e.preventDefault()
  if (!confirm('새 대화를 시작할까요? (기존 스레드는 서버에 보존)')) return
  sessionId = null; cursor = null; seenIds.clear(); thread.innerHTML = ''
  await saveSettings({ sessionId: null })
  sysNote('새 대화 시작 — 첫 메시지를 보내면 세션이 생성됩니다')
})
$('openOptions').addEventListener('click', (e) => { e.preventDefault(); chrome.runtime.openOptionsPage() })

// ── init ──
;(async () => {
  const s = await getSettings()
  if (!s.token) { sysNote('⚠ 설정에서 API 주소·토큰을 먼저 입력하세요 (아래 [설정])'); $('conn').textContent = '미설정'; $('conn').className = 'conn err' }
  sessionId = s.sessionId || null
  await pollLoop()
  setInterval(pollLoop, 3000)
  refreshJobbar()
})()
