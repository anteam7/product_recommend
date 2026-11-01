/**
 * 상품 등록 시 검색어(태그) 채우기 — 쿠팡 items[].searchTags 를 20개(1개 20자, 쿠팡 상품 생성 API 한도)까지 꽉 채운다 (2026-10-16)
 *
 *   등록기 11개가 전부 searchTags 없이 올려 왔다(2026-10-10 Wing 엑셀로 755건만 사람이 채움, 캠핑문 460건은 0개).
 *   1) 씨앗: 카테고리(leaf·'원본:' 이름) + 상품명 한글 명사(브랜드·규격·수량·모델코드 제외) + 끝 두 토큰 붙여쓰기
 *   2) 네이버 검색광고 키워드도구 → 연관 키워드 + 월간 검색수(실제 수요). 쿠팡엔 공개 검색량 API 가 없어 국내 검색 수요의 대리 지표로 쓴다
 *   3) Claude(구독 CLI, 기본 sonnet)가 후보에서 이 상품 고객이 실제로 칠 검색어를 고른다 — 키워드도구 결과엔 무관어(캠핑의자 → 골프화·캠핑카렌트),
 *      타사 브랜드(코베아화로대·뉴트리코어밀크씨슬), 효능·질병어(지방간영양제)가 섞여 규칙만으론 못 거른다
 *   4) 정제(허용 문자·20자·중복·광고성·효능어) 후 모자라면 규칙 기반 후보로 채움. 태그 생성 실패가 등록을 막지 않는다(빈 배열이면 종전과 같음)
 *
 *   토스(toss-register)는 쿠팡 리스팅 search_tags 를 토스 규칙(공백 없이 10자·10개)으로 걸러 재사용한다.
 *   env: SEARCH_TAGS_LLM=0 → Claude 생략(규칙만), SEARCH_TAGS_MODEL(기본 sonnet)
 */
import crypto from 'node:crypto'
import os from 'node:os'
import { spawn } from '../../../agent-fallback/child-process.mjs'

export const COUPANG_TAG_MAX = 20
export const COUPANG_TAG_LEN = 20

// 광고성(쿠팡·토스 상품명 정책과 같은 계열) — 태그에 넣으면 노출 제재 위험만 있고 검색 이득이 없다
// 정보성 검색어(사용법·부작용 …)·판매 경로(약국·병원)도 같이 — 상품을 사려는 검색이 아니거나 오인 소지
const AD_RE = /최저가|특가|할인|세일|무료배송|당일발송|당일출고|1위|1등|베스트|best|추천|인기|정품|사은품|증정|1\+1|이벤트|쿠폰|핫딜|가성비|최고|명품|가격|후기|순위|비교|파는곳|구매|판매|사용법|먹는법|복용법|부작용|차이|성분표|약국|병원|산부인과|처방/i
// 효능·질병·기능성 — 대부분 일반 가공식품·일반 화장품으로 등록돼 표시광고 위반 소지(화장품스토리 반려 원인도 상품명 기능성 표현). 상품명에 이미 있는 말만 허용
const CLAIM_WORDS = ['치료', '예방', '완화', '개선', '효능', '효과', '면역', '간건강', '간에좋은', '간영양제', '지방간', '혈압', '혈당', '혈행', '당뇨', '콜레스테롤', '다이어트', '체지방', '살빠', '피로회복', '숙취', '탈모', '여드름', '아토피', '염증', '관절염', '전립선', '갱년기', '불면', '수면제', '항암', '해독', '디톡스', '노화방지', '재생', '리페어', '미백', '주름', '브라이트닝', '화이트닝', '기미', '잡티제거', '탄력개선', '장건강', '눈건강', '뼈건강', '혈관', '항산화', '피부영양', '피부개선', '건강기능식품', '건기식', '에좋은', '변비', '냄새', '쾌변', '숙면', '혈당']
// 제형 — 상품명에 없으면 틀리기 쉽다(2026-10-16 시험: 캡슐 유산균에 "유산균분말", 글루타치온에 "글루타치온 가루"). 상품명에 있는 제형만 허용
// 1음절 '환'(환기·순환)과 '플라스틱'의 스틱은 오탐이라 뺀다
const FORM_RE = /분말|가루|파우더|캡슐|정제|알약|젤리|구미|(?<!플라)스틱|액상|앰플|시럽/g
// 규격·수량 태그("코큐텐60캡슐"·"100mg") — 상품명·옵션으로 이미 매칭되고 틀리기 쉽다("코큐텐 60정", 실물 60캡슐). "Q10"·"글로우99" 같은 이름 속 숫자는 단위가 없어 통과
const SPEC_RE = /\d+(mg|mcg|g|kg|ml|l|정|캡슐|포|개|개입|매|병|통|박스|ea|p|인용|인|cm|mm|개월분|회분|일분)(?![a-z가-힣])/i
const UNIT_TOK =/^\d|^[x×]\d|^[x×]$|\d+(g|kg|mg|mcg|ml|l|포|정|캡슐|병|매|박스|통|개|개입|개월분|회분|스틱|ea|p|단|인용|인|cm|mm|m|종|구|호|입)$/i
const NOISE_TOK = /^(재고정리|신상|신제품|정품|본사|프리미엄|슈퍼|골드|플러스|뉴|더|리얼|사은품증정|알약케이스|사은품|증정|단품|세트구성|국내산|국산|고강도|초대형|대형|소형|중형|미니|포함|전용|호환|기획|한정|특가|무료배송|당일발송)$/
const GENERIC_CAT = /^(기타|기타영양제|건강식품|기타건강식품|건강기능식품|식품|생활용품|스포츠|레저|스포츠레저|캠핑|뷰티|화장품|스킨케어)$/

