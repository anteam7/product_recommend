/**
 * 로컬 cron — 쿠팡 등록상품의 ggsan 재고 동기화 (Windows 작업 스케줄러 "Coupang-Stock-Sync"가 시간당 실행)
 *
 * src/app/api/cron/coupang-stock-sync/route.ts 의 로직을 로컬에서 그대로 수행한다.
 * (Vercel 엔드포인트는 maxDuration=60인데 146개 점검에 ~118s 걸려 타임아웃 → 로컬 직접 실행 필수.)
 *
 * 흐름:
 *   0) PENDING_APPROVAL 폴링 → 승인완료시 재고 보충 + status=APPROVED
 *   1) APPROVED/SELLING 상품의 매입처 재고 확인 — 4개 공급처 전부
 *        ggsan · bio77   : goods_view.php 라이브 조회(상용몰 엔진)
 *        upickb2b · wellroot : Cafe24 카테고리 리스트 품절아이콘 스캔
 *   2) 신규 품절 → 쿠팡 판매중지(STOPPED) / 재입고 → 판매재개
 *   3) 재고 있는 상품은 쿠팡 판매가능수량을 MIN_QTY 이상으로 유지(주문이 끊기지 않게)
 *   4) 실행 로그를 jimscanner_coupang_stock_sync_runs 에 기록 (관리자 위젯 소스)
 *
 * ⚠ 2026-09-19 이전에는 upick 이외 공급처를 전부 ggsan goods_view 로 조회했다.
 *   bio77·wellroot 상품번호로 ggsan 을 조회하던 셈이라 판정이 무의미했다(대부분 unknown).
 *   또 Cafe24 AuthSSL 로 유픽 로그인이 403 이 되면서 2026-09-02 부터 유픽 품절이 전혀 감지되지 않았다.
 *
 * 유실 주의: 이 파일이 없으면 작업이 "파일 없음"으로 exit 1 → 위젯 마지막성공 시점에서 멈춤. (2026-05-31 복구)
 */
import crypto from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { createClient } from '@supabase/supabase-js'
import { makeSession, cafe24Login, cafe24BuildStockMap, mallLogin, mallCheckStock } from './lib/supplier-stock.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const env = Object.fromEntries(
  readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8')
    .split(/\r?\n/)
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => { const i = l.indexOf('='); let v = l.slice(i + 1).trim(); if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1); return [l.slice(0, i).trim(), v] }),
)
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY)
const HOST = env.COUPANG_API_HOST || 'https://api-gateway.coupang.com'
const ACCESS = env.COUPANG_ACCESS_KEY
const SECRET = env.COUPANG_SECRET_KEY
const BASE = env.GGSAN_BASE_URL || 'https://www.ggsan.com'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
const sleep = (ms) => new Promise((s) => setTimeout(s, ms))

// 매입처에 재고가 있으면 쿠팡 판매가능수량을 이 밑으로 두지 않는다(주문이 끊기지 않게).
// 위탁배송이라 우리가 재고를 떠안지 않으므로 넉넉히 잡아도 위험이 없다 — 품절은 매입처 신호로만 판단한다.
const DRY = process.argv.includes('--dry')
const MIN_QTY = +(env.COUPANG_MIN_QTY || 10)
const TARGET_QTY = +(env.COUPANG_TARGET_QTY || 30)

// 공급처별 사이트
const SUPPLIERS = {
  ggsan:    { kind: 'mall',    base: env.GGSAN_BASE_URL     || 'https://www.ggsan.com',  user: env.GGSAN_USER,     pass: env.GGSAN_PASS,     label: '건강산' },
  bio77:    { kind: 'mall',    base: env.BIO77_BASE_URL     || 'https://77bio.co.kr',    user: env.BIO77_USER,     pass: env.BIO77_PASS,     label: '77바이오' },
  upickb2b: { kind: 'cafe24',  base: env.UPICKB2B_BASE_URL  || 'https://upickb2b.com',   user: env.UPICKB2B_USER,  pass: env.UPICKB2B_PASS,  label: '유픽B2B', table: 'jimscanner_upickb2b_products', key: 'product_no', cateCol: 'cate_no' },
  wellroot: { kind: 'cafe24',  base: env.WELLROOT_BASE_URL  || 'https://wellrootb2b.com', user: env.WELLROOT_USER, pass: env.WELLROOT_PASS,  label: '웰루트',  table: 'jimscanner_wellroot_products',  key: 'product_no', cateCol: 'cate_nos' },
}

