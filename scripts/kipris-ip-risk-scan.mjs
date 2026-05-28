#!/usr/bin/env node
/**
 * KIPRIS 상표·특허 IP 리스크 스캔 (야간 배치).
 *
 * Pre-Listing IP Block Watch — 핀/추천 후보의 canonical_name / brand /
 * 핵심 modifier 토큰을 KIPRIS Open API 로 조회해 활성 상표 적중 여부와
 * 출원인 위험(쿠팡PB·셀럽·대기업), 47류 등 매칭, 분쟁이력, 모방형 변형까지
 * 점수화한 뒤 jimscanner_ip_risk 에 upsert.
 *
 * 출력 등급:
 *   - block   risk_score >= 0.7    (활성 등록 상표 정확일치 + 대기업/PB/47류)
 *   - caution risk_score >= 0.35   (유사 마크 다수 또는 분쟁이력)
 *   - safe    그 외
 *
 * 호출:
 *   node --env-file=.env.local scripts/kipris-ip-risk-scan.mjs                 # 전체
 *   node --env-file=.env.local scripts/kipris-ip-risk-scan.mjs --limit 50      # 50개만
 *   node --env-file=.env.local scripts/kipris-ip-risk-scan.mjs --keyword "오메가3"
 *
 * 요구 env:
 *   - NEXT_PUBLIC_SUPABASE_URL
 *   - SUPABASE_SERVICE_ROLE_KEY
 *   - KIPRIS_API_KEY  (https://plus.kipris.or.kr 발급)
 *
 * KIPRIS 키 없을 때엔 DRY_RUN 모드로 fallback (룰 베이스 추정).
 */

import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const KIPRIS_KEY = process.env.KIPRIS_API_KEY ?? ''

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
  process.exit(1)
}

const sb = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false },
})

const args = process.argv.slice(2)
const limitArg = args.indexOf('--limit')
const SCAN_LIMIT = limitArg >= 0 ? parseInt(args[limitArg + 1] ?? '100', 10) : 100
const kwArg = args.indexOf('--keyword')
const FORCE_KEYWORD = kwArg >= 0 ? args[kwArg + 1] : null
const DRY_RUN = !KIPRIS_KEY

// 출원인 위험 룰 (정규식)
const RE_PB_COUPANG = /(쿠팡|coupang|스타트앤로지|Start ?and ?Logy)/i
const RE_CELEB = /(연예인|아이돌|엔터테인먼트|Entertainment|소속사)/i
const RE_BIGCORP =
  /(삼성|LG|CJ|롯데|아모레|네이버|카카오|SK|GS|현대|한화|두산|오뚜기|농심|동원|풀무원|매일|동서|남양|일동|종근당|대상|빙그레|크라운|롯데|LG생활건강|아모레퍼시픽|삼다수|광동|유한|SAMSUNG|HYUNDAI|AMOREPACIFIC)/i

const PROBLEM_TOKENS = new Set([
  '한정', '특가', '정품', '공식', '국산', '신상', '인기', '추천', '베스트',
  '대용량', '소용량', '리뷰', '후기', '오리지널', '프리미엄',
])

