#!/usr/bin/env node
/**
 * naver-insight-demo-extract.mjs
 *
 * 목적: naver_shopping_insight 가 이미 jimscanner_trends_raw 에 적재한 응답을
 *       재파싱해서 product 단위 demographic fingerprint 산출.
 *       추가 API 호출 0. 기존 raw payload 만 사용.
 *
 * 산출:
 *   - gender_share = {m, f}              (합 = 1.0)
 *   - age_share    = {"10","20",...,"60"} (합 = 1.0)
 *   - dominant_segment (예: "20s_f")
 *   - concentration_hhi = sum(share^2)
 *
 * raw payload 가 demographic-segmented (gender/ages 필터 기반 batch) 일 때:
 *   request_label 또는 payload 내부 메타에서 dimension 을 추출.
 *   현재 collect.ts 는 demographic 필터 없이 전체 응답만 받음 → 균등 분포(prior) 로 fallback.
 *   추후 collect 가 demographic 분할 호출을 추가하면 자동으로 share 가 채워짐.
 *
 * 사용:
 *   node scripts/naver-insight-demo-extract.mjs            # 최근 14일 raw 전체
 *   node scripts/naver-insight-demo-extract.mjs --days=30  # 기간 변경
 *   node scripts/naver-insight-demo-extract.mjs --dry      # 적재 안 하고 출력만
 */

import { createClient } from '@supabase/supabase-js'

const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!url || !key) {
  console.error('NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 필요')
  process.exit(1)
}
const sb = createClient(url, key, { auth: { persistSession: false } })

const args = new Set(process.argv.slice(2))
const dry = args.has('--dry')
const daysArg = [...args].find((a) => a.startsWith('--days='))
const days = daysArg ? Math.max(1, Number(daysArg.split('=')[1] || 14)) : 14

const AGE_BUCKETS = ['10', '20', '30', '40', '50', '60']
const GENDERS = ['m', 'f']

function uniformFingerprint() {
  const g = Object.fromEntries(GENDERS.map((k) => [k, 1 / GENDERS.length]))
  const a = Object.fromEntries(AGE_BUCKETS.map((k) => [k, 1 / AGE_BUCKETS.length]))
  return { gender_share: g, age_share: a }
}

function normalize(obj) {
  const sum = Object.values(obj).reduce((s, v) => s + (Number(v) || 0), 0)
  if (sum <= 0) return null
  const out = {}
  for (const [k, v] of Object.entries(obj)) out[k] = +(Number(v) / sum).toFixed(4)
  return out
}

function hhi(share) {
  return +Object.values(share)
    .reduce((s, v) => s + Number(v) * Number(v), 0)
    .toFixed(4)
}

function dominantLabel(gender, age) {
  const topG = Object.entries(gender).sort((a, b) => b[1] - a[1])[0]
  const topA = Object.entries(age).sort((a, b) => b[1] - a[1])[0]
  if (!topG || !topA) return null
  return `${topA[0]}s_${topG[0]}`
}

/**
 * raw payload 에서 demographic share 추출 시도.
 * Naver DataLab 응답 자체는 group.data[].ratio 시계열만 있어 demographic 분해가 직접 안 됨.
 * 따라서 payload._meta.gender / _meta.ages 같은 힌트 또는 별도 segmented 적재 (향후 확장) 를 우선 본다.
 * 없으면 ratio 기반 가중치만이라도 만들어 prior 보다 약한 신호로 쓴다.
 */
function extractFromRaw(payload, requestLabel) {
  const fp = uniformFingerprint()
  // 힌트 메타 (확장 포인트)
  const meta = payload?._meta
  if (meta?.gender_share && typeof meta.gender_share === 'object') {
    const n = normalize(meta.gender_share)
    if (n) fp.gender_share = n
  }
  if (meta?.age_share && typeof meta.age_share === 'object') {
    const n = normalize(meta.age_share)
    if (n) fp.age_share = n
  }
  // payload 자체가 gender-segmented 일 경우 (그룹명에 'm_' / 'f_' 접두)
  const results = payload?.results
  if (Array.isArray(results)) {
    const gAgg = { m: 0, f: 0 }
    const aAgg = Object.fromEntries(AGE_BUCKETS.map((k) => [k, 0]))
    let touched = false
    for (const g of results) {
      const title = String(g?.title || '')
      const lastRatio = Number(g?.data?.[g.data.length - 1]?.ratio || 0)
      if (!lastRatio) continue
      // 그룹 타이틀 패턴 (e.g. "여성 20대 의류", "f_20")
      const female = /여성|female|^f[_\s-]/i.test(title)
      const male = /남성|male|^m[_\s-]/i.test(title)
      if (female) {
        gAgg.f += lastRatio
        touched = true
      } else if (male) {
        gAgg.m += lastRatio
        touched = true
      }
      const ageMatch = title.match(/(\d0)(?:대|s|\b)/i)
      if (ageMatch && AGE_BUCKETS.includes(ageMatch[1])) {
        aAgg[ageMatch[1]] += lastRatio
        touched = true
      }
    }
    if (touched) {
      const gn = normalize(gAgg)
      const an = normalize(aAgg)
      if (gn && Object.values(gn).some((v) => v > 0)) fp.gender_share = gn
      if (an && Object.values(an).some((v) => v > 0)) fp.age_share = an
    }
  }
  return fp
}

