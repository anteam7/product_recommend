import { chromium, type Browser, type Page } from 'playwright'

/**
 * SPA 사이트 fetch 용 공유 Playwright 인스턴스 + 페이지 렌더 헬퍼.
 * 단일 fetcher 실행 동안만 살아있는 lazy-init 브라우저 — 끝나면 closeBrowser() 호출.
 */

let _browser: Browser | null = null

export async function getBrowser(): Promise<Browser> {
  if (_browser) return _browser
  _browser = await chromium.launch({ headless: true })
  return _browser
}

export async function closeBrowser(): Promise<void> {
  if (_browser) {
    await _browser.close()
    _browser = null
  }
}

export type RenderOptions = {
  /** 도착 후 selector 가 보일 때까지 대기 */
  waitForSelector?: string
  /** 추가 대기 (ms) — JS 비동기 데이터 로드 끝날 시간 */
  postLoadWaitMs?: number
  /** 페이지 도착 후 실행할 함수 (탭 클릭 등). page 인자로 페이지 받음. */
  setup?: (page: Page) => Promise<void>
  /** 타임아웃 (ms) */
  timeoutMs?: number
}

export async function renderAndGetHtml(url: string, opts: RenderOptions = {}): Promise<string> {
  const browser = await getBrowser()
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (compatible; jimscanner-bot/1.0)',
  })
  const page = await ctx.newPage()
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: opts.timeoutMs ?? 30_000 })
    if (opts.waitForSelector) {
      await page.waitForSelector(opts.waitForSelector, { timeout: opts.timeoutMs ?? 30_000 })
    }
    if (opts.setup) await opts.setup(page)
    if (opts.postLoadWaitMs) await page.waitForTimeout(opts.postLoadWaitMs)
    return await page.content()
  } finally {
    await page.close()
    await ctx.close()
  }
}
