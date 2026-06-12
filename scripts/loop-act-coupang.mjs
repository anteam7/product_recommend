/**
 * 루프 엔지니어링 — Act 단계 (쿠팡)
 * 큐에서 TOP-10 pending 처리: restock / request-approval 자동 실행
 * human_review 항목은 건드리지 않음
 *
 * 실행:
 *   node scripts/loop-act-coupang.mjs          # APPLY
 *   node scripts/loop-act-coupang.mjs --dry     # DRY-RUN
 */
import crypto from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { createClient } from '@supabase/supabase-js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

let raw
try {
  raw = readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8')
} catch (e) {
  console.error('.env.local 읽기 실패:', e.message); process.exit(1)
}
const env = Object.fromEntries(
  raw.split(/\r?\n/)
    .filter(l => l && !l.startsWith('#') && l.includes('='))
    .map(l => {
      const i = l.indexOf('=')
      let v = l.slice(i + 1).trim()
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
      return [l.slice(0, i).trim(), v]
    })
)

for (const key of ['NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'COUPANG_API_HOST', 'COUPANG_ACCESS_KEY', 'COUPANG_SECRET_KEY']) {
  if (!env[key]) { console.error(`env 누락: ${key}`); process.exit(1) }
}

const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY)
const HOST = env.COUPANG_API_HOST
const AK = env.COUPANG_ACCESS_KEY
const SK = env.COUPANG_SECRET_KEY
const DRY = process.argv.includes('--dry')

// 쿠팡 ID는 순수 숫자 — 경로 조작 차단
function safeId(val) {
  const s = String(val ?? '').trim()
  if (!/^\d+$/.test(s)) throw new Error(`유효하지 않은 ID 형식`)
  return s
}

function sign(m, p) {
  const dt = new Date().toISOString().substring(2, 19).replace(/[-:]/g, '') + 'Z'
  return { dt, sig: crypto.createHmac('sha256', SK).update(dt + m + p).digest('hex') }
}

