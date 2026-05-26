/**
 * 쿠팡 자동수선 재등록
 *
 * jimscanner_coupang_rejection_patterns.fix_template.payload_patch 를
 * 거절된 리스팅의 원본 페이로드에 머지해 신규 seller-products 페이로드로 재제출한다.
 *
 * /admin/coupang-publish/rejections 의 "자동 수선 재등록" 버튼이 호출하는 워커.
 *
 * 사용:
 *   node scripts/auto-repair-coupang.mjs --listing <uuid>            # 단건
 *   node scripts/auto-repair-coupang.mjs --cluster <cid>             # 클러스터 전체
 *   node scripts/auto-repair-coupang.mjs --cluster <cid> --dry-run   # 페이로드만 생성, 제출 안 함
 *
 * 안전장치:
 *   - 동일 listing 에 대해 직전 24시간 내 success 가 있으면 skip
 *   - fix_template.payload_patch 가 비어있으면 skip (label/summary 만 있는 클러스터)
 *   - dry-run 모드는 외부 호출 없음
 */
import crypto from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { createClient } from '@supabase/supabase-js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const env = Object.fromEntries(
  readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8')
    .split(/\r?\n/)
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => {
      const i = l.indexOf('=')
      let v = l.slice(i + 1).trim()
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
      return [l.slice(0, i).trim(), v]
    }),
)

const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY)
const ACCESS_KEY = env.COUPANG_ACCESS_KEY
const SECRET_KEY = env.COUPANG_SECRET_KEY
const HOST = env.COUPANG_API_HOST || 'https://api-gateway.coupang.com'

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const listingIdx = args.indexOf('--listing')
const clusterIdx = args.indexOf('--cluster')
const listingArg = listingIdx >= 0 ? args[listingIdx + 1] : null
const clusterArg = clusterIdx >= 0 ? parseInt(args[clusterIdx + 1]) : null