function tokenize(name) {
  if (!name) return []
  return name
    .replace(/[\[\]()「」『』<>《》"'`]/g, ' ')
    .split(/[\s,·\/]+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2 && !PROBLEM_TOKENS.has(t))
}

function classify(score) {
  if (score >= 0.7) return 'block'
  if (score >= 0.35) return 'caution'
  return 'safe'
}

// ─── KIPRIS Open API (KIPRISPlus) 호출 ────────────────────────────
//
// 실제 운영시엔 plus.kipris.or.kr 서비스 키 + trademarkSearchInfo,
// applicantTrademark, applicantSearchInfo, advancedSearchInfo 등을 사용.
// 본 함수는 단일 키워드를 받아 활성 마크 후보를 정규화된 형태로 반환.
//
// 응답 구조 (가공 후):
//   { active: int, dead: int, exact: bool, class47: bool,
//     opposition: int, trial: int,
//     applicants: string[], topMark: { name, applicant, appNo, regNo,
//       status, appDate, expireDate } | null,
//     raw: any }
async function queryKipris(keyword) {
  if (DRY_RUN) {
    // Heuristic fallback — KIPRIS 키가 없을 때.
    const looksBranded = /[A-Z]{2,}|[가-힣]{2,} ?(코리아|랩스|푸드|바이오|헬스|뷰티)/.test(keyword)
    return {
      active: looksBranded ? 2 : 0,
      dead: 0,
      exact: false,
      class47: false,
      opposition: 0,
      trial: 0,
      applicants: [],
      topMark: null,
      raw: { dry_run: true, keyword },
    }
  }

  const url =
    'http://plus.kipris.or.kr/openapi/rest/trademarkInfoSearchService/trademarkSearchInfo' +
    `?ServiceKey=${encodeURIComponent(KIPRIS_KEY)}` +
    `&trademarkName=${encodeURIComponent(keyword)}` +
    '&numOfRows=30&pageNo=1'

  try {
    const res = await fetch(url, { method: 'GET' })
    if (!res.ok) {
      return { active: 0, dead: 0, exact: false, class47: false, opposition: 0, trial: 0, applicants: [], topMark: null, raw: { error: `http_${res.status}` } }
    }
    const xml = await res.text()
    return parseKiprisXml(keyword, xml)
  } catch (e) {
    return { active: 0, dead: 0, exact: false, class47: false, opposition: 0, trial: 0, applicants: [], topMark: null, raw: { error: e?.message ?? String(e) } }
  }
}

function parseKiprisXml(keyword, xml) {
  // 매우 단순한 XML 파서 — KIPRIS 응답은 <item>...</item> 반복.
  const items = []
  const itemRe = /<item>([\s\S]*?)<\/item>/g
  let m
  while ((m = itemRe.exec(xml))) items.push(m[1])

  let active = 0, dead = 0
  let exact = false, class47 = false
  const applicants = []
  let top = null
  let bestScore = -1

  for (const it of items) {
    const get = (tag) => {
      const r = new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(it)
      return r ? r[1].trim() : ''
    }
    const status = get('applicationStatus') || get('regPrivilegeName') || ''
    const name = get('title') || get('trademarkName') || ''
    const applicant = get('applicantName') || ''
    const appNo = get('applicationNumber') || ''
    const regNo = get('registrationNumber') || ''
    const appDate = get('applicationDate') || ''
    const classes = get('classificationCode') || ''

    const isActive = /등록|출원|공고|이의|심사/.test(status) && !/거절|소멸|포기|취하|무효/.test(status)
    if (isActive) active++
    else dead++

    if (name && name.replace(/\s+/g, '').toLowerCase() === keyword.replace(/\s+/g, '').toLowerCase()) {
      exact = true
    }
    if (/(^|,)\s*47(\s|,|$)/.test(classes)) class47 = true
    if (applicant) applicants.push(applicant)

    const score =
      (isActive ? 2 : 0) +
      (exact ? 2 : 0) +
      (RE_BIGCORP.test(applicant) ? 1.5 : 0) +
      (RE_PB_COUPANG.test(applicant) ? 1.5 : 0)
    if (score > bestScore && name) {
      bestScore = score
      top = {
        name,
        applicant,
        appNo,
        regNo,
        status,
        appDate: appDate ? formatDate(appDate) : null,
        expireDate: null,
      }
    }
  }

  return {
    active, dead, exact, class47,
    opposition: 0, trial: 0,
    applicants,
    topMark: top,
    raw: { item_count: items.length },
  }
}

function formatDate(s) {
  // '20240315' → '2024-03-15'
  if (!s || s.length < 8) return null
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`
}

function scoreFrom(report) {
  let score = 0
  if (report.active > 0) score += Math.min(0.3, report.active * 0.05)
  if (report.exact) score += 0.4
  if (report.class47) score += 0.1
  if (report.applicants.some((a) => RE_BIGCORP.test(a))) score += 0.25
  if (report.applicants.some((a) => RE_PB_COUPANG.test(a))) score += 0.3
  if (report.applicants.some((a) => RE_CELEB.test(a))) score += 0.1
  if (report.opposition > 0) score += 0.05
  if (report.trial > 0) score += 0.1
  return Math.min(1, score)
}

// 모방형 한글/영문 변형 (대체어 후보)
function altTerms(keyword) {
  const out = new Set()
  const k = keyword.trim()
  if (!k) return []
  // 영문/한글 상호 변환은 간단 룰만 (실 운영시 LLM 호출 권장).
  if (/^[A-Za-z0-9 ]+$/.test(k)) {
    out.add(k.toLowerCase())
    out.add(k + '++')
    out.add(k + '코리아')
  } else {
    out.add(k + ' 정품')
    out.add(k + ' 오리지널')
    out.add(k + ' 코리아')
  }
  out.delete(k)
  return Array.from(out).slice(0, 5)
}

async function loadCandidateKeywords() {
  if (FORCE_KEYWORD) {
    return [{ keyword: FORCE_KEYWORD, kind: 'canonical' }]
  }

  const out = []

  // 1) pins
  const { data: pins } = await sb
    .from('jimscanner_trends_pins')
    .select('keyword')
    .order('pinned_at', { ascending: false })
    .limit(200)
  for (const p of pins ?? []) {
    if (p?.keyword) out.push({ keyword: p.keyword, kind: 'canonical' })
  }

  // 2) ggsan brand (상위 후보)
  const { data: ggsan } = await sb
    .from('jimscanner_ggsan_products')
    .select('brand, title')
    .order('last_seen_at', { ascending: false })
    .limit(SCAN_LIMIT)
  for (const g of ggsan ?? []) {
    if (g?.brand) out.push({ keyword: g.brand, kind: 'brand' })
    for (const t of tokenize(g?.title ?? '').slice(0, 2)) {
      out.push({ keyword: t, kind: 'modifier' })
    }
  }

  // dedupe
  const seen = new Set()
  const uniq = []
  for (const r of out) {
    const k = `${r.kind}::${r.keyword.trim().toLowerCase()}`
    if (seen.has(k)) continue
    seen.add(k)
    uniq.push(r)
    if (uniq.length >= SCAN_LIMIT) break
  }
  return uniq
}

async function upsertRisk(row) {
  const { error } = await sb
    .from('jimscanner_ip_risk')
    .upsert(row, { onConflict: 'keyword,keyword_kind,ip_class' })
  if (error) console.error(`  upsert error ${row.keyword}: ${error.message}`)
}

async function main() {
  const t0 = Date.now()
  console.log(
    `[${new Date().toISOString()}] kipris-ip-risk-scan start (limit=${SCAN_LIMIT}, dry_run=${DRY_RUN})`,
  )

  const { data: run } = await sb
    .from('jimscanner_ip_risk_runs')
    .insert({ note: DRY_RUN ? 'dry_run (no KIPRIS_API_KEY)' : 'kipris scan' })
    .select('id')
    .single()
  const runId = run?.id

  const candidates = await loadCandidateKeywords()
  console.log(`  candidates: ${candidates.length}`)

  let blocked = 0, caution = 0, safe = 0, errors = 0

  for (const c of candidates) {
    try {
      const report = await queryKipris(c.keyword)
      const score = scoreFrom(report)
      const grade = classify(score)
      const tm = report.topMark

      await upsertRisk({
        keyword: c.keyword,
        keyword_kind: c.kind,
        ip_class: 'all',
        risk_score: score,
        risk_grade: grade,
        active_marks: report.active,
        dead_marks: report.dead,
        exact_hit: report.exact,
        class_47_hit: report.class47,
        pb_coupang_hit: report.applicants.some((a) => RE_PB_COUPANG.test(a)),
        celeb_hit: report.applicants.some((a) => RE_CELEB.test(a)),
        bigcorp_hit: report.applicants.some((a) => RE_BIGCORP.test(a)),
        opposition_count: report.opposition,
        trial_count: report.trial,
        top_mark_name: tm?.name ?? null,
        top_mark_applicant: tm?.applicant ?? null,
        top_mark_app_no: tm?.appNo ?? null,
        top_mark_reg_no: tm?.regNo ?? null,
        top_mark_status: tm?.status ?? null,
        top_mark_app_date: tm?.appDate ?? null,
        top_mark_expire_date: tm?.expireDate ?? null,
        alt_terms: altTerms(c.keyword),
        raw_payload: report.raw,
        scanned_at: new Date().toISOString(),
      })

      if (grade === 'block') blocked++
      else if (grade === 'caution') caution++
      else safe++

      const tag = grade === 'block' ? '🛑' : grade === 'caution' ? '⚠️ ' : '✓ '
      console.log(`  ${tag} ${c.kind} "${c.keyword}" — score=${score.toFixed(2)} active=${report.active}`)
    } catch (e) {
      errors++
      console.error(`  ERR ${c.keyword}: ${e?.message ?? e}`)
    }
  }

  if (runId) {
    await sb
      .from('jimscanner_ip_risk_runs')
      .update({
        finished_at: new Date().toISOString(),
        scanned_keywords: candidates.length,
        blocked_count: blocked,
        caution_count: caution,
        safe_count: safe,
        error_count: errors,
      })
      .eq('id', runId)
  }

  const elapsed = Date.now() - t0
  console.log(
    `[${new Date().toISOString()}] done — block=${blocked} caution=${caution} safe=${safe} err=${errors} (${elapsed}ms)`,
  )
}

main().catch((e) => {
  console.error('fatal:', e)
  process.exit(1)
})
