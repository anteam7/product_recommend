#!/usr/bin/env node
/**
 * 도매아토즈 상세 이미지(식품 표시사항)에서 낱개 중량·용량과 총 낱개 수를 읽어 쿠팡 구매옵션 규격을 채운다
 * — 사장님 2026-11-01 "구매옵션 247건 중량 채워서 등록 진행해".
 *
 *  - 대상: 판매중 · 등록 제외 사유 '구매옵션 —'(개수만 있는 이름 "100T"인데 중량 필수 카테고리, "+"·"각N개" 세트 이름 등)
 *  - 상세 이미지는 esmplus CDN(도매아토즈 상세 페이지 ~50회 차단과 무관) 860x400 한두 장이고 "내용량 3,510g (11.7g * 300개) x 4박스" 가 적혀 있다
 *  - Claude CLI(구독, Read 로 이미지 열람)가 배치로 읽는다 → 이미지 글자에 낱개 값이 그대로 있고, 이름에 개수가 있으면 그 개수와 맞는 것만
 *    scripts/lib/domeatoz-unit-spec.json 에 쌓는다(재실행 시 이미 읽은 상품은 건너뜀). 등록기가 이름으로 규격을 못 만들 때 이 파일을 쓴다.
 *
 *   node --env-file=.env.local scripts/domeatoz-spec-from-images.mjs [--limit=N] [--batch=8] [--only=idx,…] [--dry] [--retry-rejected]
 *   env SPEC_IMAGE_MODEL(기본 sonnet)
 */
import os from 'node:os'
import path from 'node:path'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createClient } from '@supabase/supabase-js'
import { specOf } from './lib/domeatoz-spec.mjs'
import { callClaude, firstJsonObject } from './lib/search-tags.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const OUT = path.join(__dirname, 'lib', 'domeatoz-unit-spec.json')
const IMG_DIR = path.join(os.tmpdir(), 'domeatoz-spec-img') // 레포 밖 — cwd 가 레포면 CLAUDE.md 가 붙어 엉뚱한 파일을 읽으려 든다
const args = process.argv.slice(2)
const arg = (k) => args.find((a) => a.startsWith(`--${k}=`))?.split('=')[1]
const LIMIT = +(arg('limit') || 0), BATCH = Math.max(1, +(arg('batch') || 8)), DRY = args.includes('--dry')
const ONLY = (arg('only') || '').split(',').filter(Boolean)
const MODEL = /^[\w.-]+$/.test(process.env.SPEC_IMAGE_MODEL || '') ? process.env.SPEC_IMAGE_MODEL : 'sonnet' // shell:true 인자 가드
if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) { console.error('Supabase 환경변수 없음 — node --env-file=.env.local 로 실행'); process.exit(64) }
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)

let store = {}
// 깨진 파일을 {} 로 덮어쓰면 판독 결과가 통째로 사라진다 → 멈추고 사람이 본다
try { if (existsSync(OUT)) store = JSON.parse(readFileSync(OUT, 'utf8')) } catch (e) { console.error(`${OUT} 해석 실패(${e.message}) — 파일을 고친 뒤 다시 실행`); process.exit(65) }
const save = () => { if (!DRY) writeFileSync(OUT, JSON.stringify(Object.fromEntries(Object.entries(store).sort(([a], [b]) => a.localeCompare(b))), null, 1) + '\n') }

/** 이름이 말하는 총 낱개 수 — 세트가 아니면 specOf 개수, 세트면 "총N"만(그 밖 세트는 이름으로 확인 불가 → null) */
function expectedPieces(name) {
  const s = specOf(name), n = String(name || '')
  const outside = n.replace(/\([^)]*\)|\[[^\]]*\]/g, ' ')
  const lead = /(\d+)\s*(?:T|티)(?![a-zA-Z가-힣])/.exec(outside) // "500티(250Tx2개)"·"170T (150T+20T)" — 괄호 밖 앞 개수가 총수
  if (!s.set) return s.count > 1 ? s.count : lead ? +lead[1] : null
  const t = /총\s*(\d+)|(\d+)\s*(?:캔|개|병|팩|봉|포|T)\s*구성/.exec(n) // "총60캔"·"(60캔구성)"
  if (t) return +(t[1] || t[2])
  return !/\+|각\s*\d/.test(outside) && lead ? +lead[1] : null // "+" 가 괄호 안 증정 내역뿐이면 세트 아님
}
/** 같은 상품 줄(개수만 다른 변형) 키 — "맥스웰하우스 오리지날 커피믹스 40T (20개입x2개)" → "맥스웰하우스 오리지날 커피믹스" */
const familyKey = (name) => String(name || '').replace(/\([^)]*\)|\[[^\]]*\]/g, ' ').replace(/선물세트/g, ' ')
  .replace(/[x×*]\s*\d+\s*[가-힣A-Za-z]*/g, ' ').replace(/\d+\s*(?:T|티|개입|개|박스|스틱|포|입|EA|ea)(?![a-zA-Z가-힣])/g, ' ').replace(/\s+/g, ' ').trim()