const nospace = (s) => String(s ?? '').replace(/\s+/g, '')
const keyOf = (s) => nospace(s).toLowerCase()

/** 매입처 → 상품 성격(프롬프트 맥락) */
function kindOf(source) {
  if (source === 'cmtstory') return '화장품(일반 화장품으로 등록 — 기능성 인증 표현 금지)'
  if (source === 'campingmoon') return '캠핑·아웃도어 용품'
  if (source === 'domeatoz') return '브랜드 가공식품(과자·간식·소스 등 — 효능 표현 금지)'
  if (['ggsan', 'bio77', 'wellroot', 'upickb2b', 'kwholesale', 'domeggook'].includes(source)) return '건강식품(일반 가공식품으로 등록 — 효능·기능성 표현 금지)'
  return '일반 상품'
}

/** 카테고리 이름 → 씨앗 토큰: "식품>…>유산균", "기타영양제 (원본:쏘팔메토)", "선블록/선크림/선로션", "캠핑용 수납/선반" */
function categoryTokens(category) {
  const s = String(category ?? '')
  const orig = s.match(/원본\s*:\s*([^)]+)/)?.[1] ?? ''
  const base = s.replace(/\(?\s*원본\s*:[^)]*\)?/, '')
  const leaf = base.split('>').map((x) => x.trim()).filter(Boolean).pop() ?? ''
  const out = []
  for (const part of [...orig.split('/'), ...leaf.split('/')]) {
    const t = nospace(part).replace(/[^0-9A-Za-z가-힣]/g, '').replace(/^기타(?=.{2,})/, '')
    if (t.length >= 2 && !GENERIC_CAT.test(t)) out.push(t)
  }
  return [...new Set(out)]
}

/** 상품명 → 한글 명사 토큰(브랜드·규격·모델코드·잡음 제거, 순서 유지) */
function nameTokens(name, brand) {
  const brandKeys = new Set([brand, '캠핑문'].filter(Boolean).map(keyOf))
  return String(name ?? '')
    .replace(/캠핑문/g, ' ')
    .replace(/[^0-9A-Za-z가-힣\s]/g, ' ')
    .split(/\s+/)
    .map((t) => t.replace(/^[0-9A-Za-z-]+(?=[가-힣])/, '').replace(/(?<=[가-힣])[0-9A-Za-z-]+$/, '')) // "304스텐레스8P" → "스텐레스"
    .filter((t) => t.length >= 2 && /[가-힣]/.test(t) && !UNIT_TOK.test(t) && !NOISE_TOK.test(t) && !brandKeys.has(keyOf(t)))
}

export function seedKeywords({ name, brand, category }) {
  const cat = categoryTokens(category)
  const toks = nameTokens(name, brand)
  const seeds = [...cat]
  if (toks.length >= 2) seeds.push(toks.slice(-2).join(''))
  seeds.push(...[...toks].reverse())
  return [...new Set(seeds.map(nospace).filter((s) => s.length >= 2 && s.length <= 20))].slice(0, 10)
}

