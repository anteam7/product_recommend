import type { ParsedRate, ShippingType } from './types'
import { getBrowser } from './playwright-helper'

/**
 * unition (BootstrapVue table) — 페이지네이션 처리.
 * thead 의 <th> 첫 번째는 '등급', 나머지는 LV0..LV10 + 프라임.
 * tbody 의 첫 행은 이용건수 (스킵), 나머지 행은 weight 헤더 + 가격 셀.
 */
export async function renderUnitionAllPages(
  url: string,
  country: string,
  weight_unit: 'kg' | 'lb',
  shipping_type: ShippingType,
): Promise<{ rates: ParsedRate[]; raw: string }> {
  const browser = await getBrowser()
  const ctx = await browser.newContext({ userAgent: 'Mozilla/5.0 (compatible; jimscanner-bot/1.0)' })
  const page = await ctx.newPage()
  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 60_000 })
    await page.waitForTimeout(2000)

    // 등급 추출 (thead 의 th 텍스트, 첫 번째 '등급' 제외)
    const grades = await page.evaluate(() => {
      const ths = Array.from(document.querySelectorAll('table thead th'))
      return ths.map((th) => (th as HTMLElement).innerText.trim()).filter((t, i) => i > 0 && t.length > 0)
    })
    if (grades.length === 0) throw new Error('등급 헤더 미발견')

    const allRates: ParsedRate[] = []
    const allHtml: string[] = []
    let prev = 0
    let pageNum = 1
    const maxPages = 30

    while (pageNum <= maxPages) {
      const html = await page.content()
      allHtml.push(`<!-- page ${pageNum} -->\n` + html)

      // weight 행: tbody tr 중 첫 셀이 <th> 이고 텍스트에 '1LB' / '0.5kg' 패턴 매칭
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
        for (let g = 0; g < grades.length && g < r.cells.length; g++) {
          const priceMatch = r.cells[g].match(/([\d.,]+)/)
          if (!priceMatch) continue
          const price = Number(priceMatch[1].replace(/,/g, ''))
          if (!Number.isFinite(price)) continue
          allRates.push({
            country,
            center_name: null,
            weight_min: prev,
            weight_max: w,
            weight_unit,
            price_krw: null,
            price_usd: price,
            price_jpy: null,
            price_cny: null,
            price_eur: null,
            shipping_type,
            service_label: null,
            member_grade: grades[g],
            grade_level: g + 1,
          })
        }
        prev = w
      }

      // 다음 페이지: '›' 라벨 button.page-link 클릭, parent li 가 disabled 면 종료
      const hasNext = await page.evaluate(() => {
        const items = Array.from(document.querySelectorAll('li.page-item'))
        const next = items.find((li) => {
          const btn = li.querySelector('button.page-link')
          return btn && (btn as HTMLElement).innerText.trim() === '›'
        })
        if (!next) return false
        if (next.classList.contains('disabled')) return false
        const btn = next.querySelector('button') as HTMLButtonElement | null
        if (!btn) return false
        btn.click()
        return true
      })
      if (!hasNext) break
      await page.waitForTimeout(800)
      pageNum++
    }

    return { rates: allRates, raw: allHtml.join('\n\n') }
  } finally {
    await page.close()
    await ctx.close()
  }
}
