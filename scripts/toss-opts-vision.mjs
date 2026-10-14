#!/usr/bin/env node
/**
 * 상세 이미지 비전 판독 → 토스 판매옵션 값(총 정/캡슐 수·낱개 수·내용량) 추출. 제목·쿠팡 속성·공급처 어디에도 수량이 없어
 * 일괄 러너가 OPTS_UNKNOWN 으로 건너뛴 상품(2026-10-14 저녁 81건: bio77 "… 1개 알약케이스 사은품증정" 시리즈, ggsan·wellroot 정제류) 대응.
 *
 *   node scripts/toss-opts-vision.mjs                      # 러너 로그(_workspace/toss-batch-*.jsonl)의 OPTS_UNKNOWN 중 토스 미등록분 전체
 *   node scripts/toss-opts-vision.mjs --spids=1,2          # 특정 쿠팡 seller_product_id
 *   node scripts/toss-opts-vision.mjs --apply [--min-conf=high|medium]   # 결과를 _workspace/toss-opts-overrides.json 에 병합
 *   --limit=N --concurrency=3 --max-images=3 --max-chunks=12 --dry(판독만, 파일 안 씀)
 *
 * 방법: 대표 이미지 + 상세 이미지(최대 3장)를 폭 800 으로 줄여 세로 1,600px 조각으로 자르고 조각마다 Gemini(2.5 flash)에 "명시된 총 수량·1정 중량·총 내용량만
 *       JSON 으로" 묻는다(1일 섭취량 제외). 조각별 답을 모아 가장 많이 나온 수량을 고르고, 1정 중량×수량 ≈ 총 내용량(이미지 또는 쿠팡 itemName "48g 1개")이면
 *       검증된 것으로 본다. 신뢰도 high = 중량 검증 또는 2조각 이상 일치(상충 없음), medium = 1조각, low = 상충/중량 불일치.
 * 결과: _workspace/toss-opts-vision-<KST날짜>.json / .md (근거 문구 포함). --apply 로 병합된 overrides 는 toss-register.mjs 가 --opts 없을 때 읽어
 *       자동 옵션 대신 쓴다(러너가 다음 실행에서 OPTS_UNKNOWN 대신 등록). 오판은 "상품 정보 불일치" 반려로 드러나므로 high 만 기본 적용.
 */
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createClient } from '@supabase/supabase-js'
import sharp from 'sharp'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..')
const env = Object.fromEntries(readFileSync(path.join(ROOT, '.env.local'), 'utf8').split(/\r?\n/).filter((l) => l && !l.startsWith('#') && l.includes('=')).map((l) => { const i = l.indexOf('='); let v = l.slice(i + 1).trim(); if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1); return [l.slice(0, i).trim(), v] }))
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY)
const GEMINI = env.GEMINI_API_KEY
if (!GEMINI) { console.error('GEMINI_API_KEY 없음'); process.exit(1) }
const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.split('=').slice(1).join('=') : d }
const has = (k) => process.argv.includes(`--${k}`)
const DRY = has('dry'), APPLY = has('apply') || has('apply-only')
const MIN_CONF = arg('min-conf', 'high')
const LIMIT = parseInt(arg('limit', '0'), 10) || 0
const CONC = Math.max(1, parseInt(arg('concurrency', '3'), 10) || 3)
const MAX_IMAGES = Math.max(1, parseInt(arg('max-images', '3'), 10) || 3)
const MAX_CHUNKS = Math.max(1, parseInt(arg('max-chunks', '12'), 10) || 12)
const WS = path.join(ROOT, '_workspace'); mkdirSync(WS, { recursive: true })
const KST = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10).replace(/-/g, '')
const OUT_JSON = path.join(WS, `toss-opts-vision-${KST}.json`), OUT_MD = path.join(WS, `toss-opts-vision-${KST}.md`), OV_FILE = path.join(WS, 'toss-opts-overrides.json')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const CONF_RANK = { high: 3, medium: 2, low: 1, none: 0 }

async function fetchAll(build) { const PAGE = 1000, out = []; for (let from = 0; ; from += PAGE) { const { data, error } = await build().range(from, from + PAGE - 1); if (error) throw new Error(error.message); out.push(...(data ?? [])); if ((data ?? []).length < PAGE) return out } }