/** 네이버 검색광고 키워드도구: 씨앗(5개씩) → 연관 키워드 [{ k, v(월간 PC+모바일) }] (검색수 내림차순) */
export async function naverRelatedKeywords(seeds, env = process.env) {
  if (!env.NAVER_AD_API_KEY || !env.NAVER_AD_SECRET || !env.NAVER_AD_CUSTOMER_ID || !seeds.length) return []
  const out = new Map()
  const n = (v) => (v === '< 10' ? 5 : parseInt(v) || 0)
  for (let i = 0; i < seeds.length; i += 5) {
    const batch = seeds.slice(i, i + 5)
    const ts = String(Date.now())
    const sig = crypto.createHmac('sha256', env.NAVER_AD_SECRET).update(`${ts}.GET./keywordstool`).digest('base64')
    try {
      const r = await fetch(`https://api.searchad.naver.com/keywordstool?hintKeywords=${encodeURIComponent(batch.join(','))}&showDetail=1`, {
        headers: { 'X-Timestamp': ts, 'X-API-KEY': env.NAVER_AD_API_KEY, 'X-Customer': env.NAVER_AD_CUSTOMER_ID, 'X-Signature': sig },
        signal: AbortSignal.timeout(15000),
      })
      const j = await r.json().catch(() => ({}))
      for (const k of j.keywordList ?? []) {
        const key = nospace(k.relKeyword)
        const v = n(k.monthlyPcQcCnt) + n(k.monthlyMobileQcCnt)
        if (key && (!out.has(key) || out.get(key) < v)) out.set(key, v)
      }
    } catch { /* 배치 실패는 건너뜀 — 나머지 씨앗·규칙으로 채운다 */ }
    if (i + 5 < seeds.length) await new Promise((res) => setTimeout(res, 300))
  }
  return [...out].map(([k, v]) => ({ k, v })).sort((a, b) => b.v - a.v)
}

/** 허용 문자·길이·중복·광고성·효능어(상품명에 있는 말은 허용) 정제 */
export function sanitizeTags(tags, { name = '', max = COUPANG_TAG_MAX, maxLen = COUPANG_TAG_LEN, exclude = [] } = {}) {
  // 상품명 속 사은품("1개 알약케이스 사은품증정")은 상품이 아니다 — 그 이름이 든 태그는 버리고, 상품명 근거(효능어·제형 허용)에서도 뺀다
  //   '사은품' 이 붙은 꼴만 본다(bio77 정형 문구) — 그냥 "증정" 앞 단어는 상품 자체 제형일 수도 있다
  const freebies = [...String(name).matchAll(/(\S+?)\s*사은품\s*증정/g)].map((m) => keyOf(m[1])).filter((w) => w.length >= 2)
  const nameKey = keyOf(String(name).replace(/(\d+개\s*)?\S+?\s*사은품\s*증정/g, ' '))
  const seen = new Set(exclude.map(keyOf))
  const out = []
  for (const raw of tags) {
    const t = String(raw ?? '').replace(/[^0-9A-Za-z가-힣\s]/g, ' ').replace(/\s+/g, ' ').trim()
    const k = keyOf(t)
    if (!k || t.length > maxLen || seen.has(k)) continue
    if (/^\d+$/.test(k) || AD_RE.test(k) || SPEC_RE.test(k)) continue
    if (/^(일분|회분|개월분|개입|일치)$/.test(k)) continue // 규격 조각("50일분" → "일분", 2026-10-16 케일분말 제안)
    if (CLAIM_WORDS.some((w) => k.includes(w) && !nameKey.includes(w))) continue
    if ((k.match(FORM_RE) ?? []).some((w) => !nameKey.includes(w))) continue
    if (freebies.some((w) => k.includes(w))) continue
    const wordKey = t.toLowerCase().split(' ').sort().join('') // 어순만 다른 변형("코큐텐 캡슐"/"캡슐 코큐텐")
    if (t.includes(' ') && seen.has(wordKey)) continue
    seen.add(k)
    seen.add(wordKey)
    out.push(t)
    if (out.length >= max) break
  }
  return out
}

// 사실과 무관한 수식어만 — 형태·소재·대상·크기(분말·스텐·유아·소형 …)는 상품명에 있을 때만 붙는다(ctx 검사). 2026-10-16 시험: 캡슐 상품에 "유산균분말", 쿠킹랙에 "유아선반"
const GENERIC_MOD = new Set(['캠핑', '캠핑용', '차박', '차박용', '휴대용', '가정용', '여행용', '야외', '선물', '선물세트', '데일리'])

