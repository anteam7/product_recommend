#!/usr/bin/env node
/**
 * 관세청 HS코드 수입통계 fetcher (TRASS / 관세청 OpenAPI 호환).
 *
 * 동작:
 *  - customs_hs_taxonomy_map.is_active = true 인 hs_code_prefix 들을 모두 모아
 *    각각의 최근 12개월 월별 수입금액·수량을 TRASS OpenAPI 로 받아
 *    jimscanner_customs_imports 에 UPSERT 한다.
 *  - 환경변수 CUSTOMS_API_KEY 가 없으면 mock 모드로 폴백 (개발 환경용).
 *
 * 사용:
 *   node --env-file=.env.local scripts/customs-import-fetch.mjs
 *   node --env-file=.env.local scripts/customs-import-fetch.mjs --hs 2106
 *   node --env-file=.env.local scripts/customs-import-fetch.mjs --mock
 *
 * cron 등록은 scripts/run-crons.mjs 에 한 줄 추가 (주 1회 권장).
 */
import { createClient } from '@supabase/supabase-js'

const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!url || !key) {
  console.error('missing SUPABASE env. did you run with --env-file=.env.local ?')
  process.exit(1)
}
const sb = createClient(url, key, { auth: { persistSession: false } })

const args = process.argv.slice(2)
const FORCE_MOCK = args.includes('--mock') || !process.env.CUSTOMS_API_KEY
const HS_FILTER = (() => {
  const i = args.indexOf('--hs')
  return i >= 0 ? args[i + 1] : null
})()

const SOURCE = FORCE_MOCK ? 'mock' : 'trass'
const STARTED_AT = new Date().toISOString()
const t0 = Date.now()

function monthsBack(n) {
  const out = []
  const now = new Date()
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1))
    out.push(d.toISOString().slice(0, 10))
  }
  return out
}

/**
 * TRASS / 관세청 OpenAPI 호출. 응답 스키마는 사이트마다 미묘하게 다르므로
 * 실제 키가 들어오면 이 함수만 손보면 된다.
 * 현재는 mock 폴백.
 */
async function fetchHsMonthly(hsCode) {
  const months = monthsBack(12)

  if (FORCE_MOCK) {
    // 결정론적 mock: hs_code 해시 기반으로 자연스러운 시계열 생성
    const seed = [...hsCode].reduce((a, c) => a + c.charCodeAt(0), 0)
    const base = 1_000_000 + (seed % 7) * 500_000
    const growth = 1 + ((seed % 5) - 2) * 0.03
    return months.map((month, idx) => {
      const noise = 0.85 + ((seed * (idx + 1)) % 30) / 100
      const value = Math.round(base * Math.pow(growth, idx) * noise)
      const qty = Math.round(value / (50 + (seed % 30)))
      return {
        hs_code: hsCode,
        hs_name: `HS ${hsCode} (mock)`,
        month,
        import_value_usd: value,
        import_qty: qty,
        prev_yoy: idx >= 11 ? null : Math.round(((growth - 1) * 100 + (noise - 0.95) * 50) * 10) / 10,
        source: SOURCE,
        raw: { mock: true, idx },
      }
    })
  }

  // 실 호출 자리 (TRASS API spec 에 맞춰 채울 것)
  // const apiKey = process.env.CUSTOMS_API_KEY
  // const res = await fetch(`https://trass.kctdi.or.kr/.../monthly?hs=${hsCode}&apiKey=${apiKey}`)
  // const json = await res.json()
  // return json.items.map((r) => ({ ... }))
  throw new Error('TRASS API integration not implemented — set CUSTOMS_API_KEY or pass --mock')
}

async function recordRun(status, fetched, inserted, errorMessage) {
  await sb.from('jimscanner_trends_runs').insert({
    source: 'customs_import_fetch',
    status,
    fetched_count: fetched,
    inserted_count: inserted,
    duration_ms: Date.now() - t0,
    error_message: errorMessage ?? null,
    triggered_by: 'cli',
    started_at: STARTED_AT,
    finished_at: new Date().toISOString(),
  })
}

try {
  const mapQuery = sb
    .from('customs_hs_taxonomy_map')
    .select('hs_code_prefix')
    .eq('is_active', true)
  const { data: mapRows, error: mapErr } = await mapQuery
  if (mapErr) throw mapErr

  let hsCodes = [...new Set((mapRows ?? []).map((r) => r.hs_code_prefix).filter(Boolean))]
  if (HS_FILTER) hsCodes = hsCodes.filter((c) => c === HS_FILTER || c.startsWith(HS_FILTER))
  if (hsCodes.length === 0) {
    console.log('no active hs_code_prefix in customs_hs_taxonomy_map — seed first')
    await recordRun('partial', 0, 0, 'no hs codes')
    process.exit(0)
  }

  console.log(`fetching ${hsCodes.length} HS codes (source=${SOURCE})`)

  let fetched = 0
  let inserted = 0
  for (const hs of hsCodes) {
    try {
      const rows = await fetchHsMonthly(hs)
      fetched += rows.length
      if (rows.length === 0) continue
      const { error: upErr, count } = await sb
        .from('jimscanner_customs_imports')
        .upsert(rows, { onConflict: 'hs_code,month,source', count: 'exact' })
      if (upErr) throw upErr
      inserted += count ?? rows.length
      console.log(`  ${hs}: ${rows.length} rows`)
    } catch (e) {
      console.error(`  ${hs}: ${e.message}`)
    }
  }

  await recordRun('ok', fetched, inserted)
  console.log(`done. fetched=${fetched} inserted=${inserted} duration=${Date.now() - t0}ms`)
} catch (e) {
  console.error('fatal:', e.message)
  await recordRun('error', 0, 0, e.message).catch(() => {})
  process.exit(1)
}
