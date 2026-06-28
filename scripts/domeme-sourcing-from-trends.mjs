/**
 * 위탁 상품발굴 도출: 짐스캐너 트렌드 신호 → 도매매(위탁) 검색 → 시장가 매칭 → 마진순 '팔 상품' 후보.
 *
 *   ① jimscanner_trends_keywords 에서 커머스 소스 최근 N일 키워드를 가중·정규화·중복제거로 선별
 *   ② 각 키워드를 도매매(getItemList&market=supply) 검색 → 제목 유사도로 관련 상품만
 *   ③ 시장가(경쟁가): 쿠팡 CDP(사람처럼 검색) 우선, 없으면 네이버 쇼핑 OpenAPI 중앙값
 *   ④ 마진 = safeCost(시장가) vs 도매매 공급가 → 신호강도 × 마진율 = sourcing_score
 *   ⑤ jimscanner_domeme_sourcing_candidates 에 upsert (+ 리포트/JSON)
 *
 * 사용:
 *   node --env-file=.env.local scripts/domeme-sourcing-from-trends.mjs            # 기본(DB 저장)
 *   ... --days=7 --limit=40 --max-per-kw=2 --margin=0.20                          # 파라미터
 *   ... --kw="차량용 무선충전기"                                                  # 단일 키워드 테스트
 *   ... --dry                                                                     # DB 미저장(콘솔만)
 *   ... --no-coupang                                                              # 쿠팡 CDP 생략(네이버만)
 *
 * 쿠팡 시장가를 쓰려면: 크롬을 `--remote-debugging-port=9222` 로 띄우고 쿠팡 1회 접속(워밍업) 후 실행.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { createClient } from '@supabase/supabase-js'
import { naverShopMedian, coupangMedianViaCDP } from './lib/market-price.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const env = Object.fromEntries(
  readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8').split(/\r?\n/).filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => { const i = l.indexOf('='); let v = l.slice(i + 1).trim(); if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1); return [l.slice(0, i).trim(), v] }),
)
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY)
const DKEY = env.DOMEGGOOK_API_KEY
const DBASE = 'https://domeggook.com/ssl/api/'

// ── args ──
const args = process.argv.slice(2)
const flag = (k) => args.includes(`--${k}`)
const getArg = (k, d) => { const a = args.find((x) => x.startsWith(`--${k}=`)); return a ? a.split('=').slice(1).join('=') : d }
const DAYS = parseInt(getArg('days', '7'))
const LIMIT = parseInt(getArg('limit', '40'))
const MAX_PER_KW = parseInt(getArg('max-per-kw', '2'))
const MARGIN = parseFloat(getArg('margin', '0.20'))
const SINGLE_KW = getArg('kw', '')
const DRY = flag('dry')
const USE_COUPANG = !flag('no-coupang')
const FEE = 0.108, LOGI = 3000

// ── 소스 가중치 (수요의 질 기준) ──
// 네이버 쇼핑/검색/TV는 '소비자 수요'(우리가 파는 쿠팡·네이버 시장의 신호) → 상위.
// 도매꾹은 '공급측'(다른 셀러가 떼가는 것) 신호라 레드오션 편향 + 매칭은 어차피 도매매검색이 보장 → 낮게.
// 무신사는 브랜드패션이라 도매매 부적합 → 최하 / 뉴스·커뮤는 제외.
const SOURCE_WEIGHT = {
  naver_shopping_hot: 1.3, naver_shopping_insight: 1.2, naver_search_trend: 1.1,
  naver_tvtime: 1.1, aliex_best: 1.0, domeggook_main: 0.8, musinsa_best: 0.4,
}

// ── 유사도 ──
const norm = (s) => (s || '').toLowerCase().replace(/[^가-힣a-z0-9]+/g, '')
function bigrams(s) { const t = norm(s); const g = new Set(); for (let i = 0; i < t.length - 1; i++) g.add(t.slice(i, i + 2)); return g }
function sim(a, b) { const A = bigrams(a), B = bigrams(b); if (!A.size || !B.size) return 0; let c = 0; for (const x of A) if (B.has(x)) c++; return 2 * c / (A.size + B.size) }

// ── 키워드 정규화: 옵션/모델코드/색상변형/마케팅꼬리/노이즈 제거 ──
// 브랜드·플랫폼·카테고리 일반어(소싱 키워드로 무의미 → 시장가 매칭 오염). 단일 토큰일 때만 차단.
// 단일 토큰 일반어(브랜드·플랫폼·카테고리)
const STOPWORDS = new Set([
  '무신사', '콘텐츠', '스포츠', '패션', '브랜드', '의류', '뷰티', '신발', '운동화', '가방',
  '액세서리', '아우터', '상의', '하의', '전체', '인기', '추천', '신상', '기획전',
  '베스트', 'best', 'brand', '쿠팡', '네이버', '알리', '직구', '할인', '특가',
])
// 쇼핑몰 네비/UI 라벨(도매꾹·무신사 사이트 메뉴가 수집기에 새어들어옴) — 토큰수 무관 정확매칭 차단
const PHRASE_STOP = new Set([
  '전체브랜드', '이용안내', '판매관리', '최신할인', '특가예정', '마이페이지', '고객센터',
  '로그인', '회원가입', '장바구니', '주문배송', '공지사항', '자주묻는질문', '상품문의', '구매후기',
])
function cleanKeyword(s) {
  let t = (s || '').trim()
  if (!t) return ''
  t = t.split(/\s*\/\s*/)[0]                         // "핸디선풍기 / 판촉물 인쇄가능!!" → 앞 토막만
    .replace(/\[[^\]]*\]/g, ' ')                      // [블랙] [쿨탠다드]
    .replace(/\([^)]*\)/g, ' ')                       // (5 colors)
    .replace(/[!~★☆♥♡]+/g, ' ')                      // 마케팅 문장부호
    .replace(/\s*-\s*[가-힣A-Za-z]+(?::[가-힣A-Za-z]+)+.*$/g, '') // 끝의 - 블랙:크림화이트 색상조합
    .replace(/\s*-\s*[^-]{1,8}$/g, '')                // 끝의 짧은 - 변형(단색 등)
    .replace(/\s+/g, ' ').trim()
  if (PHRASE_STOP.has(norm(t))) return ''            // 사이트 네비 라벨(토큰수 무관)
  const tokens = t.split(/\s+/).filter(Boolean)
  // 단일 토큰: 스톱워드이거나 너무 짧으면(일반명사) 제거. 다중 토큰은 구체적이라 통과.
  if (tokens.length <= 1) {
    if (STOPWORDS.has(t) || STOPWORDS.has(norm(t))) return ''
    if (norm(t).length < 4) return ''                // 스포츠/콘텐츠/선풍기 등 짧은 일반어 차단
  }
  if (norm(t).length < 2) return ''
  return t
}