/** 이미지 글자의 "낱개용량 × 수" 칸들 중 낱개가 per 인 것들의 수 합 — "175ml * 30캔 / 175ml * 30캔" → 60, "1.5L x 2개" → 2 */
function textComponentPieces(text, per, unit) {
  let sum = 0, any = false
  for (const m of String(text || '').matchAll(/(\d[\d,]*(?:\.\d+)?)\s*(ml|mL|ML|g|G|kg|KG|Kg|l|L)\s*[x×*]\s*(\d+)/g)) {
    const u = /^(ml|l)$/i.test(m[2]) ? 'ml' : 'g', v = parseFloat(m[1].replace(/,/g, '')) * (/^(kg|l)$/i.test(m[2]) ? 1000 : 1)
    if (u === unit && Math.abs(v - per) <= per * 0.001) { sum += +m[3]; any = true }
  }
  return any ? sum : null
}
/** 이미지 글자 속 용량·중량 값들(L·kg 환산) — 총량 대조용 */
const volsIn = (text, unit) => [...String(text || '').matchAll(/(\d[\d,]*(?:\.\d+)?)\s*(ml|mL|ML|g|G|kg|KG|Kg|l|L)(?![a-wyzA-WYZ])/g)]
  .filter((m) => (/^(ml|l)$/i.test(m[2]) ? 'ml' : 'g') === unit) // 단위가 다른 값(g 낱개에 ml 총량)은 대조하지 않는다
  .map((m) => parseFloat(m[1].replace(/,/g, '')) * (/^(kg|l)$/i.test(m[2]) ? 1000 : 1))
/**
 * 이미지 글자에 낱개 값이 실제로 있는지(지어낸 숫자 방지) — "11.7g"·"190mL"처럼 단위가 붙었거나,
 * 단위 없이 숫자만 있으면("236g(11.8X20개)") 글자 속 용량 하나가 그 숫자의 정수배(±2%)이고 그 배수가 총 개수를 나눠야 한다
 */
function evidenced(text, per, unit, pieces, exp = null) {
  const t = String(text || ''), p = String(per).replace('.', '\\.')
  if (new RegExp(`(^|[^\\d.])${p}\\s*${unit === 'ml' ? 'm[lL]' : '[gG]'}(?![a-wyzA-WYZ])`).test(t)) return true
  if (volsIn(t, unit).some((v) => Math.abs(v - per) <= per * 0.001)) return true // "1kg" → 1000g, "1.5L" → 1500ml
  // 총량만 적힌 이미지("[ 1,400g ]", 100T) — 이름이 총수를 말하고(exp) 낱개 × 그 총수가 총량과 맞으면(±1%) 나눈 값이다.
  // 이름에 개수가 없으면 쓰지 않는다(총량에서 역산한 아무 쌍 700g×2 도 통과하므로)
  if (exp != null && pieces === exp && pieces > 1 && volsIn(t, unit).some((v) => Math.abs(v - per * pieces) <= per * pieces * 0.01)) return true
  if (!new RegExp(`(^|[^\\d.])${p}(?![\\d.])`).test(t)) return false
  return volsIn(t, unit).some((v) => { const n = Math.round(v / per); return n > 1 && Math.abs(v - n * per) <= v * 0.02 && pieces % n === 0 })
}
/**
 * "+"·"각N개" 세트 이름이 말하는 총 낱개 수 — 구성품마다 낱개 용량이 per 와 같을 때만(다르면 null).
 * "꿀모과차 1kg+대추차 1kg" → 2, "딸기 192g 2개 + 사과 192g 2개" → 4, "딸기 192g, 사과 192g 각2개" → 4
 */
