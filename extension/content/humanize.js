/** 사람화 유틸 — collector.js 보다 먼저 로드되는 classic script. window.__scoutHuman 네임스페이스. */
;(() => {
  if (window.__scoutHuman) return

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const jitter = (base, spread) => base + Math.random() * spread

  /** 여러 번 나눠 easing 스크롤 (지연로딩 트리거) */
  async function smoothScrollBy(totalPx, steps = 8) {
    for (let i = 0; i < steps; i++) {
      const t = (i + 1) / steps
      const eased = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2
      window.scrollTo({ top: window.scrollY + (totalPx / steps) * (0.5 + eased), behavior: 'smooth' })
      await sleep(jitter(120, 180))
    }
  }

  /** 끝까지 스크롤 — 무한스크롤/지연로딩 대응: 높이가 더 안 늘어날 때까지(최대 rounds회) */
  async function scrollToEnd({ rounds = 12, settleMs = 700 } = {}) {
    let lastH = 0
    for (let i = 0; i < rounds; i++) {
      const h = document.documentElement.scrollHeight
      await smoothScrollBy(Math.max(400, h - window.scrollY - window.innerHeight), 5)
      await sleep(jitter(settleMs, 500))
      const nh = document.documentElement.scrollHeight
      if (nh <= h && nh === lastH) break
      lastH = nh
    }
  }

  /** 사람처럼 타이핑 — 글자별 input 이벤트 + 랜덤 딜레이 */
  async function typeInto(el, text, { perKeyMs = 40 } = {}) {
    el.focus()
    el.value = ''
    el.dispatchEvent(new Event('input', { bubbles: true }))
    for (const ch of text) {
      el.value += ch
      el.dispatchEvent(new Event('input', { bubbles: true }))
      await sleep(jitter(perKeyMs, 45))
    }
    el.dispatchEvent(new Event('change', { bubbles: true }))
  }

  /** 클릭 전 스크롤 인뷰 + hover + 지연 */
  async function clickEl(el) {
    el.scrollIntoView({ block: 'center', behavior: 'smooth' })
    await sleep(jitter(350, 400))
    el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
    await sleep(jitter(120, 200))
    el.click()
  }

  window.__scoutHuman = { sleep, jitter, smoothScrollBy, scrollToEnd, typeInto, clickEl }
})()