function signCoupang(method, urlPath) {
  const dt = new Date().toISOString().substring(2, 19).replace(/[-:]/g, '') + 'Z'
  return { datetime: dt, signature: crypto.createHmac('sha256', SECRET).update(dt + method + urlPath).digest('hex') }
}
async function coupangApi(method, urlPath, body = null) {
  const { datetime, signature } = signCoupang(method, urlPath)
  const res = await fetch(`${HOST}${urlPath}`, {
    method,
    headers: { Authorization: `CEA algorithm=HmacSHA256, access-key=${ACCESS}, signed-date=${datetime}, signature=${signature}`, 'Content-Type': 'application/json;charset=UTF-8' },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  try { return { status: res.status, body: JSON.parse(text) } } catch { return { status: res.status, body: text } }
}

// 판매 중지/재개는 vendor-item 레벨만 유효 (seller-products/{id}/sales/stop 은 404 PRECONDITION_FAILED — 미존재 엔드포인트).
async function setVendorSale(spid, action) {
  const d = (await coupangApi('GET', `/v2/providers/seller_api/apis/api/v1/marketplace/seller-products/${spid}`)).body?.data
  const items = (d?.items ?? []).filter((it) => it.vendorItemId)
  if (!items.length) return { status: 500 }
  let ok = true
  for (const it of items) {
    const r = await coupangApi('PUT', `/v2/providers/seller_api/apis/api/v1/marketplace/vendor-items/${it.vendorItemId}/sales/${action}`)
    if (r.status !== 200) ok = false
    await sleep(150)
  }
  return { status: ok ? 200 : 500 }
}
const stopCoupangSale = (spid) => DRY ? { status: 200 } : setVendorSale(spid, 'stop')
const resumeCoupangSale = (spid) => DRY ? { status: 200 } : setVendorSale(spid, 'resume')

/**
 * 매입처 재고가 있는 상품의 쿠팡 판매가능수량을 MIN_QTY 이상으로 유지한다.
 * 쿠팡은 팔릴 때마다 수량이 줄어들어 0이 되면 자동 품절 처리되는데, 위탁배송이라
 * 우리 창고 재고와 무관하다 — 매입처에 물건이 있는 한 주문을 계속 받아야 한다.
 * 변형(vendorItem)마다 따로 관리되므로 전부 확인한다.
 * @returns 보충한 변형 수
 */

/** 변형 전체 수량을 지정값으로 설정 (품절 처리 시 0). */
async function setQuantity(spid, qty) {
  if (DRY) return
  const d = (await coupangApi('GET', `/v2/providers/seller_api/apis/api/v1/marketplace/seller-products/${spid}`)).body?.data
  for (const it of (d?.items ?? [])) {
    if (!it.vendorItemId) continue
    await coupangApi('PUT', `/v2/providers/seller_api/apis/api/v1/marketplace/vendor-items/${it.vendorItemId}/quantities/${qty}`)
    await sleep(150)
  }
}
async function ensureQuantity(spid, { force = false } = {}) {
  if (DRY) return 0
  const d = (await coupangApi('GET', `/v2/providers/seller_api/apis/api/v1/marketplace/seller-products/${spid}`)).body?.data
  const vids = (d?.items ?? []).map((it) => it.vendorItemId).filter(Boolean)
  let filled = 0
  for (const vid of vids) {
    const inv = (await coupangApi('GET', `/v2/providers/seller_api/apis/api/v1/marketplace/vendor-items/${vid}/inventories`)).body?.data
    const cur = typeof inv?.amountInStock === 'number' ? inv.amountInStock : null
    // 사람이 Wing 에서 직접 판매중지한 건(onSale=false)은 되살리지 않는다.
    // 자동 보충이 수동 품절 처리를 덮어쓰면 의도와 정반대가 된다(2026-09-19 사용자 지적).
    // 우리가 재입고로 판매재개한 경우엔 resume 직후라 onSale=true 여서 정상적으로 보충된다.
    // force=재입고로 우리가 방금 판매재개한 경우(onSale 반영 지연 대비)
    if (!force && inv?.onSale === false) { await sleep(120); continue }
    if (cur === null || cur >= MIN_QTY) { await sleep(120); continue }
    const r = await coupangApi('PUT', `/v2/providers/seller_api/apis/api/v1/marketplace/vendor-items/${vid}/quantities/${TARGET_QTY}`)
    if (r.status === 200) filled++
    await sleep(200)
  }
  return filled
}

// ─── 메인 ───
const { data: runRow } = await sb.from('jimscanner_coupang_stock_sync_runs').insert({ status: 'running', triggered_by: 'local-cron' }).select('id').single()
const runId = runRow?.id
const startedAt = Date.now()
let total = 0, soldOut = 0, resumed = 0, errors = 0, refilled = 0

try {
  // 0) PENDING_APPROVAL 폴링
  const { data: pending } = await sb.from('jimscanner_coupang_listings').select('id, seller_product_id').eq('status', 'PENDING_APPROVAL')
  for (const p of (pending ?? [])) {
    if (!p.seller_product_id) continue
    const detail = await coupangApi('GET', `/v2/providers/seller_api/apis/api/v1/marketplace/seller-products/${p.seller_product_id}`)
    const d = detail.body?.data
    const statusName = d?.statusName
    if (statusName === '승인완료') {
      for (const it of (d?.items ?? [])) { if (it.vendorItemId) await coupangApi('PUT', `/v2/providers/seller_api/apis/api/v1/marketplace/vendor-items/${it.vendorItemId}/quantities/5`) }
      await sb.from('jimscanner_coupang_listings').update({ status: 'APPROVED', approval_status_name: statusName, approved_at: new Date().toISOString(), displayable: true, auto_paused: false, stock_status: 'in_stock', last_synced_at: new Date().toISOString() }).eq('id', p.id)
    } else if (statusName === '승인거절' || statusName === '거절') {
      await sb.from('jimscanner_coupang_listings').update({ status: 'REJECTED', approval_status_name: statusName, rejection_reason: '쿠팡 검수 거절 (Wing에서 사유 확인 필요)', last_synced_at: new Date().toISOString() }).eq('id', p.id)
    } else {
      await sb.from('jimscanner_coupang_listings').update({ approval_status_name: statusName ?? null, last_synced_at: new Date().toISOString() }).eq('id', p.id)
    }
    await sleep(200)
  }

  // 1) 활성 상품 재고 추적
  // STOPPED 도 포함해야 재입고를 감지할 수 있다. 예전에는 APPROVED/SELLING 만 봐서
  // 한 번 품절로 중지되면 영영 다시 조회되지 않았다(resumed 가 항상 0이었던 이유, 2026-09-19 발견).
  // 단 사람이 내린 건(auto_paused=false 인 STOPPED — 중복 등록 정리 등)은 건드리지 않는다.
  const { data: listings } = await sb.from('jimscanner_coupang_listings').select('id, seller_product_id, source, source_goods_no, stock_status, auto_paused, status').in('status', ['APPROVED', 'SELLING', 'STOPPED'])
  const rows = (listings ?? []).filter((r) => r.status !== 'STOPPED' || r.auto_paused)
  if (rows.length === 0) {
    await sb.from('jimscanner_coupang_stock_sync_runs').update({ finished_at: new Date().toISOString(), total_checked: 0, status: 'success', duration_ms: Date.now() - startedAt }).eq('id', runId)
    console.log('[local-cron-stock] no active listings'); process.exit(0)
  }

  // ── 공급처별 세션 준비 ──
  //  상용몰(ggsan·bio77)은 상품별 라이브 조회, Cafe24(upick·wellroot)는 카테고리 스캔으로 재고맵을 만든다.
  //  한 공급처가 실패해도 나머지는 계속 돌도록 개별 try 로 감싼다(전체 중단 방지).
  const sessions = {}      // source -> session
  const stockMaps = {}     // source -> Map(goodsNo -> status)
  const skipped = []       // 로그인·스캔 실패로 추적 못 한 공급처
  for (const [src, conf] of Object.entries(SUPPLIERS)) {
    const srcRows = rows.filter((r) => r.source === src && r.source_goods_no)
    if (!srcRows.length) continue
    if (!conf.user || !conf.pass) { skipped.push(`${conf.label}(자격증명 없음)`); continue }
    try {
      const session = makeSession()
      if (conf.kind === 'mall') {
        await mallLogin(session, conf)
        sessions[src] = session
        console.log(`[local-cron-stock] ${conf.label} 로그인 OK (${srcRows.length}건 라이브 조회)`)
      } else {
        await cafe24Login(session, conf)
        const nos = [...new Set(srcRows.map((r) => String(r.source_goods_no)))]
        const { data: catRows } = await sb.from(conf.table).select(conf.cateCol).in(conf.key, nos)
        const cates = [...new Set((catRows ?? []).flatMap((r) => {
          const v = r[conf.cateCol]
          return Array.isArray(v) ? v.map(String) : (v == null ? [] : [String(v)])
        }).filter(Boolean))]
        const map = await cafe24BuildStockMap(session, conf.base, cates)
        stockMaps[src] = map
        const soldN = [...map.values()].filter((v) => v === 'sold_out').length
        const hit = nos.filter((n) => map.has(n)).length
        console.log(`[local-cron-stock] ${conf.label} 재고맵 ${map.size}건(품절 ${soldN}) · 대상 ${nos.length}건 중 ${hit}건 매칭`)
        if (hit === 0) skipped.push(`${conf.label}(스캔 결과 0건 매칭)`)
      }
    } catch (e) {
      skipped.push(`${conf.label}(${e instanceof Error ? e.message : e})`)
      console.log(`[local-cron-stock] ⚠ ${conf.label} 재고추적 불가 — 해당 공급처는 이번 회차 건너뜀`)
    }
  }
  if (skipped.length) console.log(`[local-cron-stock] ⚠ 추적 실패: ${skipped.join(' · ')}`)

  for (const row of rows) {
    total++
    try {
      // 공급처별 판정: 상용몰은 라이브 조회, Cafe24 는 재고맵 룩업.
      // 세션이 없거나(로그인 실패) 맵에 없으면 unknown — 확인 불가일 때는 아무 조치도 하지 않는다.
      const conf = SUPPLIERS[row.source]
      let status = 'unknown'
      if (conf?.kind === 'mall' && sessions[row.source]) {
        status = await mallCheckStock(sessions[row.source], conf.base, row.source_goods_no)
      } else if (conf?.kind === 'cafe24' && stockMaps[row.source]) {
        status = stockMaps[row.source].get(String(row.source_goods_no)) ?? 'unknown'
      }
      const wasPaused = !!row.auto_paused
      const updates = { stock_status: status, last_stock_check: new Date().toISOString() }
      if (status === 'sold_out' && !wasPaused && row.seller_product_id) {
        // 매입처 품절 → 쿠팡도 즉시 품절. 판매중지와 함께 수량도 0으로 내려
        // 노출이 남아 주문이 들어오는 일을 막는다(판매중지 반영이 지연될 수 있음).
        if ((await stopCoupangSale(row.seller_product_id)).status === 200) {
          await setQuantity(row.seller_product_id, 0)
          updates.auto_paused = true; updates.coupang_sale_stopped_at = new Date().toISOString(); updates.stock_sold_out_at = new Date().toISOString(); updates.status = 'STOPPED'; soldOut++
        } else errors++
      } else if (status === 'in_stock' && wasPaused && row.seller_product_id) {
        // 재입고 → 판매재개 + 수량 복구(재개만 하고 수량이 0이면 여전히 품절로 보인다)
        if ((await resumeCoupangSale(row.seller_product_id)).status === 200) {
          refilled += await ensureQuantity(row.seller_product_id, { force: true })
          updates.auto_paused = false; updates.coupang_sale_stopped_at = null; updates.stock_sold_out_at = null; updates.status = 'APPROVED'; resumed++
        } else errors++
      } else if (status === 'in_stock' && !wasPaused && row.seller_product_id) {
        // 정상 판매중 — 팔려서 줄어든 수량을 MIN_QTY 이상으로 되채운다(주문이 끊기지 않게)
        refilled += await ensureQuantity(row.seller_product_id)
      }
      if (!DRY) await sb.from('jimscanner_coupang_listings').update(updates).eq('id', row.id)
      await sleep(200)
    } catch (e) { errors++; if (errors <= 3) console.log(`  row ${row.source_goods_no} error: ${e instanceof Error ? e.message : e}`) }
  }

  await sb.from('jimscanner_coupang_stock_sync_runs').update({ finished_at: new Date().toISOString(), total_checked: total, sold_out_count: soldOut, resumed_count: resumed, error_count: errors, duration_ms: Date.now() - startedAt, status: 'success' }).eq('id', runId)
  console.log(`[local-cron-stock] total=${total} soldOut=${soldOut} resumed=${resumed} refilled=${refilled} errors=${errors} (${((Date.now() - startedAt) / 1000).toFixed(1)}s)`)
  process.exit(0)
} catch (e) {
  const msg = e instanceof Error ? e.message : String(e)
  await sb.from('jimscanner_coupang_stock_sync_runs').update({ finished_at: new Date().toISOString(), total_checked: total, sold_out_count: soldOut, resumed_count: resumed, error_count: errors, duration_ms: Date.now() - startedAt, status: 'error', error_message: msg }).eq('id', runId)
  console.error(`[local-cron-stock] ERROR: ${msg}`)
  process.exit(1)
}