function setPiecesFromName(name, per, unit) {
  let s = String(name || ''), mult = 1
  const each = /각\s*(\d+)\s*(?:개입|개|병|캔|봉|팩|박스|EA|ea)?/.exec(s)
  if (each) { mult = +each[1]; s = s.slice(0, each.index) + s.slice(each.index + each[0].length) }
  const parts = s.split(each ? /[+,]/ : /\+/).map((x) => x.trim()).filter(Boolean)
  if (parts.length < 2) return null
  let sum = 0
  for (const part of parts) {
    const sp = specOf(part)
    if (sp.set || !sp.vol || sp.vol.u !== unit || Math.abs(sp.vol.v - per) > per * 0.01) return null
    sum += (each ? 1 : sp.count) * mult
  }
  return sum
}
/** Claude 응답 하나를 규격으로 쓸 수 있는지 — 못 쓰면 사유, 쓸 수 있으면 null */
function judge(name, it) {
  const exp = expectedPieces(name)
  const per = Number(it?.per), pieces = Number(it?.pieces), unit = it?.unit === 'ml' ? 'ml' : it?.unit === 'g' ? 'g' : null
  const why = !it ? '응답에 없음'
    : !it.text ? '이미지에 내용량 없음'
    : it.mixed ? '구성품 낱개 규격이 서로 다름'
    : !unit || !(per > 0) || !Number.isInteger(pieces) || pieces < 1 ? '값 형식 오류'
    : !evidenced(it.text, per, unit, pieces, exp) ? `낱개 값 ${per}${unit} 이 이미지 글자에 없음`
    : exp != null && exp !== pieces ? `총 개수 ${pieces} ≠ 이름 ${exp}`
    // 이름으로 개수를 못 맞추는 세트는 낱개 × 개수가 이미지의 총량과 맞거나(±2%), 이미지의 "낱개 × 수" 칸 합이나
    // 이름의 구성품(모두 같은 낱개 용량) 수가 맞아야 — 낱개·개수 둘 중 하나를 잘못 읽으면 걸린다
    : exp == null && pieces > 1 && !volsIn(it.text, unit).some((v) => Math.abs(v - per * pieces) <= per * pieces * 0.02)
      && textComponentPieces(it.text, per, unit) !== pieces
      && setPiecesFromName(name, per, unit) !== pieces ? `낱개 ${per}${unit} × ${pieces} 가 이미지 총량·이름 구성과 안 맞음`
    : null
  return { why, exp, per, pieces, unit }
}

function prompt(batch) {
  return [
    '아래 상품마다 상세 이미지(식품 표시사항)를 Read 도구로 열어 "내용량"을 읽어라. 추측 금지 — 이미지에 적힌 글자만 쓴다. 이미지에 없으면 null.',
    '각 상품의 값:',
    '- text: 이미지의 내용량(또는 중량·용량) 줄을 글자 그대로',
    '- unit: "g" 또는 "ml" (L·kg 은 ml·g 로 환산)',
    '- per: 상품명이 세는 단위(스틱·티백 T, 캔, 병, PET, 봉, 개 등) 하나의 중량/용량',
    '- pieces: 이 상품 전체에 든 그 단위의 총수',
    '- mixed: 구성품마다 낱개 중량/용량이 다르면 true',
    '예) "3,510g (11.7g * 300개) x 4박스" → per 11.7, unit "g", pieces 1200, mixed false',
    '예) 후렌치파이 딸기 192g 2개 + 사과 192g 2개 → per 192, pieces 4, mixed false',
    '예) 코카콜라 190ml 30캔 + 레쓰비 175ml 30캔 → mixed true',
    '응답은 JSON 하나만: {"items":[{"idx":"…","text":"…","unit":"g","per":11.7,"pieces":1200,"mixed":false}]}',
    '',
    '상품:',
    ...batch.map((r, i) => `${i + 1}) idx=${r.idx} 이름="${r.name_clean}" 이미지: ${r._files.join(' , ')}`),
  ].join('\n')
}

async function download(row) {
  const files = []
  for (const [n, u] of (Array.isArray(row.detail_images) ? row.detail_images : []).slice(0, 3).entries()) {
    try {
      const r = await fetch(u, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(20_000) })
      if (r.status !== 200) continue
      const f = path.join(IMG_DIR, `${row.idx}-${n}.jpg`)
      writeFileSync(f, Buffer.from(await r.arrayBuffer()))
      files.push(f)
    } catch { /* 이 이미지는 건너뜀 */ }
  }
  return files
}

const { data: rows, error } = await sb.from('jimscanner_domeatoz_products').select('idx,name_clean,detail_images,register_excluded_reason')
  .eq('status', 'active').eq('register_excluded', true).like('register_excluded_reason', '%구매옵션%').order('idx')
if (error) throw error
const retryRejected = args.includes('--retry-rejected')
let todo = rows.filter((r) => (ONLY.length ? ONLY.includes(String(r.idx)) : !store[r.idx] || (retryRejected && store[r.idx].rejected)))
if (LIMIT > 0) todo = todo.slice(0, LIMIT)
console.log(`=== 도매아토즈 상세 이미지 규격 판독 ${DRY ? '[DRY] ' : ''}· 모델 ${MODEL} · 대상 ${rows.length} 중 이번 ${todo.length}건 (배치 ${BATCH}) ===`)
if (!existsSync(IMG_DIR)) mkdirSync(IMG_DIR, { recursive: true })