/** Claude 실패·생략 시: 씨앗 + "핵심 명사 + 일반 수식어" 꼴 후보(검색수순) — 타사 브랜드가 붙은 키워드(코베아화로대)는 수식어 목록에 없어 빠진다 */
function ruleTags({ name, brand, category, candidates }) {
  const cores = [...new Set([...categoryTokens(category), ...nameTokens(name, brand).slice(-2)])].filter((c) => c.length >= 2)
  const ctx = keyOf(`${name} ${category ?? ''}`)
  const picked = []
  for (const { k } of candidates) {
    const c = cores.find((x) => k.includes(x))
    if (!c) continue
    const rest = k.replace(c, '')
    if (!rest || GENERIC_MOD.has(rest) || (rest.length >= 2 && ctx.includes(rest.toLowerCase()))) picked.push(k)
  }
  return [...seedKeywords({ name, brand, category }), ...picked]
}

// cwd·allowedTools: 이미지 판독처럼 파일을 읽혀야 할 때만(domeatoz-spec-from-images.mjs — 이미지 폴더를 cwd 로, Read 만 허용)
export function callClaude(prompt, { model, timeoutMs = 150000, cwd = os.tmpdir(), allowedTools = null } = {}) {
  // claude CLI 는 ANTHROPIC_API_KEY 가 보이면 구독 대신 API 키로 인증 → 자식 env 에서 제거([[claude_cli_subprocess_env]]).
  // cwd 는 임시 폴더 — 레포 CLAUDE.md("AGENTS.md 먼저 읽기")가 붙어 도구를 쓰려 들지 않게.
  // --strict-mcp-config(+ --mcp-config 없음) = MCP 서버를 하나도 안 띄움: 없으면 플러그인 MCP(gitkraken 등)가 호출마다 떠서 안 죽고 쌓인다(2026-10-16 시험 24회 → 26쌍 잔류)
  const env = { ...process.env }
  delete env.ANTHROPIC_API_KEY; delete env.ANTHROPIC_AUTH_TOKEN; delete env.ANTHROPIC_BASE_URL
  return new Promise((resolve, reject) => {
    const args = ['-p', '--strict-mcp-config', '--output-format', 'json', '--model', model, ...(allowedTools ? ['--allowedTools', allowedTools] : [])]
    const child = spawn('claude', args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], shell: process.platform === 'win32' })
    let out = '', err = ''
    const timer = setTimeout(() => { child.kill(); reject(new Error(`claude ${timeoutMs / 1000}s 초과`)) }, timeoutMs)
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { err += d })
    child.on('error', (e) => { clearTimeout(timer); reject(e) })
    child.stdin.on('error', (e) => { clearTimeout(timer); reject(e) }) // CLI 가 stdin 을 읽기 전에 죽으면 EPIPE — 처리 안 하면 등록기 프로세스가 죽는다
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code !== 0) return reject(new Error(`claude exit=${code}: ${err.slice(0, 200)}`))
      try {
        const j = JSON.parse(out)
        if (j.is_error) return reject(new Error(`claude is_error: ${String(j.result).slice(0, 200)}`))
        resolve(String(j.result ?? ''))
      } catch { reject(new Error(`claude 응답 JSON 아님: ${out.slice(0, 200)}`)) }
    })
    child.stdin.end(prompt, 'utf8')
  })
}

/**
 * 응답에서 첫 번째 완결 JSON 객체 — sonnet 은 JSON 뒤에 설명·두 번째 블록을 덧붙이기도 해서 첫 { ~ 마지막 } 을 통째로 파싱하면
 * "Unexpected non-whitespace character after JSON" 으로 깨진다(2026-10-30 도매아토즈 드립). 못 찾으면 throw(호출부 catch 가 규칙 검색어로).
 */
export function firstJsonObject(text) {
  for (let s = text.indexOf('{'); s >= 0; s = text.indexOf('{', s + 1)) {
    let depth = 0, str = false, esc = false
    for (let i = s; i < text.length; i++) {
      const c = text[i]
      if (str) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') str = false; continue }
      if (c === '"') str = true
      else if (c === '{') depth++
      else if (c === '}' && --depth === 0) { try { return JSON.parse(text.slice(s, i + 1)) } catch { break } }
    }
  }
  throw new Error(`응답에 JSON 객체 없음: ${text.slice(0, 120)}`)
}

