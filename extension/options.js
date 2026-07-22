import { getSettings, saveSettings } from './lib/settings.js'

const $ = (id) => document.getElementById(id)
const setStatus = (text, ok) => { const s = $('status'); s.textContent = text; s.className = ok ? 'ok' : 'err' }
const isValidSelectors = (o) => !!o && typeof o === 'object' && !Array.isArray(o) && 'version' in o
// http 는 로컬 개발(localhost)만 허용 — 그 외 평문 토큰 전송 금지
const isValidBase = (u) => /^https:\/\/.+/.test(u) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(u)

;(async () => {
  try {
    const s = await getSettings()
    $('apiBase').value = s.apiBase || ''
    $('token').value = s.token || ''
    const { selectorsOverride } = await chrome.storage.local.get('selectorsOverride')
    if (selectorsOverride) $('selectorsOverride').value = JSON.stringify(selectorsOverride, null, 2)
  } catch (e) { setStatus(`✗ 설정 로드 실패: ${String(e?.message || e)}`, false) }
})()

$('save').addEventListener('click', async () => {
  try {
    const apiBase = $('apiBase').value.trim().replace(/\/$/, '')
    const token = $('token').value.trim()
    if (!isValidBase(apiBase)) return setStatus('API 주소 형식 오류 (https 필수 — http는 localhost만)', false)
    const ovRaw = $('selectorsOverride').value.trim()
    let selectorsOverride = null
    if (ovRaw) {
      try { selectorsOverride = JSON.parse(ovRaw) } catch { return setStatus('셀렉터 오버라이드 JSON 파싱 실패', false) }
      if (!isValidSelectors(selectorsOverride)) return setStatus('셀렉터 오버라이드는 version 필드를 가진 객체여야 합니다', false)
    }
    await saveSettings({ apiBase, token, ...(selectorsOverride ? { selectorsOverride } : {}) })
    if (!ovRaw) await chrome.storage.local.remove('selectorsOverride')
    setStatus('저장됨', true)
  } catch (e) { setStatus(`✗ 저장 실패: ${String(e?.message || e)}`, false) }
})

$('test').addEventListener('click', async () => {
  const apiBase = $('apiBase').value.trim().replace(/\/$/, '')
  const token = $('token').value.trim()
  if (!apiBase || !token) return setStatus('주소·토큰을 입력하세요', false)
  setStatus('테스트 중…', true)
  try {
    const res = await fetch(`${apiBase}/api/ext/scout/poll`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ extVersion: 'options-test' }),
    })
    if (res.status === 401) return setStatus('✗ 토큰 불일치 (401)', false)
    if (!res.ok) return setStatus(`✗ 서버 오류 HTTP ${res.status}`, false)
    const j = await res.json()
    setStatus(`✓ 연결 성공 (대기 명령 ${j.commands?.length ?? 0}건)`, true)
  } catch (e) { setStatus(`✗ 연결 실패: ${String(e?.message || e)} — 도메인이 manifest host_permissions에 있는지 확인`, false) }
})