const tally = { ok: 0, rejected: 0, failed: 0 }
// 규격으로 못 쓰는 응답은 사유와 함께 남겨 다시 묻지 않는다(--retry-rejected 로 재시도)
function record(idx, name, it, at = new Date().toISOString().slice(0, 10)) {
  const { why, exp, per, pieces, unit } = judge(name, it)
  const label = String(name ?? '').slice(0, 34)
  const entry = { name, text: it?.text ?? null, unit, per: per > 0 ? per : null, pieces: pieces > 0 ? pieces : null, checked: exp != null ? 'name-count' : 'image-only', at }
  if (why) { store[idx] = { ...entry, rejected: why }; tally.rejected++; console.log(`  ⏭ ${idx} ${label} — ${why}${it?.text ? ` ("${String(it.text).slice(0, 50)}")` : ''}`) }
  else { store[idx] = entry; tally.ok++; console.log(`  ✓ ${idx} ${label} → ${per}${unit} × ${pieces} ("${String(it.text).slice(0, 50)}")`) }
}

/**
 * 자기 이미지에 낱개 값이 없는 상품("맥스웰하우스 오리지날 커피믹스 50T" 이미지엔 "50T"뿐) — 같은 상품 줄의 다른 개수 변형이
 * 자기 이미지로 낱개 값을 확인받았으면 그 값을 쓴다. 총수는 이름이 말해야 하고(exp), 판독 응답의 낱개 값도 같아야(±1%) 한다.
 */
function siblingPass() {
  const proven = new Map()
  for (const [idx, e] of Object.entries(store)) if (!e.rejected && !String(e.checked).startsWith('sibling')) {
    const k = `${familyKey(e.name)}|${e.unit}`
    if (!proven.has(k)) proven.set(k, { idx, per: e.per })
    else if (Math.abs(proven.get(k).per - e.per) > e.per * 0.01) proven.set(k, { idx: null }) // 변형마다 낱개가 다르면 못 빌린다
  }
  for (const [idx, e] of Object.entries(store)) {
    if (!String(e.rejected || '').startsWith('낱개 값') || (ONLY.length && !ONLY.includes(idx))) continue
    const sib = proven.get(`${familyKey(e.name)}|${e.unit}`), exp = expectedPieces(e.name)
    if (!sib?.idx || exp == null || exp !== e.pieces || Math.abs(sib.per - e.per) > sib.per * 0.01) continue
    store[idx] = { ...e, per: sib.per, rejected: undefined, checked: `sibling:${sib.idx}` }
    delete store[idx].rejected
    tally.ok++; tally.rejected--
    console.log(`  ✓ ${idx} ${String(e.name).slice(0, 34)} → ${sib.per}${e.unit} × ${exp} (같은 줄 ${sib.idx} 이미지 값)`)
  }
}

// --revalidate: Claude 를 다시 부르지 않고 저장된 응답을 지금 판정 규칙으로 다시 본다(판정 규칙을 고친 뒤).
// 응답이 없었거나 구성품이 섞인 것은 저장된 값으로 되살릴 수 없어 그대로 둔다.
if (args.includes('--revalidate')) {
  const names = new Map(rows.map((r) => [String(r.idx), r.name_clean]))
  for (const [idx, e] of Object.entries(store)) {
    if (!e.rejected || ['응답에 없음', '이미지에 내용량 없음', '구성품 낱개 규격이 서로 다름'].includes(e.rejected) || (ONLY.length && !ONLY.includes(idx))) continue
    record(idx, names.get(idx) ?? e.name, { text: e.text, unit: e.unit, per: e.per, pieces: e.pieces, mixed: false }, e.at)
  }
  siblingPass()
  save()
  console.log(`\n=== 재판정: 규격 확보 ${tally.ok} · 여전히 사용 불가 ${tally.rejected} ===`)
  process.exit(0)
}

for (let i = 0; i < todo.length; i += BATCH) {
  const batch = []
  for (const r of todo.slice(i, i + BATCH)) { r._files = await download(r); if (r._files.length) batch.push(r); else { console.log(`  ✗ ${r.idx} 상세 이미지 없음`); tally.failed++ } }
  if (!batch.length) continue
  let items
  try {
    items = firstJsonObject(await callClaude(prompt(batch), { model: MODEL, timeoutMs: 600_000, cwd: IMG_DIR, allowedTools: 'Read' })).items
    if (!Array.isArray(items)) throw new Error('items 없음')
  } catch (e) { console.log(`  ⚠ 배치 ${i / BATCH + 1} 실패: ${e.message.slice(0, 160)} — 다음 실행에서 다시`); tally.failed += batch.length; continue }
  for (const r of batch) record(r.idx, r.name_clean, items.find((x) => String(x?.idx) === String(r.idx)))
  save()
}
siblingPass()
save()
console.log(`\n=== 완료: 규격 확보 ${tally.ok} · 사용 불가 ${tally.rejected} · 실패 ${tally.failed} → ${DRY ? '(dry, 저장 안 함)' : OUT} ===`)
