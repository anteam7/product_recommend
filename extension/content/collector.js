/**
 * 쿠팡 페이지 수집기 (content script) — SW의 지시(op)를 받아 파싱·조작 결과를 반환.
 * SERP 파싱은 scripts/lib/market-price.mjs `_extractCoupangPrices` 이식·확장(뱃지/이미지/정가 추가).
 * 페이지 이동을 유발하는 op(do_search/click_next/…)는 응답 후 이 스크립트가 파괴된다 — SW가 tabs.onUpdated로 이어받는다.
 */
;(() => {
  if (window.__scoutCollector) return
  window.__scoutCollector = true
  const H = window.__scoutHuman

  const txt = (el) => (el?.textContent || '').replace(/\s+/g, ' ').trim()
  const parseComma = (s) => { const m = String(s || '').match(/([0-9]{1,3}(?:,[0-9]{3})+|[0-9]+)\s*원?/); return m ? parseInt(m[1].replace(/,/g, '')) : null }
  const isBlocked = () => /Access Denied/i.test(document.title) || /접근이 거부|Access Denied/i.test(document.body?.innerText?.slice(0, 400) || '')

  function badgeFromCard(card, S) {
    const alts = [...card.querySelectorAll(S.serp.badgeImgs)].map((i) => i.getAttribute('alt') || '')
    const all = alts.join(' ')
    if (/판매자\s*로켓|로켓\s*그로스/.test(all)) return 'rocket_growth'
    if (/로켓\s*프레시/.test(all)) return 'rocket_fresh'
    if (/로켓\s*직구/.test(all)) return 'rocket_global'
    if (/로켓/.test(all)) return 'rocket'
    return 'seller'
  }

  /** SERP 카드 전체 파싱 */
  function parseSerp(S) {
    const out = []
    const seen = new Set()
    document.querySelectorAll(S.serp.cardAnchor).forEach((a) => {
      const card = a.closest(S.serp.cardContainer) || a
      let price = null, originalPrice = null
      card.querySelectorAll('*').forEach((el) => {
        if (el.children.length) return
        const cls = typeof el.className === 'string' ? el.className : ''
        const m = (el.textContent || '').trim().match(/^([0-9]{1,3}(?:,[0-9]{3})+)\s*원?$/)
        if (!m) return
        const v = parseInt(m[1].replace(/,/g, ''))
        if (new RegExp(S.serp.priceLineThrough).test(cls)) { if (originalPrice == null) originalPrice = v }
        else if (price == null) price = v
      })
      if (!price) return
      const pid = (a.getAttribute('href') || '').match(/products\/(\d+)/)?.[1]
      if (!pid || seen.has(pid)) return
      seen.add(pid)
      let reviews = null, rating = null
      const rc = card.querySelector(S.serp.rating)
      if (rc) {
        const rm = (rc.textContent || '').match(/([0-9][0-9,]*)/)
        if (rm) reviews = parseInt(rm[1].replace(/,/g, ''))
        const st = [...rc.querySelectorAll('[style*="width"]')].map((e) => e.getAttribute('style') || '').find((s) => /width:\s*[0-9.]+%/.test(s))
        if (st) { const w = parseFloat((st.match(/width:\s*([0-9.]+)%/) || [])[1]); if (w >= 0) rating = Math.round((w / 20) * 10) / 10 }
      }
      const img = card.querySelector(S.serp.image)
      const href = a.getAttribute('href') || ''
      out.push({
        product_id: pid,
        url: href.startsWith('http') ? href.split('?')[0] : `https://www.coupang.com${href.split('?')[0]}`,
        name: txt(card.querySelector(S.serp.name)).slice(0, 300) || null,
        price, original_price: originalPrice,
        discount_rate: originalPrice && originalPrice > price ? Math.round((1 - price / originalPrice) * 100) : null,
        rating, review_count: reviews,
        delivery_badge: badgeFromCard(card, S),
        image_url: img?.getAttribute('src') || img?.getAttribute('data-img-src') || null,
        rank_in_page: out.length + 1,
      })
    })
    return out
  }

  /** SERP 페이지 정보 — 현재 페이지·다음 존재 여부 */
  function pageInfo(S) {
    const cur = parseInt(new URLSearchParams(location.search).get('page') || '1')
    const links = [...document.querySelectorAll(S.serp.pagination)]
    const nums = links.map((a) => parseInt(txt(a))).filter((n) => Number.isFinite(n))
    const totalText = txt(document.querySelector('[class*="search-result"] strong, [class*="TotalCount"]'))
    return { currentPage: cur, maxKnownPage: nums.length ? Math.max(...nums) : cur, totalText: totalText || null, blocked: isBlocked() }
  }

  async function clickNextPage(S) {
    const cur = parseInt(new URLSearchParams(location.search).get('page') || '1')
    const links = [...document.querySelectorAll(S.serp.pagination)]
    let target = links.find((a) => parseInt(txt(a)) === cur + 1)
    if (!target) target = document.querySelector(S.serp.paginationNext)
    if (!target) return { clicked: false }
    await H.clickEl(target)
    return { clicked: true, nextPage: cur + 1 }
  }

  /** 상세 페이지 파싱 */
  function parseDetail(S, include) {
    const inc = (k) => !include || include.includes(k)
    const pid = location.pathname.match(/products\/(\d+)/)?.[1] || null
    const d = {
      product_id: pid,
      url: location.href.split('?')[0],
      name: txt(document.querySelector(S.detail.name)).slice(0, 300) || null,
      price: parseComma(txt(document.querySelector(S.detail.price))),
      original_price: parseComma(txt(document.querySelector(S.detail.originalPrice))),
      review_count: parseComma(txt(document.querySelector(S.detail.reviewCount))),
    }
    if (inc('options')) {
      d.options = [...document.querySelectorAll(S.detail.optionList)].slice(0, 60).map((el) => ({
        text: txt(el).slice(0, 200), price: parseComma(txt(el)),
        soldout: /품절|일시품절/.test(txt(el)),
      })).filter((o) => o.text)
    }
    if (inc('seller')) {
      const sellerEl = document.querySelector(S.detail.sellerName)
      d.seller = txt(sellerEl).slice(0, 100) || null
      d.seller_info = sellerEl ? { name: d.seller, link: sellerEl.getAttribute('href') || null } : null
    }
    if (inc('images')) {
      d.image_url = document.querySelector(S.detail.mainImages)?.getAttribute('src') || null
      d.detail_images = [...document.querySelectorAll(S.detail.detailImages)]
        .map((i) => i.getAttribute('src') || i.getAttribute('data-src')).filter(Boolean).slice(0, 50)
    }
    if (inc('delivery')) d.delivery_info = { text: txt(document.querySelector(S.detail.deliveryInfo)).slice(0, 500) || null }
    // 상품정보 테이블 → 제조사/원산지
    const rows = [...document.querySelectorAll(`${S.detail.infoTable.split(',')[0]} ${S.detail.infoRows}`)]
    for (const tr of rows.slice(0, 60)) {
      const k = txt(tr.querySelector('th')), v = txt(tr.querySelector('td'))
      if (/제조사|제조자/.test(k)) d.manufacturer = v.slice(0, 200)
      if (/원산지|제조국/.test(k)) d.origin = v.slice(0, 200)
    }
    d.category_path = [...document.querySelectorAll(S.detail.breadcrumb)].map((a) => txt(a)).filter(Boolean).slice(0, 10)
    if (inc('qna')) {
      const q = document.querySelector(S.detail.qnaSection)
      d.qna = q ? { text: txt(q).slice(0, 1000) } : null
    }
    d.blocked = isBlocked()
    return d
  }

  /** 리뷰 목록 파싱(현재 표시된 페이지) */
  function parseReviews(S) {
    const pid = location.pathname.match(/products\/(\d+)/)?.[1] || null
    const items = [...document.querySelectorAll(S.review.item)].slice(0, 50).map((art) => {
      const dateTxt = txt(art.querySelector(S.review.date))
      const dm = dateTxt.match(/(\d{4})[.\-/](\d{1,2})[.\-/](\d{1,2})/)
      const content = txt(art.querySelector(S.review.content)).slice(0, 2000)
      const ratingEl = art.querySelector(S.review.rating)
      let rating = null
      if (ratingEl) {
        const st = (ratingEl.getAttribute('style') || '').match(/width:\s*([0-9.]+)%/)
        if (st) rating = Math.round(parseFloat(st[1]) / 20)
        else rating = parseInt(ratingEl.getAttribute('data-rating')) || null
      }
      return {
        product_id: pid,
        review_date: dm ? `${dm[1]}-${dm[2].padStart(2, '0')}-${dm[3].padStart(2, '0')}` : null,
        rating,
        content: content || null,
        images: [...art.querySelectorAll(S.review.images)].map((i) => i.getAttribute('src')).filter(Boolean).slice(0, 10),
        option_text: txt(art.querySelector(S.review.option)).slice(0, 300) || null,
        helpful_count: parseComma(txt(art.querySelector(S.review.helpful))) || null,
      }
    }).filter((r) => r.content || r.review_date)
    return { items, blocked: isBlocked() }
  }

  async function clickReviewNext(S) {
    const next = document.querySelector(S.review.paginationNext)
    if (next && !next.disabled) { await H.clickEl(next); await H.sleep(H.jitter(1500, 1000)); return { clicked: true } }
    return { clicked: false }
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || msg.ns !== 'scout') return
    ;(async () => {
      const S = msg.selectors
      switch (msg.op) {
        case 'get_ready': return { ready: true, href: location.href, blocked: isBlocked() }
        case 'check_blocked': return { blocked: isBlocked(), title: document.title }
        case 'do_search': {
          const input = document.querySelector(S.search.input)
          if (!input) return { error: 'SELECTOR_MISS', key: 'search.input' }
          await H.clickEl(input)
          await H.typeInto(input, msg.keyword, { perKeyMs: 40 })
          await H.sleep(H.jitter(300, 400))
          const btn = document.querySelector(S.search.submit)
          if (btn) await H.clickEl(btn)
          else input.form?.requestSubmit ? input.form.requestSubmit() : input.form?.submit()
          return { navigating: true }
        }
        case 'parse_serp': return { items: parseSerp(S), page: pageInfo(S) }
        case 'page_info': return pageInfo(S)
        case 'click_next': return await clickNextPage(S)
        case 'scroll_end': await H.scrollToEnd(); return { done: true }
        case 'scroll': {
          if (msg.to === 'top') window.scrollTo({ top: 0, behavior: 'smooth' })
          else if (msg.to === 'end') await H.scrollToEnd()
          else if (Number.isFinite(msg.to)) await H.smoothScrollBy(msg.to - window.scrollY)
          return { done: true }
        }
        case 'click': {
          const els = [...document.querySelectorAll(msg.selector || '')]
          const el = els[msg.nth || 0]
          if (!el) return { error: 'SELECTOR_MISS', key: msg.selector }
          await H.clickEl(el)
          return { clicked: true }
        }
        case 'input': {
          const el = document.querySelector(msg.selector || '')
          if (!el) return { error: 'SELECTOR_MISS', key: msg.selector }
          if (el.type === 'checkbox') { if (el.checked !== !!msg.checked) await H.clickEl(el) }
          else if (el.tagName === 'SELECT') { el.value = msg.text; el.dispatchEvent(new Event('change', { bubbles: true })) }
          else await H.typeInto(el, String(msg.text ?? ''))
          return { done: true }
        }
        case 'parse_detail': return parseDetail(S, msg.include)
        case 'parse_reviews': return parseReviews(S)
        case 'click_review_next': return await clickReviewNext(S)
        case 'goto_reviews': {
          const link = document.querySelector(S.review.tabLink)
          if (link) { await H.clickEl(link); await H.sleep(H.jitter(1200, 800)) }
          else { await H.scrollToEnd({ rounds: 6 }) } // 리뷰 섹션은 스크롤로도 로드됨
          return { done: !!document.querySelector(S.review.section) }
        }
        default: return { error: 'UNKNOWN_OP', op: msg.op }
      }
    })().then(sendResponse).catch((e) => sendResponse({ error: 'CONTENT_ERROR', message: String(e?.message || e) }))
    return true // async sendResponse
  })
})()