/** 대상: --spids 또는 러너 로그의 OPTS_UNKNOWN(토스에 FAILED 외 행이 없는 것). 건너뛴 사유 문구로 필요한 옵션 키(수량형/중량형)를 안다 */
async function targets() {
  const warn = new Map()
  for (const f of readdirSync(WS).filter((f) => /^toss-batch-\d+\.jsonl$/.test(f))) for (const l of readFileSync(path.join(WS, f), 'utf8').split('\n')) { if (!l) continue; try { const j = JSON.parse(l); if (j.skip === 'OPTS_UNKNOWN') warn.set(String(j.spid), j.error || '') } catch { /* skip */ } }
  let ids = arg('spids', '').split(',').map((s) => s.trim()).filter(Boolean)
  if (!ids.length) {
    const toss = await fetchAll(() => sb.from('jimscanner_toss_listings').select('coupang_seller_product_id, inspection_status').order('id'))
    const onToss = new Set(toss.filter((t) => t.inspection_status !== 'FAILED').map((t) => String(t.coupang_seller_product_id)))
    ids = [...warn.keys()].filter((s) => !onToss.has(s))
  }
  const rows = []
  for (let i = 0; i < ids.length; i += 200) {
    const { data, error } = await sb.from('jimscanner_coupang_listings').select('seller_product_id, source, registered_title, request_payload').in('seller_product_id', ids.slice(i, i + 200)).eq('status', 'APPROVED')
    if (error) throw new Error(error.message)
    rows.push(...data)
  }
  return rows.map((r) => {
    const it = r.request_payload?.items?.[0]
    const detail = (it?.contents || []).flatMap((c) => (c.contentDetails || []).filter((d) => d.detailType === 'IMAGE' && d.content).map((d) => d.content))
    const rep = (it?.images || []).find((i) => i.imageType === 'REPRESENTATION')?.vendorPath || (it?.images || [])[0]?.vendorPath
    const w = warn.get(String(r.seller_product_id)) || ''
    return { spid: String(r.seller_product_id), source: r.source, title: r.registered_title, itemName: it?.itemName || '', images: [rep, ...detail].filter(Boolean), need: /개당 중량|개당 용량/.test(w) ? 'weight' : 'count', warn: w }
  }).slice(0, LIMIT || undefined)
}

async function fetchBuf(url) {
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', Referer: new URL(url).origin + '/' } })
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  return Buffer.from(await r.arrayBuffer())
}
/** 폭 800 으로 줄여 세로 1,600px 조각 — 긴 상세(bio77 2480x47542)는 통째로 보내면 글자가 뭉개진다 */
async function chunks(buf, maxChunks) {
  const png = await sharp(buf, { limitInputPixels: 300_000_000 }).resize({ width: 800, withoutEnlargement: true }).png().toBuffer()
  const m = await sharp(png).metadata()
  const out = []
  for (let y = 0; y < m.height && out.length < maxChunks; y += 1600) {
    const h = Math.min(1600, m.height - y)
    if (h < 120) break
    out.push(await sharp(png).extract({ left: 0, top: y, width: m.width, height: h }).jpeg({ quality: 80 }).toBuffer())
  }
  return out
}

const PROMPT = [
  '이 이미지는 건강식품(영양제·분말 등) 상세페이지의 일부입니다. 이미지에 실제로 적힌 글자만 근거로, 아래를 JSON 으로 답하세요. 추측·일반 지식 금지, 안 보이면 null.',
  '- count: 제품 1통(1박스)에 든 총 알약·캡슐·환·포·스틱·매 수 (예: "60정", "30캡슐", "500mg x 60정", "총 60정(30일분)"). 1일 섭취량("1일 1회 1정")·섭취 횟수는 count 가 아닙니다.',
  '- unit: count 의 단위 — "정"|"캡슐"|"환"|"포"|"스틱"|"매"|"개" 중 하나 또는 null',
  '- per_mg: 1정(1캡슐·1포)의 중량 mg (예: "1,000mg x 60정" 의 1000, "500 mg/정"). 함량 성분 mg(비타민C 500mg)이 아니라 1정 전체 중량일 때만.',
  '- net_g: 총 내용량 g (예: "내용량: 48g (800mg x 60정)" 의 48, "90g"). ml 이면 net_ml 에.',
  '- net_ml: 총 용량 ml',
  '- bottles: 세트 구성 통·병 수 (예: "60정 x 2통" 의 2). 단품이면 null.',
  '- evidence: 위 값을 읽은 문구를 이미지에 적힌 그대로(최대 80자). 없으면 "".',
  '출력 형식: {"count":null,"unit":null,"per_mg":null,"net_g":null,"net_ml":null,"bottles":null,"evidence":""}',
].join('\n')

