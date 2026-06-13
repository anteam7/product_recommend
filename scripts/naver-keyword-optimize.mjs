/**
 * 네이버 스마트스토어 상품명 키워드 최적화
 * 쇼핑검색 API total 건수(검색 수요 프록시)로 키워드 순위 비교
 * → 검색량 높은 키워드를 상품명 앞에 배치
 *
 *   node --env-file=.env.local scripts/naver-keyword-optimize.mjs [--limit=N] [--apply]
 *
 * - 기본: 분석만 (.tmp/naver-name-proposals.json + 콘솔 테이블)
 * - --apply: 실제 PUT 실행 (확인 메시지 포함)
 *
 * 주의: 상품명 변경은 Full PUT → TEMPORARY_SAVE 강등(오프라인) 가능.
 *       변경 후 네이버 파트너센터에서 승인 재요청 필수.
 */
import { naverApi } from './lib/naver-api.mjs'
import { createClient } from '@supabase/supabase-js'
import { readFileSync, writeFileSync } from 'node:fs'
import fs from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import readline from 'node:readline'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const envPath = path.join(__dirname, '..', '.env.local')
let envRaw
try { envRaw = readFileSync(envPath, 'utf8') } catch {
  console.error(`.env.local 파일을 읽을 수 없습니다: ${envPath}`)
  process.exit(1)
}
const env = Object.fromEntries(
  envRaw
    .split(/\r?\n/)
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => {
      const i = l.indexOf('=')
      let v = l.slice(i + 1).trim()
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
      return [l.slice(0, i).trim(), v]
    })
)
if (!env.NEXT_PUBLIC_SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error('NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 없음 (.env.local)')
  process.exit(1)
}
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY)

// ── args ──
const LIMIT = parseInt((process.argv.find((a) => a.startsWith('--limit=')) || '').split('=')[1] || '0') || 0
const APPLY = process.argv.includes('--apply')
const FROM_FILE = process.argv.includes('--from-file')
const sleep = (ms) => new Promise((s) => setTimeout(s, ms))

// ── --from-file 모드: 저장된 proposals JSON 직접 적용 ──
if (FROM_FILE && APPLY) {
  const fPath = path.join(__dirname, '..', '.tmp', 'naver-name-proposals.json')
  let proposals
  try { proposals = JSON.parse(readFileSync(fPath, 'utf8')) } catch {
    console.error('.tmp/naver-name-proposals.json 없음. 먼저 분석을 실행하세요.')
    process.exit(1)
  }
  const improved = proposals.filter((p) => p.improvement)
  console.log(`파일에서 ${improved.length}건 적용 시작 (스킵된 항목 ${proposals.length - improved.length}건)`)
  console.log('\n⚠ 주의: 상품명 Full PUT → TEMPORARY_SAVE 강등(오프라인) 가능. 변경 후 승인 재요청 필수.\n')
  let done = 0, fail = 0
  for (const [i, p] of improved.entries()) {
    try {
      const g = await naverApi('GET', `/v2/products/origin-products/${p.origin_product_no}`)
      if (!g || g.status !== 200) {
        console.log(`✗ [${i + 1}/${improved.length}] GET 실패 (${g?.status ?? 'null'}) — ${p.origin_product_no}`)
        fail++; continue
      }
      const op = g.body.originProduct
      const channelProd = g.body.smartstoreChannelProduct ?? { storeKeepExclusiveProduct: false, naverShoppingRegistration: true, channelProductDisplayStatusType: 'ON' }
      op.name = p.proposed
      const r = await naverApi('PUT', `/v2/products/origin-products/${p.origin_product_no}`, { originProduct: op, smartstoreChannelProduct: channelProd })
      if (r && r.status === 200) {
        await sb.from('jimscanner_naver_listings').update({ name: p.proposed }).eq('origin_product_no', p.origin_product_no)
        console.log(`✓ [${i + 1}/${improved.length}] "${p.name.slice(0, 40)}" → "${p.proposed.slice(0, 40)}"`)
        done++
      } else {
        console.log(`✗ [${i + 1}/${improved.length}] PUT ${r?.status ?? 'null'} — ${JSON.stringify(r?.body ?? null).slice(0, 120)}`)
        fail++
      }
    } catch (e) {
      console.log(`✗ [${i + 1}/${improved.length}] 예외: ${e.message}`)
      fail++
    }
    await sleep(400)
  }
  console.log(`\n완료: 성공 ${done}건 / 실패 ${fail}건`)
  if (done > 0) console.log('네이버 파트너센터에서 TEMPORARY_SAVE 강등 상품의 승인 재요청을 확인하세요.')
  process.exit(0)
}

