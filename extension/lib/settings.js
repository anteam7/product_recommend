/** 설정·셀렉터 로더 — SW/사이드패널/옵션 공용 (ES module) */

const DEFAULTS = {
  apiBase: 'https://product-recommend-nine.vercel.app',
  token: '',
  sessionId: null,
}
const SETTING_KEYS = ['apiBase', 'token', 'sessionId', 'selectorsOverride']

export async function getSettings() {
  const got = await chrome.storage.local.get(['apiBase', 'token', 'sessionId'])
  return { ...DEFAULTS, ...got }
}

/** 허용 키만 저장(임의 키 오염 방지) */
export async function saveSettings(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return
  const clean = Object.fromEntries(Object.entries(patch).filter(([k]) => SETTING_KEYS.includes(k)))
  if (Object.keys(clean).length) await chrome.storage.local.set(clean)
}

const isValidSelectors = (o) => !!o && typeof o === 'object' && !Array.isArray(o) && 'version' in o

/**
 * 번들 selectors.json + storage 오버라이드 병합.
 * 얕은 병합(최상위 키 단위 통째 교체) 의도 — 옵션 페이지에서 섹션 전체 JSON 을 붙여넣는 운용.
 */
export async function getSelectors() {
  let bundled = null
  try {
    const res = await fetch(chrome.runtime.getURL('selectors.json'))
    if (res.ok) bundled = await res.json()
  } catch { /* 번들 손상 — 아래 오버라이드 폴백 */ }
  const { selectorsOverride } = await chrome.storage.local.get('selectorsOverride')
  const override = isValidSelectors(selectorsOverride) ? selectorsOverride : null
  if (!bundled && !override) throw new Error('selectors.json 로드 실패 (번들 손상·오버라이드 없음)')
  if (!bundled) return { ...override, _source: 'override-only' }
  return override ? { ...bundled, ...override, _source: 'override' } : { ...bundled, _source: 'bundled' }
}