async function gemini(jpeg) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: PROMPT }, { inlineData: { mimeType: 'image/jpeg', data: jpeg.toString('base64') } }] }], generationConfig: { responseMimeType: 'application/json', temperature: 0 } }),
      })
      if (res.status === 429 || res.status >= 500) { await sleep(2000 * attempt); continue }
      if (!res.ok) throw new Error(`gemini ${res.status} ${(await res.text()).slice(0, 120)}`)
      const d = await res.json()
      const txt = d.candidates?.[0]?.content?.parts?.[0]?.text || '{}'
      try { return JSON.parse(txt) } catch { return null }
    } catch (e) { if (attempt === 4) throw e; await sleep(1500 * attempt) }
  }
  return null
}

const num = (v) => { const n = typeof v === 'string' ? Number(String(v).replace(/[^0-9.]/g, '')) : Number(v); return Number.isFinite(n) && n > 0 ? n : null }
const mode = (arr) => { const m = new Map(); for (const x of arr) m.set(x, (m.get(x) || 0) + 1); return [...m.entries()].sort((a, b) => b[1] - a[1])[0] || null }

/** 조각별 답 → 하나의 판정 */
function aggregate(t, answers) {
  const a = answers.filter(Boolean)
  const counts = a.map((x) => ({ n: num(x.count), u: typeof x.unit === 'string' ? x.unit.replace(/[^가-힣a-z]/gi, '') : null, ev: String(x.evidence || '').slice(0, 80) })).filter((x) => x.n && x.n >= 2 && x.n <= 2000)
  const perMg = mode(a.map((x) => num(x.per_mg)).filter(Boolean))?.[0] || null
  const netG = mode(a.map((x) => num(x.net_g)).filter(Boolean))?.[0] || null
  const netMl = mode(a.map((x) => num(x.net_ml)).filter(Boolean))?.[0] || null
  const cpG = num(/(\d+(?:\.\d+)?)\s*g(?![a-z])/i.exec(t.itemName || '')?.[1]), cpMl = num(/(\d+(?:\.\d+)?)\s*ml/i.exec(t.itemName || '')?.[1])
  const bottles = mode(a.map((x) => num(x.bottles)).filter((n) => n && n > 1))?.[0] || null
  const r = { count: null, unit: null, perMg, netG, netMl, bottles, evidence: [], confidence: 'none', verified: null, opts: null }
  if (t.need === 'weight') {
    const g = netG || (cpG && cpG >= 20 ? cpG : null)
    if (g) { r.netG = g; r.opts = `개당 중량=${g}g`; r.confidence = netG && cpG && Math.abs(netG - cpG) / cpG < 0.15 ? 'high' : netG ? 'medium' : 'low'; r.evidence = a.filter((x) => num(x.net_g)).map((x) => String(x.evidence || '').slice(0, 80)).slice(0, 2) }
    else if (netMl || cpMl) { const ml = netMl || cpMl; r.netMl = ml; r.opts = `개당 용량=${ml}ml`; r.confidence = netMl ? 'medium' : 'low' }
    return r
  }
  if (!counts.length) return r
  const unitOf = (u) => (/캡슐/.test(u || '') ? '캡슐' : /환/.test(u || '') ? '환' : /스틱/.test(u || '') ? '스틱' : /포/.test(u || '') ? '포' : /매/.test(u || '') ? '매' : '정')
  const groups = new Map()
  for (const c of counts) { const u = unitOf(c.u), k = `${c.n}|${u}`; const g = groups.get(k) || { n: c.n, u, freq: 0, ev: [] }; g.freq++; if (c.ev && g.ev.length < 2) g.ev.push(c.ev); groups.set(k, g) }
  const ranked = [...groups.values()].sort((x, y) => y.freq - x.freq)
  // 중량 검증: 1정 중량 × 수량 ≈ 총 내용량(이미지 net_g 또는 쿠팡 itemName g). 검증되는 그룹이 있으면 빈도보다 우선
  // 세트(3g x 30포 x 3박스 = 270g)는 총 내용량이 박스 수 배 — 1박스 중량으로도, 세트 중량으로도 맞으면 검증
  //   세트 배수로만 맞는 검증('set')은 반쪽 수량(60정 중 30)이 통과할 수 있어 high 로 올리지 않는다(최대 medium, --min-conf=medium 으로만 적용)
  const weightOk = (n) => { if (!perMg) return null; const calc = (perMg * n) / 1000; const ref = netG || cpG; if (!ref) return null; const ok = (c) => Math.abs(c - ref) / ref < 0.15; return ok(calc) ? 'direct' : (bottles && ok(calc * bottles)) ? 'set' : false }
  const best = ranked.find((g) => weightOk(g.n) === 'direct') || ranked.find((g) => weightOk(g.n) === 'set') || ranked[0]
  const conflict = ranked.some((g) => g !== best && g.freq >= 2)
  const w = weightOk(best.n)
  r.count = best.n; r.unit = best.u; r.evidence = best.ev; r.verified = w === 'direct' ? true : w === false ? false : null
  r.confidence = w === 'direct' ? 'high' : (best.freq >= 2 && !conflict) ? 'high' : best.freq >= 2 ? 'medium' : conflict ? 'low' : 'medium'
  if (w === 'set' && r.confidence === 'high') r.confidence = 'medium'
  if (w === false) r.confidence = 'low' // 1정 중량×수량이 총중량과 안 맞으면 수량이 틀렸을 가능성 — 상품 정보 불일치 반려 예방
  // 템플릿에 '(택1) 개당 캡슐/정' 이 있으면 그 키가 먼저 잡히고(toss-register buildOptions), 없으면 '개당 수량' 으로 들어간다(단위는 템플릿 허용값으로 교정)
  r.opts = /정|캡슐|환/.test(best.u) ? `개당 캡슐/정=${best.n}${best.u};개당 수량=${best.n}${best.u}` : `개당 수량=${best.n}${best.u}`
  return r
}