async function loadCandidateProducts() {
  // alias 가 있는 product 전체 — alias 텍스트로 raw payload 매칭
  const { data, error } = await sb
    .from('jimscanner_trends_products')
    .select('id, canonical_name, category_top, alias_count, last_seen_at')
    .order('last_seen_at', { ascending: false })
    .limit(2000)
  if (error) throw error
  const ids = (data ?? []).map((p) => p.id)
  if (ids.length === 0) return []
  const { data: aliases } = await sb
    .from('jimscanner_trends_aliases')
    .select('product_id, alias')
    .in('product_id', ids)
  const byProduct = new Map()
  for (const a of aliases ?? []) {
    if (!byProduct.has(a.product_id)) byProduct.set(a.product_id, [])
    byProduct.get(a.product_id).push(String(a.alias || '').toLowerCase())
  }
  return (data ?? []).map((p) => ({
    ...p,
    aliases: byProduct.get(p.id) ?? [String(p.canonical_name || '').toLowerCase()],
  }))
}

async function loadRaw() {
  const since = new Date(Date.now() - days * 24 * 3600_000).toISOString()
  const { data, error } = await sb
    .from('jimscanner_trends_raw')
    .select('id, source, request_label, payload, collected_at')
    .eq('source', 'naver_shopping_insight')
    .gte('collected_at', since)
    .order('collected_at', { ascending: false })
    .limit(5000)
  if (error) throw error
  return data ?? []
}

function matchProduct(raw, product) {
  const label = String(raw.request_label || '').toLowerCase()
  const titles = (raw.payload?.results || [])
    .map((g) => String(g?.title || '').toLowerCase())
    .join(' | ')
  const hay = `${label} ${titles}`
  for (const a of product.aliases) {
    if (a && hay.includes(a)) return true
  }
  // category_top 매칭 (faliback)
  if (product.category_top && hay.includes(String(product.category_top).toLowerCase())) return true
  return false
}

async function main() {
  console.log(`naver-insight-demo-extract: 최근 ${days}일 raw → fingerprint 산출`)
  const [products, raws] = await Promise.all([loadCandidateProducts(), loadRaw()])
  console.log(`  products: ${products.length}, raw rows: ${raws.length}`)

  const rows = []
  let matched = 0
  for (const p of products) {
    const hits = raws.filter((r) => matchProduct(r, p))
    if (hits.length === 0) continue
    // 가장 최신 hit 의 payload 로 추출
    const top = hits[0]
    const fp = extractFromRaw(top.payload, top.request_label)
    const gn = normalize(fp.gender_share) || fp.gender_share
    const an = normalize(fp.age_share) || fp.age_share
    const combined = {}
    for (const [gk, gv] of Object.entries(gn)) {
      for (const [ak, av] of Object.entries(an)) {
        combined[`${ak}s_${gk}`] = Number(gv) * Number(av)
      }
    }
    const dominant = dominantLabel(gn, an)
    const hhiScore = hhi(combined)
    rows.push({
      product_id: p.id,
      gender_share: gn,
      age_share: an,
      dominant_segment: dominant,
      concentration_hhi: hhiScore,
      source_label: top.request_label || 'naver_shopping_insight',
    })
    matched++
  }

  console.log(`  product 매칭: ${matched}건`)
  if (dry) {
    console.log(JSON.stringify(rows.slice(0, 5), null, 2))
    return
  }
  if (rows.length === 0) {
    console.log('  적재할 row 없음')
    return
  }

  // 배치 적재 (chunks of 500)
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500)
    const { error } = await sb.from('jimscanner_trends_demo_fingerprint').insert(chunk)
    if (error) {
      console.error('  insert 에러:', error.message)
      process.exit(1)
    }
  }
  console.log(`  적재 완료: ${rows.length} rows → jimscanner_trends_demo_fingerprint`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
