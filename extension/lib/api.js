/** 릴레이 API 클라이언트 — /api/ext/scout/* (Bearer SCOUT_EXT_TOKEN) */
import { getSettings } from './settings.js'

export async function apiFetch(path, { method = 'GET', body } = {}) {
  const { apiBase, token } = await getSettings()
  if (!apiBase || !token) throw new Error('옵션에서 API 주소·토큰을 먼저 설정하세요')
  const res = await fetch(`${apiBase}/api/ext/scout${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(json?.error || `HTTP ${res.status}`)
  return json
}

export const poll = (payload) => apiFetch('/poll', { method: 'POST', body: payload })
export const postResult = (payload) => apiFetch('/result', { method: 'POST', body: payload })
export const postMessage = (payload) => apiFetch('/message', { method: 'POST', body: payload })
export const getMessages = (sessionId, after) =>
  apiFetch(`/messages?sessionId=${encodeURIComponent(sessionId)}${after ? `&after=${encodeURIComponent(after)}` : ''}`)