function buildPrompt({ name, brand, category, options, source, candidates, max }) {
  const list = candidates.slice(0, 150).map((c) => `${c.k}:${c.v}`).join(', ')
  return `쿠팡 판매자의 상품 검색어(태그) 담당으로서, 아래 상품을 쿠팡에서 찾는 고객이 실제로 검색창에 칠 검색어를 정확히 ${max}개, 중요한 순서로 골라라. 도구는 쓰지 말고 답만 출력한다.

[상품]
상품명: ${name}
카테고리: ${category || '-'}
${brand ? `브랜드: ${brand}\n` : ''}${options?.length ? `옵션: ${options.slice(0, 10).join(', ')}\n` : ''}성격: ${kindOf(source)}

[네이버 검색광고 연관 키워드 — 키워드:월간 검색수]
${list || '(없음)'}

[규칙]
1. 정확성이 검색수보다 우선이다. 이 상품 자체를 가리키는 말만 쓴다. 상품명·옵션에서 확인되지 않는 사양(성분·균주·함량·형태(분말/캡슐/젤리/스틱)·원산지·용량·색상·인원)은 넣지 않는다. 카테고리 이름은 참고용이다 — 상품명에 없는 성분은 카테고리에 있어도 넣지 않는다(예: 상품명이 글루타치온이고 카테고리가 콜라겐/히알루론산이면 콜라겐·히알루론산 금지).
2. 후보 중 맞는 키워드를 검색수 높은 순으로 고르고, 모자라면 동의어, 표기 변형(밀크씨슬/밀크시슬, 화로대/화롯대), 영문·줄임말, 사용 장면(차박·캠핑요리 등), 대상(성별·연령·선물)으로 채운다. 대상·선물 키워드는 합쳐 3개까지.
3. 넣지 말 것: 다른 회사 브랜드·모델명(이 상품 자신의 브랜드는 1개까지), 다른 제품 유형·다른 성분(코큐텐 상품에 유비퀴놀·종합영양제, 유산균에 프리바이오틱스, 의자에 테이블), 증정품·구성품 이름, 광고성 표현(최저가·특가·할인·무료배송·1위·베스트·추천·인기·정품·사은품·1+1·가격·후기), 효능·효과·질병·기능성 표현(면역·항산화·간건강·다이어트·피로회복·미백·주름개선·재생·피부개선, 건강기능식품·건기식 — 상품명에 이미 있는 표현만 예외), 정보성 검색어(사용법·부작용·먹는법·차이), 판매 경로(약국·병원).
4. 상품명 단어를 그대로 반복하기보다 상품명에 없는 검색 경로(동의어·상위 제품군·사용 장면)를 넓히는 키워드를 우선한다(핵심 제품명 붙여쓰기 1~2개는 허용). 검색수가 확인된 후보를 먼저 쓰고, 후보에 없는 말은 고객이 실제로 쓰는 표현일 때만. 애매하면 뺀다.
5. 규격·수량 숫자 태그(100mg·60캡슐·150ml·2개) 금지 — 쿠팡이 상품명·옵션으로 이미 매칭한다. 띄어쓰기·어순만 다른 변형(코큐텐 캡슐/코큐텐캡슐/캡슐 코큐텐)은 1개만.
6. 태그 하나는 20자 이내, 한글·영문·숫자·공백만, 서로 중복이거나 사실상 같은 말 금지.
7. 출력은 JSON 한 줄만: {"tags":["검색어1","검색어2",...]}`
}

/**
 * 상품 하나의 검색어 생성.
 * @param {{ name: string, brand?: string|null, category?: string|null, options?: string[], source?: string, max?: number, maxLen?: number, llm?: boolean }} p
 * @returns {Promise<{ tags: string[], via: 'claude'|'rule', candidates: number, error?: string }>}
 */