// ── 사전 검증 ──
if (!env.NAVER_OPENAPI_CLIENT_ID || !env.NAVER_OPENAPI_CLIENT_SECRET) {
  console.error('NAVER_OPENAPI_CLIENT_ID / NAVER_OPENAPI_CLIENT_SECRET 없음 (.env.local)')
  process.exit(1)
}

// ── 쇼핑검색 API — total 건수 반환 ──
async function shopTotal(query) {
  const r = await fetch(
    `https://openapi.naver.com/v1/search/shop.json?query=${encodeURIComponent(query)}&display=1`,
    {
      headers: {
        'X-Naver-Client-Id': env.NAVER_OPENAPI_CLIENT_ID,
        'X-Naver-Client-Secret': env.NAVER_OPENAPI_CLIENT_SECRET,
      },
    }
  )
  if (!r.ok) return 0
  const j = await r.json()
  return j.total ?? 0
}

// ── 키워드 후보 추출 (2~3토큰 조합) ──
function candidateKeywords(name) {
  const STOP = /^(\d|x$|mg$|kg$|ml$|정$|캡슐$|포$|개입|박스|병$|슈퍼|프리미엄|골드|플러스|함유|뉴$|더$)/i
  const toks = name
    .replace(/[()\[\],·×]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 2 && !STOP.test(t))
  const candidates = new Set()
  for (let i = 0; i < Math.min(toks.length, 5); i++) {
    candidates.add(toks[i])
    if (i + 1 < toks.length) candidates.add(`${toks[i]} ${toks[i + 1]}`)
  }
  return [...candidates].slice(0, 6)
}

// ── 최적화된 이름 생성 ──
function buildOptimizedName(current, topKw) {
  // 첫 번째 매칭만 제거 (replaceAll 사용 시 의도치 않은 중복 제거 방지)
  // topKw가 중복 포함된 경우 첫 등장만 제거하고 나머지는 보존
  const escaped = topKw.replace(/[.*+?^${}\[\]\\|()]/g, '\\$&')
  const cleaned = current.replace(new RegExp(escaped), '').replace(/\s+/g, ' ').trim()
  const candidate = `${topKw} ${cleaned}`.replace(/\s+/g, ' ').trim().slice(0, 100)
  return candidate
}

// ── 현재 이름의 앞 2토큰 안에 topKw 포함 여부 ──
function isAlreadyFront(name, topKw) {
  const front = name
    .replace(/[()\[\],·×]/g, ' ')
    .split(/\s+/)
    .slice(0, 2)
    .join(' ')
  return front.toLowerCase().includes(topKw.toLowerCase())
}

// ── stdin 확인 ──
async function confirm(prompt) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  return new Promise((resolve) => {
    rl.question(prompt, (ans) => {
      rl.close()
      resolve(ans.trim().toLowerCase() === 'y')
    })
  })
}

// ── DB 로드 ──
console.log('jimscanner_naver_listings 로딩...')
let q = sb
  .from('jimscanner_naver_listings')
  .select('origin_product_no, name, sale_price, channel_product_no')
  .order('sale_price', { ascending: false })
if (LIMIT) q = q.limit(LIMIT)
const { data: rows, error } = await q
if (error) { console.error(error.message); process.exit(1) }
console.log(`대상 ${rows.length}건\n`)

// ── price-audit.json 있으면 WIN/PAR 우선 정렬 ──
let priceMap = new Map()
try {
  const raw = JSON.parse(readFileSync(path.join(__dirname, '..', '.tmp', 'naver-price-audit.json'), 'utf8'))
  for (const r of raw) priceMap.set(String(r.no), r.grade)
  console.log(`price-audit.json 로드: ${priceMap.size}건 — WIN/PAR 우선 처리\n`)
} catch { /* 없으면 그냥 진행 */ }

function gradeOrder(no) {
  const g = priceMap.get(String(no))
  if (g === 'WIN') return 0
  if (g === 'PAR') return 1
  if (!g) return 2
  return 3 // LOSE
}
rows.sort((a, b) => gradeOrder(a.channel_product_no) - gradeOrder(b.channel_product_no))