function sign(method, urlPath, query = '') {
  const dt = new Date().toISOString().substring(2, 19).replace(/[-:]/g, '') + 'Z'
  const message = dt + method + urlPath + (query || '')
  return { datetime: dt, signature: crypto.createHmac('sha256', SECRET_KEY).update(message).digest('hex') }
}
async function api(method, urlPath, body = null) {
  if (!ACCESS_KEY || !SECRET_KEY) {
    throw new Error('COUPANG_ACCESS_KEY/SECRET_KEY 미설정 — dry-run 으로만 실행 가능')
  }
  const { datetime, signature } = sign(method, urlPath, '')
  const res = await fetch(`${HOST}${urlPath}`, {
    method,
    headers: {
      Authorization: `CEA algorithm=HmacSHA256, access-key=${ACCESS_KEY}, signed-date=${datetime}, signature=${signature}`,
      'Content-Type': 'application/json;charset=UTF-8',
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const t = await res.text()
  try { return { status: res.status, body: JSON.parse(t) } } catch { return { status: res.status, body: t } }
}

/**
 * 깊은 머지 — payload_patch 가 base 의 동일 키를 덮어쓰지만
 * 객체끼리는 재귀 머지, 배열은 patch 값으로 통째 교체.
 */
function deepMerge(base, patch) {
  if (patch == null) return base
  if (Array.isArray(patch)) return patch
  if (typeof patch !== 'object') return patch
  if (base == null || typeof base !== 'object' || Array.isArray(base)) {
    return { ...patch }
  }
  const out = { ...base }
  for (const [k, v] of Object.entries(patch)) {
    out[k] = deepMerge(base[k], v)
  }
  return out
}

async function loadListings() {
  if (listingArg) {
    const { data, error } = await sb
      .from('jimscanner_coupang_listings')
      .select('*')
      .eq('id', listingArg)
      .single()
    if (error) throw error
    return [data]
  }
  if (clusterArg != null) {
    const { data: assigns, error: ae } = await sb
      .from('jimscanner_coupang_rejection_assignments')
      .select('listing_id')
      .eq('cluster_id', clusterArg)
    if (ae) throw ae
    if (!assigns || assigns.length === 0) return []
    const ids = assigns.map((a) => a.listing_id)
    const { data, error } = await sb
      .from('jimscanner_coupang_listings')
      .select('*')
      .in('id', ids)
      .eq('status', 'REJECTED')
    if (error) throw error
    return data ?? []
  }
  throw new Error('--listing <uuid> 또는 --cluster <cid> 필요')
}

async function loadPattern(clusterId) {
  const { data, error } = await sb
    .from('jimscanner_coupang_rejection_patterns')
    .select('*')
    .eq('cluster_id', clusterId)
    .order('generated_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) throw error
  return data
}

async function recentSuccess(listingId) {
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString()
  const { data } = await sb
    .from('jimscanner_coupang_repair_attempts')
    .select('id')
    .eq('listing_id', listingId)
    .eq('result', 'success')
    .gte('attempted_at', since)
    .limit(1)
  return (data?.length ?? 0) > 0
}

async function main() {
  const listings = await loadListings()
  console.log('[start] auto-repair — listings=%d dryRun=%s', listings.length, dryRun)
  if (listings.length === 0) {
    console.log('[done] 대상 없음')
    return
  }

  // 클러스터별 fix_template 캐시
  const patternCache = new Map()

  const summary = { success: 0, failed: 0, skipped: 0, queued: 0 }
  for (const listing of listings) {
    // 어느 클러스터에 속하는지 조회
    const { data: assign } = await sb
      .from('jimscanner_coupang_rejection_assignments')
      .select('cluster_id')
      .eq('listing_id', listing.id)
      .maybeSingle()
    const clusterId = clusterArg != null ? clusterArg : assign?.cluster_id
    if (clusterId == null) {
      console.log('  skip %s — 클러스터 미배정', listing.id)
      summary.skipped += 1
      continue
    }
    let pattern = patternCache.get(clusterId)
    if (!pattern) {
      pattern = await loadPattern(clusterId)
      patternCache.set(clusterId, pattern)
    }
    if (!pattern || !pattern.fix_template) {
      console.log('  skip %s — 패턴 없음', listing.id)
      summary.skipped += 1
      continue
    }
    const payloadPatch = pattern.fix_template.payload_patch
    if (!payloadPatch || Object.keys(payloadPatch).length === 0) {
      console.log('  skip %s — payload_patch 비어있음 (수동 검토 필요)', listing.id)
      await sb.from('jimscanner_coupang_repair_attempts').insert({
        listing_id: listing.id,
        cluster_id: clusterId,
        fix_template: pattern.fix_template,
        result: 'skipped',
        error_message: 'payload_patch empty',
      })
      summary.skipped += 1
      continue
    }
    if (await recentSuccess(listing.id)) {
      console.log('  skip %s — 24h 내 성공 이력', listing.id)
      summary.skipped += 1
      continue
    }

    // 원본 페이로드 복원. listing.raw_payload (JSON) 가 있다고 가정.
    const basePayload = listing.raw_payload ?? listing.payload ?? {}
    const repaired = deepMerge(basePayload, payloadPatch)

    if (dryRun) {
      console.log('  dry %s cluster=%d patch keys=%s', listing.id, clusterId, Object.keys(payloadPatch).join(','))
      summary.queued += 1
      continue
    }

    try {
      const r = await api('POST', '/v2/providers/seller_api/apis/api/v1/marketplace/seller-products', repaired)
      const ok = r.status === 200 && r.body?.code === 'SUCCESS'
      const newSpid = r.body?.data?.sellerProductId ?? null
      await sb.from('jimscanner_coupang_repair_attempts').insert({
        listing_id: listing.id,
        cluster_id: clusterId,
        fix_template: pattern.fix_template,
        result: ok ? 'success' : 'failed',
        new_seller_product_id: newSpid,
        error_message: ok ? null : (typeof r.body === 'string' ? r.body.slice(0, 500) : JSON.stringify(r.body).slice(0, 500)),
      })
      if (ok) {
        summary.success += 1
        console.log('  ✓ %s → sellerPID=%s', listing.id, newSpid)
      } else {
        summary.failed += 1
        console.log('  ✗ %s status=%d', listing.id, r.status)
      }
    } catch (e) {
      await sb.from('jimscanner_coupang_repair_attempts').insert({
        listing_id: listing.id,
        cluster_id: clusterId,
        fix_template: pattern.fix_template,
        result: 'failed',
        error_message: String(e.message ?? e).slice(0, 500),
      })
      summary.failed += 1
      console.log('  ✗ %s exception=%s', listing.id, e.message)
    }
  }
  console.log('[done]', summary)
}

main().catch((e) => {
  console.error('[fatal]', e)
  process.exit(1)
})