export async function buildSearchTags({ name, brand = null, category = null, options = [], source = '', max = COUPANG_TAG_MAX, maxLen = COUPANG_TAG_LEN, llm = true }) {
  const seeds = seedKeywords({ name, brand, category })
  const candidates = (await naverRelatedKeywords(seeds).catch(() => [])).filter((c) => !AD_RE.test(c.k))
  const rule = sanitizeTags(ruleTags({ name, brand, category, candidates }), { name, max, maxLen })
  if (!llm || process.env.SEARCH_TAGS_LLM === '0') return { tags: rule, via: 'rule', candidates: candidates.length }
  try {
    // 기본 opus: 2026-10-16 같은 6개 비교에서 sonnet(약 12초)은 실행마다 효능어(변비유산균)·다른 제형(글루타치온패치)·카테고리 오분류 성분(콜라겐)이 섞였고,
    // opus(30~60초)는 일관되게 정확했다. 등록은 백그라운드라 속도보다 정확도
    const model = /^[\w.-]+$/.test(process.env.SEARCH_TAGS_MODEL || '') ? process.env.SEARCH_TAGS_MODEL : 'opus' // shell:true 인자 가드
    // 정제에서 몇 개 빠져도 max 를 채우도록 4개 더 받는다(앞쪽일수록 중요). 그래도 모자라면 상품명 토큰으로만 채움 —
    // 규칙 후보(카테고리·수식어 조합)는 "유산균분말"(캡슐 상품)·"콜라겐"(글루타치온, 카테고리 오분류)처럼 사실과 어긋나는 게 섞여 Claude 뒤엔 안 붙인다
    const text = await callClaude(buildPrompt({ name, brand, category, options, source, candidates, max: max + 4 }), { model })
    const parsed = firstJsonObject(text)
    const picked = Array.isArray(parsed.tags) ? parsed.tags : []
    const toks = nameTokens(name, brand)
    const tags = sanitizeTags([...picked, ...(toks.length >= 2 ? [toks.slice(-2).join('')] : []), ...[...toks].reverse()], { name, max, maxLen })
    if (!picked.length) return { tags, via: 'rule', candidates: candidates.length, error: 'claude 응답에 tags 없음' }
    return { tags, via: 'claude', candidates: candidates.length }
  } catch (e) {
    return { tags: rule, via: 'rule', candidates: candidates.length, error: e.message }
  }
}

/**
 * 쿠팡 등록 payload 의 모든 item 에 같은 searchTags 를 채운다(이미 있으면 그대로). 실패해도 throw 하지 않는다.
 * @returns {Promise<string[]>} 채운 태그(리스팅 search_tags 기록용)
 */
export async function fillSearchTags(payload, { category = null, brand, source = '', llm = true, log = console.log } = {}) {
  const items = payload?.items ?? []
  const existing = items.find((it) => it.searchTags?.length)?.searchTags
  if (existing) return existing
  const name = payload.displayProductName || payload.sellerProductName || ''
  const options = [...new Set(items.map((it) => it.itemName).filter(Boolean))]
  try {
    const r = await buildSearchTags({ name, brand: brand ?? payload.brand ?? null, category, options, source, llm })
    for (const it of items) it.searchTags = [...r.tags]
    log(`      🏷 검색어 ${r.tags.length}개(${r.via === 'claude' ? 'Claude' : '규칙'}, 키워드도구 후보 ${r.candidates})${r.error ? ` ⚠ ${r.error.slice(0, 80)}` : ''}: ${r.tags.join(', ')}`)
    return r.tags
  } catch (e) {
    log(`      ⚠ 검색어 생성 실패(태그 없이 등록): ${e.message}`)
    return []
  }
}

