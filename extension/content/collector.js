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

  /** SERP 페이지 정보 — 현재 페이지·다음 존재 여부 + 연관 검색어
   *  2026 개편 SERP 는 페이지네이션 없는 단일 뷰(~85건)일 수 있음 — 그 경우 연관 키워드가 추가 표본 경로 */
  function pageInfo(S) {
    const cur = parseInt(new URLSearchParams(location.search).get('page') || '1')
    const links = [...document.querySelectorAll(S.serp.pagination)]
    const nums = links.map((a) => parseInt(txt(a))).filter((n) => Number.isFinite(n))
    const totalText = txt(document.querySelector('[class*="search-result"] strong, [class*="TotalCount"]'))
    const related = [...document.querySelectorAll(S.serp.relatedKeywords || '.srp-related-keywords a')]
      .map((a) => txt(a)).filter(Boolean).slice(0, 12)
    return { currentPage: cur, maxKnownPage: nums.length ? Math.max(...nums) : cur, paginationFound: nums.length > 0, relatedKeywords: related, totalText: totalText || null, blocked: isBlocked() }
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
    }
    // 리뷰수 — querySelector 는 문서 순서상 첫 매칭만 준다. 숫자 없는 껍데기 요소가 먼저 걸리면
    // 그대로 null 이 되므로(실측: 셀렉터를 맞춰도 0/3), 후보를 모두 훑어 숫자가 나오는 첫 요소를 쓴다.
    for (const el of document.querySelectorAll(S.detail.reviewCount)) {
      const n = parseComma(txt(el))
      if (n != null) { d.review_count = n; break }                 // "355 개 상품평" → 355
    }
    // 평점 — 별점은 채워진 막대의 width(%) 로 표현된다(5점 만점이라 20% = 1점).
    // detail.rating 셀렉터가 아예 없어서 상세 평점은 지금까지 한 번도 수집된 적이 없다.
    const barEl = S.detail.ratingBar ? document.querySelector(S.detail.ratingBar) : null
    if (barEl) {
      const w = (barEl.getAttribute('style') || '').match(/width:\s*([0-9.]+)%/)
      if (w) d.rating = Math.round((parseFloat(w[1]) / 20) * 10) / 10
    }
    if (inc('options')) {
      // 옵션 텍스트는 가격이 없는 경우가 많다. parseComma 는 '원'이 선택적이라 맨 앞 숫자를 집어
      // "색상 × 수량:그레이 × 1개" 를 1원으로 읽었다(실측 오류). 숫자에 '원'이 붙은 것만 가격으로 인정한다.
      // ('원'의 존재만 보면 "그레이 × 1개 12,000원"에서 다시 1을 집고, "원목 브라운 2개"도 2가 된다)
      const optPrice = (s) => { const m = String(s || '').match(/([0-9]{1,3}(?:,[0-9]{3})+|[0-9]+)\s*원/); return m ? parseInt(m[1].replace(/,/g, '')) : null }
      d.options = [...document.querySelectorAll(S.detail.optionList)].slice(0, 60).map((el) => {
        const t = txt(el)
        return { text: t.slice(0, 200), price: optPrice(t), soldout: /품절|일시품절/.test(t) }
      }).filter((o) => o.text)
      // 옵션 목록이 안 잡히면(변형 UI·단일옵션 상품) 최소한 선택된 조합이라도 남긴다.
      // "색상 × 수량:그레이 × 1개" — 빈 배열만 저장하면 '옵션 없음'과 '수집 실패'를 구분할 수 없다.
      if (!d.options.length && S.detail.optionSummary) {
        const sum = txt(document.querySelector(S.detail.optionSummary))
        if (sum) d.options = [{ text: sum.slice(0, 200), price: null, soldout: false, summary: true }]
      }
    }
    if (inc('seller')) {
      // 판매자명 — 링크 텍스트에 "판매자 상품 보러가기" 안내문이 붙어 오고,
      // 판매자 블록이 없는 로켓배송 상품에선 넓은 셀렉터가 고객센터 번호(1577-7011)를 긁어왔다.
      // seller-info 블록으로 범위를 좁히고 안내문·접두사를 걷어낸다.
      const blockEl = S.detail.sellerBlock ? document.querySelector(S.detail.sellerBlock) : null
      const sellerEl = (blockEl || document).querySelector(S.detail.sellerName)
      const clean = (s) => s.replace(/판매자\s*상품\s*보러가기/g, '').replace(/^판매자\s*:?\s*/, '').trim()
      const name = clean(txt(sellerEl) || txt(blockEl))
      d.seller = /^[\d-]{7,}$/.test(name) ? null : (name.slice(0, 100) || null)   // 전화번호만 남으면 미수집 취급
      d.seller_info = d.seller ? { name: d.seller, link: sellerEl?.getAttribute('href') || null } : null
      // 경쟁 판매자 수 — 상세페이지 "다른 판매자 보기(N)" (셀렉터 .other-sellers, CDP 실측 확정 2026-07-24)
      // 요소 있으면 N, 유효 페이지인데 요소 없으면 0(=단독 판매, 경쟁 없음). 차단 시엔 위에서 이미 리턴.
      let cs = null
      const csEl = S.detail.sellerCount ? document.querySelector(S.detail.sellerCount) : null
      if (csEl) { const m = (csEl.textContent || '').match(/\((\d{1,4})\)|(\d{1,4})/); if (m) cs = parseInt(m[1] || m[2]) }
      if (cs == null) {
        const bm = (document.body.innerText || '').match(/다른\s*판매자\s*보기\s*\((\d{1,4})\)/)
        cs = bm ? parseInt(bm[1]) : 0 // "다른 판매자" 표기 없음 = 단독 판매 = 0
      }
      d.competing_sellers = cs
    }
    if (inc('images')) {
      d.image_url = document.querySelector(S.detail.mainImages)?.getAttribute('src') || null
      d.detail_images = [...document.querySelectorAll(S.detail.detailImages)]
        .map((i) => i.getAttribute('src') || i.getAttribute('data-src')).filter(Boolean).slice(0, 50)
    }
    if (inc('delivery')) d.delivery_info = { text: txt(document.querySelector(S.detail.deliveryInfo)).slice(0, 500) || null }
    // 상품정보 테이블 → 제조사/원산지
    // 상품정보 테이블 → 제조사/원산지.
    // 쿠팡 2026 DOM 실측: 항목명이 <th> 가 아니라 <td> 에 있고 값은 "다음 셀"이다.
    //   <td>제조국(원산지)</td><td>중국</td>   <td>제조자(수입자)</td><td>SEVOREN</td>
    // 기존 코드는 tr 안에서 th=키, td=값으로 읽어 항상 빈 값이었다(원산지·제조사 100% 결손 원인).
    // 테이블 태그도 고정할 수 없으므로 문서 전체의 셀을 훑어 키 텍스트로 찾는다.
    const cells = [...document.querySelectorAll(S.detail.infoCells || 'td, th')]
    for (const cell of cells.slice(0, 400)) {
      const k = txt(cell)
      if (k.length > 40) continue                                  // 값 셀·본문 오탐 방지
      const v = txt(cell.nextElementSibling)
      if (!v || v.length > 200) continue
      if (!d.manufacturer && /제조사|제조자/.test(k)) d.manufacturer = v.slice(0, 200)
      if (!d.origin && /원산지|제조국/.test(k)) d.origin = v.slice(0, 200)
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