async function readOne(t) {
  const answers = [], errs = []
  let used = 0
  for (const url of t.images.slice(0, MAX_IMAGES + 1)) { // +1 = 대표 이미지
    let parts
    try { parts = await chunks(await fetchBuf(url), MAX_CHUNKS - used) } catch (e) { errs.push(`${url.slice(-40)}: ${e.message.slice(0, 60)}`); continue }
    for (const p of parts) { try { answers.push(await gemini(p)) } catch (e) { errs.push(e.message.slice(0, 80)) } }
    used += parts.length
    if (used >= MAX_CHUNKS) break
  }
  const r = aggregate(t, answers)
  return { ...t, images: undefined, chunks: used, errors: errs, result: r }
}

// --apply-only: 다시 읽지 않고 오늘 결과 파일(OUT_JSON)만 병합·적용 (판독 15분을 반복하지 않게)
const list = has('apply-only') ? [] : await targets()
if (has('apply-only') && !existsSync(OUT_JSON)) { console.error(`결과 파일 없음: ${OUT_JSON}`); process.exit(1) }
console.log(`대상 ${list.length}건 (수량형 ${list.filter((t) => t.need === 'count').length} · 중량형 ${list.filter((t) => t.need === 'weight').length}) · 동시 ${CONC} · 이미지 최대 ${MAX_IMAGES}+대표 · 조각 최대 ${MAX_CHUNKS}`)
const results = []
let idx = 0
async function worker() {
  while (idx < list.length) {
    const t = list[idx++]
    const started = Date.now()
    try {
      const r = await readOne(t)
      results.push(r)
      const R = r.result
      const flag = R.verified === true ? ' ✓중량' : R.verified === false ? ' ✗중량' : ''
      console.log(`  [${results.length}/${list.length}] ${t.spid} ${t.source} ${t.title.slice(0, 34).padEnd(34)} → ${R.opts || '판독 실패'} (${R.confidence}${flag}, 조각 ${r.chunks}, ${Math.round((Date.now() - started) / 1000)}s)${R.evidence?.[0] ? ' | ' + R.evidence[0].slice(0, 50) : ''}${r.errors.length ? ' | err ' + r.errors[0] : ''}`)
    } catch (e) { results.push({ ...t, images: undefined, errors: [String(e.message)], result: { confidence: 'none', opts: null, evidence: [] } }); console.log(`  ✗ ${t.spid} ${e.message.slice(0, 100)}`) }
  }
}
await Promise.all(Array.from({ length: CONC }, worker))
// 같은 날 결과 파일이 있으면 병합(--spids 재판독이 전체 결과를 덮어쓰지 않게) — 이번에 읽은 spid 만 교체
if (!DRY && existsSync(OUT_JSON)) {
  try { const prev = JSON.parse(readFileSync(OUT_JSON, 'utf8')); const done = new Set(results.map((r) => r.spid)); for (const p of prev) if (!done.has(p.spid)) results.push(p) }
  catch (e) { // 깨진 결과 파일을 덮어써 하루치 판독을 잃지 않게: apply-only 면 중단, 아니면 백업 뒤 새로 쓴다
    if (has('apply-only')) { console.error(`결과 파일 파싱 실패: ${OUT_JSON} — ${e.message}`); process.exit(1) }
    const bak = OUT_JSON.replace(/\.json$/, `.corrupt-${Date.now()}.json`); writeFileSync(bak, readFileSync(OUT_JSON)); console.log(`⚠ 기존 결과 파일 파싱 실패 → ${bak} 로 백업 후 새로 씀`)
  }
}
if (has('apply-only') && !results.length) { console.error('결과 파일이 비어 있음 — 적용할 것이 없다'); process.exit(1) }
results.sort((a, b) => (CONF_RANK[b.result.confidence] ?? 0) - (CONF_RANK[a.result.confidence] ?? 0) || a.source.localeCompare(b.source))
const tally = results.reduce((m, r) => { m[r.result.confidence] = (m[r.result.confidence] || 0) + 1; return m }, {})
console.log(`\n판독 ${results.length}건: ${Object.entries(tally).map(([k, v]) => `${k} ${v}`).join(' · ')}`)
if (!DRY) {
  writeFileSync(OUT_JSON, JSON.stringify(results, null, 1))
  const cell = (s) => String(s ?? '').replace(/\|/g, '/').replace(/\n/g, ' ')
  const md = ['# 토스 옵션 비전 판독 ' + KST, '', `대상 ${results.length}건 — ${Object.entries(tally).map(([k, v]) => `${k} ${v}`).join(' · ')}. 적용: \`node scripts/toss-opts-vision.mjs --apply [--min-conf=medium]\` → _workspace/toss-opts-overrides.json`, '',
    '| 신뢰도 | spid | 공급처 | 상품명 | 쿠팡 itemName | 판독 | 1정 mg | 내용량 | opts | 근거 |', '|---|---|---|---|---|---|---|---|---|---|']
  for (const r of results) {
    const R = r.result
    const read = R.count ? R.count + (R.unit || '') : R.netG ? R.netG + 'g' : R.netMl ? R.netMl + 'ml' : '-'
    md.push(`| ${R.confidence}${R.verified === true ? ' ✓' : R.verified === false ? ' ✗' : ''} | ${r.spid} | ${r.source} | ${cell(r.title)} | ${cell(r.itemName)} | ${read}${R.bottles ? ' x' + R.bottles : ''} | ${R.perMg || ''} | ${R.netG ? R.netG + 'g' : ''} | ${cell(R.opts)} | ${cell((R.evidence || []).join(' / '))} |`)
  }
  writeFileSync(OUT_MD, md.join('\n'))
  console.log(`→ ${OUT_JSON}\n→ ${OUT_MD}`)
}
if (APPLY && !DRY) {
  const ov = existsSync(OV_FILE) ? JSON.parse(readFileSync(OV_FILE, 'utf8')) : {}
  let n = 0
  for (const r of results) if (r.result.opts && (CONF_RANK[r.result.confidence] ?? 0) >= (CONF_RANK[MIN_CONF] ?? 3)) { ov[r.spid] = { opts: r.result.opts, confidence: r.result.confidence, evidence: r.result.evidence, source: 'vision', at: new Date().toISOString(), name: r.title }; n++ }
  writeFileSync(OV_FILE, JSON.stringify(ov, null, 1))
  console.log(`overrides 병합 ${n}건(≥${MIN_CONF}) → ${OV_FILE} (총 ${Object.keys(ov).length}건)`)
}