// ── 기존 리스팅 노출상품명 + 검색어 정비 (2026-10-16 사장님: "태그를 꽉 채우면서 상품명도 전부 확인해 소구력 있는 키워드가 들어가게") ──
// 쿠팡 노출상품명 공식 = 브랜드 + 제품명 + 상품군(Wing 수정요청 엑셀 Help). 길이는 Wing 실패 사유 "최대 50자" 기준(API 한도 100자보다 엄격하게)
export const DISPLAY_NAME_MAX = 50
const NAME_BAD_CHARS = /[※☆★♥♡▶◀◆■□【】〈〉「」『』]|[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/u
// 판매자 메모·광고성 — 현재 이름에 있어도 새 이름엔 남기지 않는다("상품 모음전", "재고정리", "(세트상품)")
const NAME_MEMO_RE = /재고정리|모음전|세트상품|기획전|신상품|특가|할인|세일|무료배송|당일발송|최저가|정품|베스트|1위|사은품|증정|이벤트/

/**
 * 새 노출상품명 검증·정리. brand 를 주면 맨 앞에 한 번만 두고 나머지 자리의 같은 말은 지운다(사장님 2026-10-16: 캠핑문은 브랜드로 맨 앞만).
 * @returns {{ ok: true, name: string } | { ok: false, why: string }}
 */
export function checkDisplayName(name, { current = '', brand = null } = {}) {
  let n = String(name ?? '').replace(/\s+/g, ' ').trim()
  if (!n) return { ok: false, why: '빈 이름' }
  if (NAME_BAD_CHARS.test(n)) return { ok: false, why: '금지 특수문자' }
  if (brand) n = `${brand} ${n.split(brand).join(' ').replace(/\s+/g, ' ').trim()}`.trim()
  const len = [...n].length
  if (len > DISPLAY_NAME_MAX) return { ok: false, why: `${len}자 > ${DISPLAY_NAME_MAX}자` }
  if (len < 6) return { ok: false, why: `${len}자 — 너무 짧음` }
  if (NAME_MEMO_RE.test(n)) return { ok: false, why: `판매자 메모·광고성(${n.match(NAME_MEMO_RE)[0]})` }
  const curKey = keyOf(current)
  const claim = CLAIM_WORDS.find((w) => keyOf(n).includes(w) && !curKey.includes(w))
  if (claim) return { ok: false, why: `새 효능·기능성 표현(${claim})` }
  // 현재 이름의 규격(용량·수량·개수·"x 30포")은 새 이름에 그대로 있어야 한다 — 2026-10-16 시험: "유기농 컬리케일 분말 2g x 30포" → "… 케일가루 2g"(30포 누락)
  const newKey = keyOf(n).replace(/,/g, '')
  const lost = specTokens(current).find((s) => !newKey.includes(s))
  if (lost) return { ok: false, why: `규격 누락(${lost})` }
  return { ok: true, name: n }
}

const SPEC_TOKEN_RE = /\d+(?:[.,]\d+)?\s*(?:mg|mcg|kg|g|ml|l|정|캡슐|포|개입|개|매|병|통|박스|ea|p|인용|cm|mm|일분|회분|개월분)(?![a-z가-힣])|[x×]\s*\d+/gi
function specTokens(name) {
  return [...new Set((String(name ?? '').match(SPEC_TOKEN_RE) ?? []).map((s) => keyOf(s).replace(/,/g, '').replace(/^×/, 'x')))]
}

function buildNamePrompt(ctx, tagCount) {
  const blocks = ctx.map((p, i) => [
    `[상품 ${i + 1}] id=${p.id}`,
    `현재 노출상품명: ${p.name}`,
    p.sellerName && p.sellerName !== p.name ? `등록상품명(공급사 원문): ${p.sellerName}` : null,
    `카테고리: ${p.category || '-'}`,
    `성격: ${kindOf(p.source)}`,
    p.brandFirst ? `브랜드: ${p.brandFirst} (상품명 맨 앞에 한 번만)` : null,
    p.options?.length ? `옵션(구매 선택지): ${p.options.slice(0, 12).join(' / ')}` : null,
    p.tags?.length ? `현재 검색어: ${p.tags.join(', ')}` : '현재 검색어: (없음)',
    p.info ? `공급사 설명(참고, 사실 확인용): ${p.info}` : null,
    `연관 키워드(네이버 월간 검색수): ${p.candidates.slice(0, 60).map((c) => `${c.k}:${c.v}`).join(', ') || '(없음)'}`,
  ].filter(Boolean).join('\n')).join('\n\n')
  return `쿠팡 판매자의 상품명·검색어 담당으로서 아래 상품 ${ctx.length}개 각각의 (1) 노출상품명 (2) 검색어 ${tagCount}개(중요한 순)를 정해라. 도구는 쓰지 말고 답만 출력한다.

[노출상품명 규칙]
1. 쿠팡 공식 "브랜드 + 제품명 + 상품군"(예: 나이키 레볼루션 여성운동화). ${DISPLAY_NAME_MAX}자 이내, 자연스러운 한 상품명(키워드 나열·도배 금지).
2. 브랜드가 주어지면 맨 앞에 한 번만 쓴다(붙여 쓴 "캠핑문이그나이터"는 띄우고, 중간·끝의 브랜드 반복은 지운다). 브랜드가 없으면 현재 이름 앞의 브랜드를 유지한다.
3. 고객이 검색창에 치는 상품군·핵심어(연관 키워드 중 검색수 높고 이 상품에 사실인 것)가 들어가게 한다. 예: "캠핑문 이그나이터 I-1010" → "캠핑문 이그나이터 캠핑 점화기 토치".
4. 모든 옵션에 공통인 사실만 쓴다 — 색상·사이즈 같은 옵션별 값은 넣지 않는다. 상품명·옵션·공급사 설명에서 확인되지 않는 사양·성분·인증·인원·소재는 넣지 않는다.
5. 지울 것: 공급사 내부 코드(FXH·ck-b·S-397-2S 같은 것 — 단 고객이 찾는 모델명은 끝에 남겨도 됨), 판매자 메모("상품 모음전"·"재고정리"·"(세트상품)"·"4가지"), 광고성(최저가·특가·할인·무료배송·정품·베스트·1위·사은품·증정), 효능·질병·기능성 표현(면역·관절·다이어트·미백·주름개선 등 — 현재 이름에 이미 있는 공식 제품명의 일부는 그대로), 특수문자(※☆★ 등).
6. 용량·수량·개수처럼 모든 옵션에 공통인 규격은 유지한다. 현재 이름이 이미 좋으면 그대로 둔다.

[검색어 규칙]
1. 정확성이 검색수보다 우선이다. 이 상품 자체를 가리키는 말만. 상품명·옵션에서 확인되지 않는 사양(성분·균주·함량·형태·원산지·용량·색상·인원)은 넣지 않는다. 카테고리 이름은 참고용 — 상품명에 없는 성분은 카테고리에 있어도 넣지 않는다.
2. 현재 검색어 중 정확한 것은 유지하고, 연관 키워드 중 맞는 것을 검색수 높은 순으로 더한다. 모자라면 동의어·표기 변형·영문·사용 장면·대상(성별·연령·선물, 합쳐 3개까지)으로 채운다.
3. 넣지 말 것: 다른 회사 브랜드·모델명(자기 브랜드는 1개까지), 다른 제품 유형·다른 성분, 증정품·구성품 이름, 광고성 표현, 효능·질병·기능성 표현(건강기능식품·건기식 포함, 상품명에 이미 있는 표현만 예외), 정보성 검색어(사용법·부작용·차이), 판매 경로(약국·병원), 규격·수량 숫자(100mg·60캡슐·2개).
4. 띄어쓰기·어순만 다른 변형은 1개만. 태그 하나는 20자 이내, 한글·영문·숫자·공백만.

${blocks}

출력은 JSON 한 줄만: {"items":[{"id":"상품 id","name":"새 노출상품명","tags":["검색어",...]}, ...]}`
}

/**
 * 상품 여러 개(배치)의 노출상품명 + 검색어 제안 — Claude 1회 호출. 쿠팡에는 아무것도 쓰지 않는다.
 * @param {Array<{ id: string, name: string, sellerName?: string, category?: string, options?: string[], tags?: string[], source?: string, brandFirst?: string|null, info?: string }>} products
 * @returns {Promise<Map<string, { name: string|null, nameWhy?: string, tags: string[], candidates: number, error?: string }>>}
 */
export async function proposeNameAndTags(products, { max = COUPANG_TAG_MAX, timeoutMs = 420000 } = {}) {
  const ctx = []
  for (const p of products) {
    const seeds = seedKeywords({ name: `${p.name} ${p.sellerName ?? ''}`, brand: p.brandFirst, category: p.category })
    const candidates = (await naverRelatedKeywords(seeds).catch(() => [])).filter((c) => !AD_RE.test(c.k))
    ctx.push({ ...p, candidates })
  }
  const model = /^[\w.-]+$/.test(process.env.SEARCH_TAGS_MODEL || '') ? process.env.SEARCH_TAGS_MODEL : 'opus' // buildSearchTags 와 같은 이유로 opus
  const out = new Map()
  let parsed
  try {
    const text = await callClaude(buildNamePrompt(ctx, max + 4), { model, timeoutMs })
    parsed = firstJsonObject(text)
  } catch (e) {
    // 배치 실패는 상품마다 error 로 돌려준다 — 호출부가 다음 회차에 다시 시도(제안이 없으면 쿠팡엔 아무것도 안 바뀜)
    for (const p of ctx) out.set(String(p.id), { name: null, tags: [], candidates: p.candidates.length, error: `Claude 실패: ${e.message.slice(0, 120)}` })
    return out
  }
  for (const p of ctx) {
    const hit = (Array.isArray(parsed.items) ? parsed.items : []).find((x) => String(x?.id) === String(p.id))
    if (!hit) { out.set(String(p.id), { name: null, tags: [], candidates: p.candidates.length, error: 'Claude 응답에 이 상품 없음' }); continue }
    const chk = checkDisplayName(hit.name, { current: p.name, brand: p.brandFirst })
    const finalName = chk.ok ? chk.name : null
    const toks = nameTokens(finalName ?? p.name, p.brandFirst)
    const tags = sanitizeTags([...(Array.isArray(hit.tags) ? hit.tags : []), ...[...toks].reverse()], { name: `${p.name} ${finalName ?? ''}`, max })
    out.set(String(p.id), { name: finalName, ...(chk.ok ? {} : { nameWhy: chk.why, rawName: hit.name }), tags, candidates: p.candidates.length })
  }
  return out
}
