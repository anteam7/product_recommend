import type { ParsedRate } from './types'
import { getBrowser } from './playwright-helper'

/**
 * jiggujiggu — Vue SPA, BootstrapVue-style 페이지네이션 가격표.
 * 등급: 직구스타트, 직구20마일, 직구50마일, 직구100마일, 직구200마일, 직구메이저, 사업자
 * 무게: LB. 통화: USD ($).
 *
 * 페이지: 미국 / 중국 두 대륙 탭이 있을 수 있음 — 일단 기본 페이지(아마 미국) 에서 시작.
 */
export async function fetchJiggujiggu(): Promise<{ rates: ParsedRate[]; raw_snapshot: string }> {
  const browser = await getBrowser()
  const ctx = await browser.newContext({ userAgent: 'Mozilla/5.0 (compatible; jimscanner-bot/1.0)' })
  const page = await ctx.newPage()
  const allRates: ParsedRate[] = []
  const allHtml: string[] = []
  try {
    await page.goto('https://new.jiggujiggu.com/fees', { waitUntil: 'networkidle', timeout: 60_000 })
    await page.waitForTimeout(3000)

    // 등급 추출
    const grades = await page.evaluate(() => {
      const ths = Array.from(document.querySelectorAll('table thead th'))
      return ths.map((th) => (th as HTMLElement).innerText.trim()).filter((t, i) => i > 0 && t.length > 0)
    })
    if (grades.length === 0) throw new Error('등급 헤더 미발견')

    let prev = 0
    let pageNum = 1
    const maxPages = 30
    while (pageNum <= maxPages) {
      const html = await page.content()
      allHtml.push(`<!-- page ${pageNum} -->\n${html}`)

      const rows = await page.evaluate(() => {
        const trs = Array.from(document.querySelectorAll('table tbody tr'))
        return trs
          .map((tr) => {
            const th = tr.querySelector('th')
            const tds = Array.from(tr.querySelectorAll('td'))
            return {
              header: (th as HTMLElement | null)?.innerText.trim() ?? '',
              cells: tds.map((td) => (td as HTMLElement).innerText.trim()),
            }
          })
          .filter((r) => /^[\d.]+\s*(LB|kg|KG|lbs?)/i.test(r.header))
      })
      for (const r of rows) {
        const wMatch = r.header.match(/([\d.]+)/)
        if (!wMatch) continue
        const w = Number(wMatch[1])
        if (!Number.isFinite(w)) continue
        const isLb = /lb/i.test(r.header)
        for (let g = 0; g < grades.length && g < r.cells.length; g++) {
          const priceMatch = r.cells[g].match(/([\d.,]+)/)
          if (!priceMatch) continue
          const price = Number(priceMatch[1].replace(/,/g, ''))
          if (!Number.isFinite(price)) continue
          allRates.push({
            country: 'US',
            center_name: null,
            weight_min: prev,
            weight_max: w,
            weight_unit: isLb ? 'lb' : 'kg',
            price_krw: null,
            price_usd: price,
            price_jpy: null,
            price_cny: null,
            price_eur: null,
            shipping_type: 'air',
            service_label: null,
            member_grade: grades[g],
            grade_level: g + 1,
          })
        }
        prev = w
      }

      const hasNext = await page.evaluate(() => {
        const items = Array.from(document.querySelectorAll('li.page-item'))
        const next = items.find((li) => {
          const btn = li.querySelector('button.page-link, a.page-link')
          return btn && /^›$/.test((btn as HTMLElement).innerText.trim())
        })
        if (!next || next.classList.contains('disabled')) return false
        const btn = next.querySelector('button, a') as HTMLElement | null
        if (!btn) return false
        btn.click()
        return true
      })
      if (!hasNext) break
      await page.waitForTimeout(800)
      pageNum++
    }

    if (allRates.length === 0) throw new Error('파싱 0행')
    return { rates: allRates, raw_snapshot: allHtml.join('\n\n') }
  } finally {
    await page.close()
    await ctx.close()
  }
}