// parsed=true: body는 객체 / parsed=false: JSON 파싱 실패, body는 null
async function api(m, p, body) {
  const { dt, sig } = sign(m, p)
  let r
  try {
    r = await fetch(`${HOST}${p}`, {
      method: m,
      headers: {
        Authorization: `CEA algorithm=HmacSHA256, access-key=${AK}, signed-date=${dt}, signature=${sig}`,
        'Content-Type': 'application/json;charset=UTF-8',
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
  } catch (e) {
    throw new Error(`네트워크 오류: ${e.message}`)
  }
  const t = await r.text()
  try {
    return { status: r.status, body: JSON.parse(t), parsed: true }
  } catch {
    return { status: r.status, body: null, parsed: false }
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

async function dbUpdate(id, fields) {
  const { error } = await sb.from('jimscanner_loop_action_queue')
    .update({ ...fields, updated_at: new Date().toISOString() })
    .eq('id', id)
  if (error) {
    console.error(`  큐 업데이트 실패 (id=${id}):`, error.message)
    return false
  }
  return true
}

async function dbLog(entry) {
  const { error } = await sb.from('jimscanner_loop_action_log').insert(entry)
  if (error) {
    console.error(`  [WARN] 실행 로그 기록 실패 — 감사 이력 유실 (product_id=${entry.product_id}, action=${entry.action_type}): ${error.message}`)
    return false
  }
  return true
}

// ── 액션 핸들러 ────────────────────────────────────────────────────────────

async function execRestock(item) {
  const pid = safeId(item.product_id)
  const res = await api('GET', `/v2/providers/seller_api/apis/api/v1/marketplace/seller-products/${pid}`)
  if (res.status !== 200 || !res.parsed) throw new Error(`상품 조회 실패 (status=${res.status}, parsed=${res.parsed})`)
  const d = res.body?.data
  if (!d) throw new Error('상품 페이로드 없음')

  const vids = (d.items ?? []).map(it => it.vendorItemId).filter(Boolean)
  if (vids.length === 0) throw new Error('vendorItemId 없음')

  if (DRY) {
    console.log(`    [dry] restock ${pid} | vendorItems ${vids.length}개 qty=10`)
    return { dry: true, vids_count: vids.length }
  }

  let successCount = 0
  const failedVids = []
  for (const vid of vids) {
    const safeVid = safeId(vid)
    const r = await api('PUT', `/v2/providers/seller_api/apis/api/v1/marketplace/vendor-items/${safeVid}/quantities/10`)
    if (r.status === 200) successCount++
    else failedVids.push(safeVid)
    await sleep(200)
  }

  if (failedVids.length > 0) throw new Error(`vendorItem ${failedVids.length}개 수량 PUT 실패`)
  // 민감한 ID 목록 대신 집계만 저장
  return { vids_count: vids.length, qty: 10, success_count: successCount }
}

async function execRequestApproval(item) {
  const pid = safeId(item.product_id)
  const res = await api('GET', `/v2/providers/seller_api/apis/api/v1/marketplace/seller-products/${pid}`)
  if (res.status !== 200 || !res.parsed) throw new Error(`상품 조회 실패 (status=${res.status}, parsed=${res.parsed})`)
  const d = res.body?.data
  if (!d) throw new Error('상품 페이로드 없음')
  if (d.statusName !== '임시저장') throw new Error(`임시저장 아님 (현재: ${d.statusName ?? '?'})`)

  if (DRY) {
    console.log(`    [dry] request-approval ${pid}`)
    return { dry: true }
  }

  const r = await api('PUT', `/v2/providers/seller_api/apis/api/v1/marketplace/seller-products/${pid}/approvals`, {})
  if (r.status !== 200 || !r.parsed) throw new Error(`승인요청 실패 (status=${r.status}, parsed=${r.parsed})`)
  return { approved: true }
}

const HANDLERS = {
  'restock': execRestock,
  'request-approval': execRequestApproval,
}

// ── 메인 ─────────────────────────────────────────────────────────────────

console.log(`=== Act (쿠팡) ${DRY ? '[DRY-RUN]' : '[APPLY]'} ===\n`)

// 이전 실행에서 프로세스가 죽어 in_progress로 고아된 항목 → pending 복구
const { error: recoverErr } = await sb.from('jimscanner_loop_action_queue')
  .update({ status: 'pending', updated_at: new Date().toISOString() })
  .eq('market', 'coupang')
  .eq('status', 'in_progress')
if (recoverErr) console.error('in_progress 복구 실패 (계속 진행):', recoverErr.message)

const { data: queue, error: qErr } = await sb
  .from('jimscanner_loop_action_queue')
  .select('*')
  .eq('market', 'coupang')
  .eq('status', 'pending')
  .in('action_type', Object.keys(HANDLERS))
  .order('priority', { ascending: false })
  .limit(10)

if (qErr) { console.error('큐 조회 실패:', qErr.message); process.exit(1) }
if (!queue || queue.length === 0) { console.log('처리할 큐 없음.'); process.exit(0) }

console.log(`큐 ${queue.length}건 처리 시작\n`)

let ok = 0, fail = 0
for (const item of queue) {
  const label = `[${item.action_type}] ${(item.product_name ?? '').slice(0, 45)}`

  const handler = HANDLERS[item.action_type]
  if (!handler) {
    console.log(`  − ${label} | 핸들러 없음 → skip`)
    continue
  }

  // in_progress 마킹 실패 시 이 항목 건너뜀 — 고아 방지
  const marked = await dbUpdate(item.id, { status: 'in_progress' })
  if (!marked) {
    console.log(`  − ${label} | in_progress 마킹 실패 → skip`)
    continue
  }

  try {
    const result = await handler(item)
    await dbUpdate(item.id, { status: DRY ? 'pending' : 'done' })
    if (!DRY) {
      const logged = await dbLog({
        queue_id: item.id, market: 'coupang', product_id: item.product_id,
        action_type: item.action_type, success: true,
        after_state: result,   // 핸들러는 집계 데이터만 반환 (ID 목록 미포함)
        executed_at: new Date().toISOString(),
      })
      if (!logged) console.error(`  [WARN] ✓ 실행은 성공했으나 로그 미기록 — 수동 확인 필요: ${label}`)
    }
    console.log(`  ✓ ${label}`)
    ok++
  } catch (e) {
    const retries = (item.retry_count ?? 0) + 1
    const newStatus = retries >= 3 ? 'human_review' : 'pending'
    await dbUpdate(item.id, { status: newStatus, retry_count: retries, error_msg: e.message })
    const logged = await dbLog({
      queue_id: item.id, market: 'coupang', product_id: item.product_id,
      action_type: item.action_type, success: false,
      error_msg: e.message,   // 에러 메시지만 저장, API 응답 원문 미저장
      executed_at: new Date().toISOString(),
    })
    if (!logged) console.error(`  [WARN] 실패 로그 미기록 — 수동 확인 필요: ${label}`)
    console.log(`  ✗ ${label} | ${e.message} (retry ${retries}/3${newStatus === 'human_review' ? ' → human_review' : ''})`)
    fail++
  }

  await sleep(300)
}

console.log(`\n=== 완료: 성공 ${ok} / 실패 ${fail} ===`)