// ── 분석 ──
const proposals = []
for (const [i, row] of rows.entries()) {
  const cands = candidateKeywords(row.name)
  if (!cands.length) continue

  let topKw = null, topTotal = 0
  for (const kw of cands) {
    let total = 0
    try { total = await shopTotal(kw) } catch (e) { console.log(`  skip ${kw}: ${e.message}`) }
    if (total > topTotal) { topTotal = total; topKw = kw }
    await sleep(200)
  }

  if (!topKw) continue

  const alreadyFront = isAlreadyFront(row.name, topKw)
  if (alreadyFront) {
    proposals.push({
      origin_product_no: row.origin_product_no,
      channel_product_no: row.channel_product_no,
      name: row.name,
      proposed: null,
      topKw,
      topTotal,
      improvement: false,
    })
    continue
  }

  const proposed = buildOptimizedName(row.name, topKw)
  if (proposed === row.name) {
    proposals.push({ origin_product_no: row.origin_product_no, channel_product_no: row.channel_product_no, name: row.name, proposed: null, topKw, topTotal, improvement: false })
    continue
  }

  proposals.push({
    origin_product_no: row.origin_product_no,
    channel_product_no: row.channel_product_no,
    name: row.name,
    proposed,
    topKw,
    topTotal,
    improvement: true,
  })

  const idx = i + 1
  const total = rows.length
  console.log(`[${idx}/${total}] 개선: "${row.name.slice(0, 40)}..." → "${proposed.slice(0, 40)}..." (top: ${topKw}, total=${topTotal.toLocaleString()})`)
}

// ── 저장 ──
await fs.mkdir(path.join(__dirname, '..', '.tmp'), { recursive: true })
const outPath = path.join(__dirname, '..', '.tmp', 'naver-name-proposals.json')
writeFileSync(outPath, JSON.stringify(proposals, null, 2))

const improved = proposals.filter((p) => p.improvement)
console.log(`\n━━ 결과 ━━`)
console.log(`전체 ${proposals.length}건 / 개선 제안 ${improved.length}건 / 변경 불필요 ${proposals.length - improved.length}건`)
console.log(`저장: .tmp/naver-name-proposals.json`)

if (!improved.length) {
  console.log('\n개선 대상 없음. 종료.')
  process.exit(0)
}

// ── --apply 모드 ──
if (!APPLY) {
  console.log('\n실제 적용하려면 --apply 옵션을 추가하세요.')
  console.log('  node --env-file=.env.local scripts/naver-keyword-optimize.mjs --apply')
  console.log('\n⚠ 주의: 상품명 Full PUT은 TEMPORARY_SAVE 강등(오프라인) 가능. 변경 후 승인 재요청 필수.')
  process.exit(0)
}

console.log('\n⚠ 주의: 상품명 변경은 Full PUT → TEMPORARY_SAVE 강등(오프라인) 가능.')
console.log('   변경 후 네이버 파트너센터에서 승인 재요청이 필요합니다.\n')

const ok = await confirm(`${improved.length}건 업데이트하시겠습니까? (y/N): `)
if (!ok) { console.log('취소'); process.exit(0) }

let done = 0, fail = 0
for (const [i, p] of improved.entries()) {
  const idx = i + 1
  try {
    const g = await naverApi('GET', `/v2/products/origin-products/${p.origin_product_no}`)
    if (g.status !== 200) {
      console.log(`✗ [${idx}/${improved.length}] GET 실패 (${g.status}) — ${p.origin_product_no}`)
      fail++
      continue
    }
    const op = g.body.originProduct
    const channelProd = g.body.smartstoreChannelProduct ?? {
      storeKeepExclusiveProduct: false,
      naverShoppingRegistration: true,
      channelProductDisplayStatusType: 'ON',
    }
    op.name = p.proposed
    const r = await naverApi('PUT', `/v2/products/origin-products/${p.origin_product_no}`, {
      originProduct: op,
      smartstoreChannelProduct: channelProd,
    })
    if (r.status === 200) {
      await sb
        .from('jimscanner_naver_listings')
        .update({ name: p.proposed })
        .eq('origin_product_no', p.origin_product_no)
      console.log(`✓ [${idx}/${improved.length}] "${p.name.slice(0, 35)}" → "${p.proposed.slice(0, 35)}"`)
      done++
    } else {
      console.log(`✗ [${idx}/${improved.length}] PUT ${r.status} — ${JSON.stringify(r.body).slice(0, 120)}`)
      fail++
    }
  } catch (e) {
    console.log(`✗ [${idx}/${improved.length}] 예외: ${e.message}`)
    fail++
  }
  await sleep(400)
}

console.log(`\n완료: 성공 ${done}건 / 실패 ${fail}건`)
console.log('네이버 파트너센터에서 TEMPORARY_SAVE 강등 상품의 승인 재요청을 확인하세요.')