// ── 도매매/도매꾹 검색 ──
async function domeSearch(kw, market) {
  const url = `${DBASE}?ver=4.1&mode=getItemList&aid=${DKEY}&market=${market}&om=json&kw=${encodeURIComponent(kw)}&sz=40&pg=1`
  try {
    const r = await fetch(url); const j = JSON.parse(await r.text())
    let items = j?.domeggook?.list?.item ?? j?.list?.item ?? []
    items = Array.isArray(items) ? items : [items]
    return items.map((it) => ({
      goods_no: String(it.no), title: it.title, price: parseInt(it.price) || null,
      moq: parseInt(it.unitQty) || 1,                                    // 위탁(supply) 최소구매수량
      overseas: String(it?.deli?.fromOversea).toLowerCase() === 'true',  // 해외출고 여부(목록에 포함됨)
      ship_fee: parseInt(it?.deli?.fee) || null,                         // 위탁 배송비(참고)
      thumb: it.thumb || it.img || null,
      // API가 마켓별 상세 URL을 줌 — supply 검색이면 도매매(domeme.domeggook.com/s/<no>) 링크.
      url: it.url ? String(it.url).replace(/^http:\/\//i, 'https://') : `https://domeme.domeggook.com/s/${it.no}`,
    })).filter((x) => x.price && x.title)
  } catch (e) { console.log(`  (도매매 검색 오류 "${kw}": ${e.message})`); return [] }
}

// 도매매 상세(이미지/재고 보강) — 최종 후보에만 호출
async function domeView(no) {
  try {
    const r = await fetch(`${DBASE}?ver=4.1&mode=getItemView&aid=${DKEY}&no=${no}&om=json`)
    const d = JSON.parse(await r.text())?.domeggook
    if (!d) return null
    return {
      image_url: d?.thumb?.original || d?.thumb?.large || null,
      inventory: parseInt(d?.qty?.inventory) || null,
      supply_price: parseInt(d?.price?.supply) || null,
      category: typeof d?.category === 'string' ? d.category : (d?.category?.name || null),
      overseas: String(d?.deli?.fromOversea).toLowerCase() === 'true', // 문자열 "true"/"false" — !! 쓰면 "false"도 truthy
    }
  } catch { return null }
}

// ── 키워드 선별 ──
async function selectKeywords() {
  if (SINGLE_KW) return [{ keyword: SINGLE_KW, signal: 1, sources: ['manual'] }]
  const since = new Date(Date.now() - DAYS * 864e5).toISOString()
  const { data, error } = await sb.from('jimscanner_trends_keywords')
    .select('keyword, source, collected_at')
    .gte('collected_at', since)
    .in('source', Object.keys(SOURCE_WEIGHT))
    .limit(8000)
  if (error) throw new Error(`trends_keywords 조회 실패: ${error.message}`)
  const agg = new Map()
  for (const r of data || []) {
    const w = SOURCE_WEIGHT[r.source] || 0
    if (!w) continue
    const k = cleanKeyword(r.keyword)
    if (!k) continue
    const e = agg.get(k) || { keyword: k, signal: 0, sources: new Set() }
    e.signal += w; e.sources.add(r.source); agg.set(k, e)
  }
  let arr = [...agg.values()].map((e) => ({ keyword: e.keyword, signal: Math.round(e.signal * 100) / 100, sources: [...e.sources] }))
  arr = await filterAlreadyListed(arr)
  arr.sort((a, b) => b.signal - a.signal)
  return arr.slice(0, LIMIT)
}

// 이미 등록된 쿠팡 상품과 겹치는 키워드 제외
async function filterAlreadyListed(arr) {
  const { data } = await sb.from('jimscanner_coupang_listings').select('product_name').in('status', ['SELLING', 'APPROVED', 'PENDING_APPROVAL']).limit(3000)
  const norms = (data || []).map((r) => norm(r.product_name)).filter(Boolean)
  return arr.filter((e) => { const nk = norm(e.keyword); return nk.length >= 3 && !norms.some((n) => n.includes(nk)) })
}

// ── 메인 ──
async function main() {
  console.log(`=== 도매매 위탁 소싱 도출 (최근 ${DAYS}일 · 키워드 ${LIMIT} · 수수료 ${FEE * 100}% · 물류 ${LOGI} · 목표순익 ${MARGIN * 100}%) ===`)
  if (!DKEY) { console.error('DOMEGGOOK_API_KEY 없음'); process.exit(1) }
  // 쿠팡 CDP 가용성 1회 확인 — 안 떠 있으면 키워드마다 4초씩 낭비하지 않도록 처음부터 비활성
  let useCoupang = USE_COUPANG
  if (useCoupang) {
    const cdpUp = await fetch('http://127.0.0.1:9222/json/version', { signal: AbortSignal.timeout(2000) }).then((r) => r.ok).catch(() => false)
    if (!cdpUp) { useCoupang = false; console.log('쿠팡 CDP(9222) 미가동 → 네이버 시장가만 사용 (크롬을 --remote-debugging-port=9222 로 띄우면 쿠팡가 사용)') }
  }
  const keywords = await selectKeywords()
  console.log(`선별 키워드 ${keywords.length}개${useCoupang ? ' · 쿠팡 CDP 사용' : ' · 네이버만'}\n`)

  const byProduct = new Map() // goods_no → best candidate
  let coupangOk = 0, naverOk = 0, dropMoq = 0, dropOversea = 0
  for (const k of keywords) {
    const supply = await domeSearch(k.keyword, 'supply')
    // 위탁 1개 판매 가능(MOQ≤1) + 국내출고(해외 제외)만 — 사장님 소싱 기준
    const sellable = supply.filter((c) => {
      if (c.moq >= 2) { dropMoq++; return false }
      if (c.overseas) { dropOversea++; return false }
      return true
    })
    const rel = sellable
      .map((c) => ({ ...c, s: sim(k.keyword, c.title) }))
      .filter((c) => norm(c.title).includes(norm(k.keyword)) || c.s >= 0.3)
      .sort((a, b) => a.price - b.price)
    if (!rel.length) { console.log(`  · "${k.keyword}" 도매매 관련상품 없음(검색 ${supply.length}건)`); continue }

    // 시장가: 쿠팡(CDP) 우선 → 네이버 폴백
    let mp = null
    if (useCoupang) { mp = await coupangMedianViaCDP(k.keyword); if (mp?.median) coupangOk++ }
    if (!mp || !mp.median) { try { mp = await naverShopMedian(k.keyword); if (mp?.median) naverOk++ } catch (e) { console.log(`  (네이버 시장가 오류 "${k.keyword}": ${e.message})`) } }
    if (!mp || !mp.median) { console.log(`  · "${k.keyword}" 시장가 조회 실패`); continue }

    const sc = Math.round(mp.median * (1 - FEE - MARGIN) - LOGI) // safe cost
    const scored = rel.map((c) => {
      const estMarginKrw = mp.median - c.price - Math.round(mp.median * FEE) - LOGI
      const estMarginRate = Math.round((estMarginKrw / mp.median) * 1000) / 10
      return { ...c, market_source: mp.source, market_price: mp.median, safe_cost: sc, est_margin_krw: estMarginKrw, est_margin_rate: estMarginRate, sourcing_score: Math.round(k.signal * Math.max(0, estMarginRate) * 10) / 10, trend_keyword: k.keyword, trend_signal: k.signal, trend_sources: k.sources }
    }).filter((c) => c.est_margin_krw > 0).sort((a, b) => b.sourcing_score - a.sourcing_score).slice(0, MAX_PER_KW)

    for (const c of scored) {
      const prev = byProduct.get(c.goods_no)
      if (!prev || c.sourcing_score > prev.sourcing_score) byProduct.set(c.goods_no, c)
    }
    if (scored.length) console.log(`  ✅ "${k.keyword}" 신호${k.signal} → 시장가(${mp.source}) ${mp.median.toLocaleString()} | 후보 ${scored.length} (top 마진 ${scored[0].est_margin_rate}%)`)
  }

  let finals = [...byProduct.values()].sort((a, b) => b.sourcing_score - a.sourcing_score)
  console.log(`\n=== 도출 완료: ${finals.length}개 상품 후보 (시장가 출처 쿠팡 ${coupangOk}·네이버 ${naverOk}) ===`)
  console.log(`   소싱기준 제외(검색결과 기준): MOQ≥2 ${dropMoq}건 · 해외출고 ${dropOversea}건`)

  // 상세 보강(이미지/재고) — 상위 후보만
  // overseas 는 목록 단계에서 이미 확정(필터 통과 = 국내) — 여기서 덮어쓰지 않음
  for (const c of finals.slice(0, 60)) { const v = await domeView(c.goods_no); if (v) { c.image_url = v.image_url; c.inventory = v.inventory; c.category = v.category; if (v.supply_price) c.supply_price_view = v.supply_price } }

  // 리포트
  for (const c of finals.slice(0, 25)) {
    console.log(`  ${String(c.sourcing_score).padStart(6)} | 마진 ${String(c.est_margin_rate + '%').padStart(6)} | 공급 ${String(c.price).toLocaleString().padStart(8)} / 시장 ${String(c.market_price).toLocaleString().padStart(8)}(${c.market_source}) | "${c.trend_keyword}" → ${(c.title || '').slice(0, 36)}`)
  }

  // JSON 덤프
  const outDir = path.join(__dirname, 'out'); try { mkdirSync(outDir, { recursive: true }) } catch { /* noop */ }
  const stamp = getArg('stamp', '') || 'latest'
  const outPath = path.join(outDir, `domeme-sourcing-${stamp}.json`)
  writeFileSync(outPath, JSON.stringify({ generatedDays: DAYS, margin: MARGIN, keywords: keywords.length, candidates: finals }, null, 2), 'utf8')
  console.log(`\nJSON: ${outPath}`)

  if (DRY) { console.log('--dry: DB 저장 생략'); return }
  await upsert(finals)
}

// ── DB upsert ──
async function upsert(finals) {
  if (!finals.length) { console.log('저장할 후보 없음'); return }
  const nowIso = new Date().toISOString()
  const rows = finals.map((c) => ({
    supplier: 'domeme', supplier_goods_no: c.goods_no, title: c.title,
    supply_price: c.price, moq: c.moq, inventory: c.inventory ?? null, overseas: c.overseas ?? null, category_hint: c.category ?? null,
    trend_keyword: c.trend_keyword, trend_signal: c.trend_signal, trend_sources: c.trend_sources,
    market_source: c.market_source, market_price: c.market_price, safe_cost: c.safe_cost,
    est_margin_krw: c.est_margin_krw, est_margin_rate: c.est_margin_rate, sourcing_score: c.sourcing_score,
    image_url: c.image_url ?? null, detail_url: c.url, last_sourced_at: nowIso,
  }))
  const { error } = await sb.from('jimscanner_domeme_sourcing_candidates').upsert(rows, { onConflict: 'supplier,supplier_goods_no' })
  if (error) { console.error(`DB 저장 실패: ${error.message}\n(테이블 미생성 시 supabase/domeme_sourcing_candidates.sql DDL 적용 필요)`); process.exitCode = 2; return }
  console.log(`DB 저장: ${rows.length}건 → jimscanner_domeme_sourcing_candidates`)
}

main().catch((e) => { console.error('파이프라인 오류:', e instanceof Error ? e.stack : e); process.exit(1) })
