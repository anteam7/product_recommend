#!/usr/bin/env node
/**
 * 위탁 진입 규제 리스크 라벨러 (KC/식약처/HS).
 *
 * 트렌드 후보 product 마다 KC 안전인증·전파인증·식약처 신고·어린이용품·
 * 의약외품·화장품·식품·전기용품 등 한국 통관·판매 규제 리스크를
 * (1) 키워드 룰엔진 → (2) Claude CLI 검수 순으로 라벨링한다.
 *
 * 호출:
 *   node --env-file=.env.local scripts/classify-regulation.mjs
 *
 * --rule-only 플래그로 LLM 검수 건너뛰기 가능 (빠른 1차 적용).
 */

import { createClient } from '@supabase/supabase-js'
import { spawn } from 'node:child_process'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
  process.exit(1)
}

const sb = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false },
})

const ARGV = new Set(process.argv.slice(2))
const RULE_ONLY = ARGV.has('--rule-only')
const FETCH_LIMIT = 500
const LLM_BATCH_SIZE = 15
const LLM_MAX_REQ_PER_RUN = 10

// ─────────────────────────────────────────────────────────────
// 키워드 룰엔진
// ─────────────────────────────────────────────────────────────
// 각 룰: { tag, severity, flags(부분), match: [keyword|regex] }
// severity 는 같은 product 에 여러 룰 매칭 시 max 값 채택.

const RULES = [
  // 전기·전자 (KC + 전파)
  {
    tag: 'kc_electronics',
    severity: 2,
    flags: { kc_required: true, electric: true },
    match: ['전기', '전동', '전선', '콘센트', '플러그', '어댑터', '충전기', '인버터', '히터', '드라이기', '전기장판', '전기매트', '믹서기', '청소기', '에어프라이어', '전자레인지', '셀프워시', '전기포트'],
  },
  // 무선 / 전파 인증
  {
    tag: 'kc_radio',
    severity: 2,
    flags: { kc_required: true },
    match: ['블루투스', '와이파이', 'wifi', '무선', '리모컨', 'RF', '5GHz', 'IoT', 'NFC', 'GPS', '블랙박스', '무전기'],
  },
  // 리튬 배터리 (운송·통관 제한)
  {
    tag: 'battery_lithium',
    severity: 3,
    flags: { kc_required: true, battery: true },
    match: ['배터리', '충전식', '리튬', '보조배터리', 'powerbank', '파워뱅크', '18650', '리튬이온', '리튬폴리머'],
  },
  // USB·케이블 (KC 전기용품 안전기준 적용 가능)
  {
    tag: 'kc_usb_cable',
    severity: 1,
    flags: { kc_required: true, electric: true },
    match: ['USB', 'C타입', '5핀', '8핀', '라이트닝', '케이블', '멀티탭', '충전 케이블'],
  },
  // 어린이 / 유아 용품 (어린이제품 안전 특별법)
  {
    tag: 'children_product',
    severity: 3,
    flags: { kc_required: true, kc_children: true },
    match: ['어린이', '유아', '아기', '키즈', '베이비', '신생아', '젖병', '이유식', '장난감', '완구', '카시트', '유모차', '보행기', '아동복', '아기띠', '치발기'],
  },
  // 식품 / 건강기능식품 (식약처)
  {
    tag: 'mfds_food',
    severity: 3,
    flags: { mfds_required: true, food_related: true },
    match: ['식품', '먹는', '드시는', '음료', '차', '액상', '캡슐', '정', '환', '분말', '오메가3', '비타민', '유산균', '프로바이오틱', '콜라겐', '단백질', '프로틴', '다이어트 보조', '건기식', '건강기능', '루테인', '밀크씨슬', '홍삼', '꿀', '소금', '과자', '간식'],
  },
  // 화장품 (식약처 화장품법)
  {
    tag: 'cosmetic',
    severity: 2,
    flags: { mfds_required: true, cosmetic: true },
    match: ['화장품', '스킨', '로션', '크림', '에센스', '세럼', '토너', '클렌징', '마스크팩', '선크림', '선블록', '립스틱', '아이섀도', '파운데이션', '쿠션', '향수', '바디로션', '샴푸', '컨디셔너', '트리트먼트'],
  },
  // 의약외품 / 의료기기
  {
    tag: 'mfds_quasi_drug',
    severity: 3,
    flags: { mfds_required: true },
    match: ['치약', '구강세정제', '가글', '생리대', '탐폰', '밴드', '연고', '소독제', '손소독', '마스크', 'KF94', 'KF80', '의료기기', '혈압계', '체온계', '혈당계', '보청기', '콘택트렌즈', '렌즈', '인공눈물'],
  },
  // 멜라토닌 (한국 처방의약품 — 일반 판매 불가)
  {
    tag: 'mfds_prescription',
    severity: 3,
    flags: { mfds_required: true },
    match: ['멜라토닌', 'CBD', '대마', '스테로이드', '에페드린', 'DHEA'],
  },
  // 식기·식품용기 (식품위생법 식품용기 기구)
  {
    tag: 'food_contact',
    severity: 2,
    flags: { mfds_required: true, food_related: true },
    match: ['도시락', '텀블러', '물병', '수저', '젓가락', '식기', '도마', '냄비', '프라이팬', '실리콘 용기', '베이킹 용기'],
  },
  // 자동차 / 차량 (자기인증 / 안전기준)
  {
    tag: 'kc_auto',
    severity: 2,
    flags: { kc_required: true },
    match: ['차량용', '자동차', '차량 거치대', '핸들커버', '카매트', '하이패스', '블랙박스', '내비게이션'],
  },
  // 라이터 / 가스 / 압력용기 (KGS / 위험물)
  {
    tag: 'kgs_pressure',
    severity: 3,
    flags: { kc_required: true },
    match: ['가스', '라이터', '압력', '에어건', '에어컴프레서', '소화기', '부탄', '캠핑가스'],
  },
  // 농약 / 살충제
  {
    tag: 'pesticide',
    severity: 3,
    flags: { mfds_required: true },
    match: ['살충제', '농약', '제초제', '살균제', '구충제', '벌레퇴치'],
  },
  // 의류 (KC 가정용 섬유)
  {
    tag: 'kc_textile',
    severity: 1,
    flags: { kc_required: true },
    match: ['속옷', '내의', '아동 의류', '유아복', '잠옷'],
  },
]

function applyRules(name) {
  const text = (name || '').toLowerCase()
  const matched = []
  let severity = 0
  const flags = {
    kc_required: false,
    kc_children: false,
    mfds_required: false,
    food_related: false,
    cosmetic: false,
    electric: false,
    battery: false,
  }
  const matchedKeywords = []
  for (const rule of RULES) {
    for (const kw of rule.match) {
      const k = kw.toLowerCase()
      if (text.includes(k)) {
        matched.push(rule.tag)
        matchedKeywords.push(kw)
        if (rule.severity > severity) severity = rule.severity
        for (const [f, v] of Object.entries(rule.flags)) {
          if (v) flags[f] = true
        }
        break
      }
    }
  }
  return {
    risk_tags: [...new Set(matched)],
    severity,
    flags,
    matched_keywords: [...new Set(matchedKeywords)],
  }
}

function buildSummary(tags, severity) {
  if (severity === 0) return '규제 리스크 신호 없음'
  const labels = {
    kc_electronics: 'KC 전기용품',
    kc_radio: 'KC 전파인증',
    battery_lithium: '리튬 배터리(운송 제한)',
    kc_usb_cable: 'KC 충전케이블',
    children_product: '어린이제품 KC',
    mfds_food: '식약처 식품 신고',
    cosmetic: '화장품법 신고',
    mfds_quasi_drug: '의약외품/의료기기',
    mfds_prescription: '처방의약품(판매 불가 가능)',
    food_contact: '식품용기 안전',
    kc_auto: '자동차 부품 인증',
    kgs_pressure: '가스/압력용기',
    pesticide: '농약/살충제 등록',
    kc_textile: 'KC 가정용 섬유',
  }
  const txt = tags.slice(0, 3).map((t) => labels[t] ?? t).join(' + ')
  if (severity >= 3) return `${txt} — 위탁 진입 비추천`
  if (severity >= 2) return `${txt} — 인증 필수, 진입 신중`
  return `${txt} — 사전 점검 권장`
}

// ─────────────────────────────────────────────────────────────
// HS 코드 추정 (룰 기반 단순 매핑 — 정확도는 LLM 보완용)
// ─────────────────────────────────────────────────────────────
function guessHsCode(name, tags) {
  const t = (name || '').toLowerCase()
  if (tags.includes('mfds_food')) {
    if (t.includes('홍삼') || t.includes('비타민') || t.includes('오메가')) return '2106909099'
    return '2106909099'
  }
  if (tags.includes('cosmetic')) {
    if (t.includes('립')) return '3304100000'
    if (t.includes('샴푸')) return '3305100000'
    return '3304990000'
  }
  if (tags.includes('battery_lithium')) return '8507600000'
  if (tags.includes('kc_usb_cable')) return '8544429090'
  if (tags.includes('kc_electronics')) return '8516799000'
  if (tags.includes('kc_radio')) return '8517620000'
  if (tags.includes('children_product')) return '9503009000'
  if (tags.includes('kc_textile')) return '6109100000'
  if (tags.includes('mfds_quasi_drug')) return '3005909000'
  return null
}

// ─────────────────────────────────────────────────────────────
// Claude CLI 호출 (LLM 검수)
// ─────────────────────────────────────────────────────────────
function callClaudeCli(prompt) {
  const childEnv = { ...process.env }
  delete childEnv.ANTHROPIC_API_KEY
  delete childEnv.ANTHROPIC_AUTH_TOKEN
  delete childEnv.ANTHROPIC_BASE_URL

  return new Promise((resolve, reject) => {
    const child = spawn('claude', ['-p', '--output-format', 'json'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
      env: childEnv,
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => (stdout += d.toString()))
    child.stderr.on('data', (d) => (stderr += d.toString()))
    child.on('error', reject)
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`claude exit=${code}: ${stderr.slice(0, 400)}`))
      try {
        const parsed = JSON.parse(stdout)
        if (parsed.is_error) return reject(new Error(`claude is_error: ${parsed.result?.slice?.(0, 300)}`))
        resolve(typeof parsed.result === 'string' ? parsed.result : '')
      } catch {
        reject(new Error(`claude stdout not JSON: ${stdout.slice(0, 200)}`))
      }
    })
    child.stdin.end(prompt, 'utf8')
  })
}

const LLM_SYSTEM = `한국 위탁판매 규제 리스크 검수기. 입력 상품 리스트의 룰엔진 결과를 검토·정정해서 JSON 배열로만 응답.

❗ 절대 규칙: 응답 첫 글자 '[' 마지막 ']'. markdown/코드펜스/설명 금지.

각 항목 필드:
- id: 입력 그대로
- severity: 0(무관) | 1(경고) | 2(주의) | 3(고위험)
- risk_tags: string[] (룰엔진 태그 + 추가 가능)
- summary: 한국어 한 줄 (15~30자)
- hs_code_guess: 한국 HSK 10자리 string 또는 null

판단 기준:
- KC 전기·전파, 리튬 배터리, 어린이제품, 식약처(식품/화장품/의약외품/처방의약품) → 2~3
- 단순 생활용품·잡화 → 0~1
- 처방 성분(멜라토닌·CBD 등) → 무조건 3`

function tryParseJsonArray(text) {
  if (!text) return null
  try {
    const v = JSON.parse(text)
    if (Array.isArray(v)) return v
  } catch {}
  const a = text.indexOf('[')
  const b = text.lastIndexOf(']')
  if (a !== -1 && b > a) {
    try {
      const v = JSON.parse(text.slice(a, b + 1))
      if (Array.isArray(v)) return v
    } catch {}
  }
  return null
}

// ─────────────────────────────────────────────────────────────
// 메인
// ─────────────────────────────────────────────────────────────
async function fetchProducts() {
  const { data, error } = await sb
    .from('jimscanner_trends_products')
    .select('id, canonical_name, category_top, category_mid, brand')
    .order('updated_at', { ascending: false })
    .limit(FETCH_LIMIT)
  if (error) throw error
  return data ?? []
}

async function fetchExistingRegulations(ids) {
  if (ids.length === 0) return new Map()
  const { data } = await sb
    .from('jimscanner_trends_regulation')
    .select('product_id, source, severity, classified_at')
    .in('product_id', ids)
  return new Map((data ?? []).map((r) => [r.product_id, r]))
}

function buildRow(productId, ruleResult, source) {
  const tags = ruleResult.risk_tags
  const hs = guessHsCode(ruleResult.matched_name ?? '', tags)
  return {
    product_id: productId,
    risk_tags: tags,
    hs_code_guess: hs,
    kc_required: ruleResult.flags.kc_required,
    kc_children: ruleResult.flags.kc_children,
    mfds_required: ruleResult.flags.mfds_required,
    food_related: ruleResult.flags.food_related,
    cosmetic: ruleResult.flags.cosmetic,
    electric: ruleResult.flags.electric,
    battery: ruleResult.flags.battery,
    severity: ruleResult.severity,
    source,
    summary: buildSummary(tags, ruleResult.severity),
    rationale: { matched_keywords: ruleResult.matched_keywords ?? [] },
    classified_at: new Date().toISOString(),
  }
}

async function upsertRegulations(rows) {
  if (rows.length === 0) return
  const CHUNK = 100
  for (let i = 0; i < rows.length; i += CHUNK) {
    const slice = rows.slice(i, i + CHUNK)
    const { error } = await sb
      .from('jimscanner_trends_regulation')
      .upsert(slice, { onConflict: 'product_id' })
    if (error) {
      console.error(`  upsert chunk ${i} failed: ${error.message}`)
      throw error
    }
  }
}

async function llmReview(candidates) {
  if (candidates.length === 0) return []
  const updated = []
  let reqCount = 0

  for (let i = 0; i < candidates.length && reqCount < LLM_MAX_REQ_PER_RUN; i += LLM_BATCH_SIZE) {
    const batch = candidates.slice(i, i + LLM_BATCH_SIZE)
    const lines = batch.map((c) =>
      `- id="${c.product_id}" name="${c.name}" rule_severity=${c.severity} rule_tags=[${c.risk_tags.join(',')}]`,
    )
    const prompt = `${LLM_SYSTEM}\n\n---\n\n다음 ${batch.length}개 상품의 규제 리스크를 검수:\n\n${lines.join('\n')}`

    try {
      const out = await callClaudeCli(prompt)
      reqCount++
      const arr = tryParseJsonArray(out) ?? []
      const byId = new Map(arr.map((r) => [String(r.id), r]))
      for (const c of batch) {
        const r = byId.get(c.product_id)
        if (!r) continue
        const sev = Number.isFinite(r.severity) ? Math.max(0, Math.min(3, Math.round(r.severity))) : c.severity
        const tags = Array.isArray(r.risk_tags) ? r.risk_tags.filter((t) => typeof t === 'string').slice(0, 8) : c.risk_tags
        const summary = typeof r.summary === 'string' && r.summary.trim() ? r.summary.trim().slice(0, 80) : c.summary
        const hs = typeof r.hs_code_guess === 'string' && /^\d{6,10}$/.test(r.hs_code_guess) ? r.hs_code_guess : c.hs_code_guess
        updated.push({ ...c, severity: sev, risk_tags: tags, summary, hs_code_guess: hs, source: 'llm' })
      }
      console.log(`  llm batch ${reqCount}: ${batch.length} reviewed`)
    } catch (e) {
      console.error(`  llm batch ${reqCount + 1} failed: ${e instanceof Error ? e.message : e}`)
      break
    }
  }
  return updated
}

async function main() {
  const t0 = Date.now()
  console.log(`[${new Date().toISOString()}] classify-regulation start (rule-only=${RULE_ONLY})`)

  const products = await fetchProducts()
  if (products.length === 0) {
    console.log('  done: products 0')
    return
  }
  console.log(`  products: ${products.length}`)

  const existing = await fetchExistingRegulations(products.map((p) => p.id))

  // 1) 룰엔진 적용 (기존 row 가 없거나 source='rule' 인 것만 새로 갱신)
  const ruleRows = []
  const llmCandidates = []
  for (const p of products) {
    const text = [p.canonical_name, p.category_mid, p.brand].filter(Boolean).join(' ')
    const r = applyRules(text)
    r.matched_name = text
    const row = buildRow(p.id, r, 'rule')
    const ex = existing.get(p.id)
    // 기존이 'manual' 이면 건드리지 않음
    if (ex?.source === 'manual') continue
    // 기존이 'llm' 이고 severity 동일하면 그대로 두기
    if (ex?.source === 'llm' && ex.severity === r.severity && r.severity > 0) continue
    ruleRows.push(row)
    // severity ≥ 1 이면 LLM 검수 후보 (단, RULE_ONLY 면 건너뜀)
    if (!RULE_ONLY && r.severity >= 1) {
      llmCandidates.push({ ...row, name: p.canonical_name })
    }
  }

  console.log(`  rule rows: ${ruleRows.length}`)
  await upsertRegulations(ruleRows)

  // 2) LLM 검수 (severity≥1 후보 중 일부)
  if (!RULE_ONLY && llmCandidates.length > 0) {
    console.log(`  llm candidates: ${llmCandidates.length} (max ${LLM_MAX_REQ_PER_RUN * LLM_BATCH_SIZE})`)
    const llmRows = await llmReview(llmCandidates)
    if (llmRows.length > 0) {
      const sanitized = llmRows.map((r) => {
        const { name, ...rest } = r
        return rest
      })
      await upsertRegulations(sanitized)
      console.log(`  llm-applied: ${sanitized.length}`)
    }
  }

  console.log(
    `[${new Date().toISOString()}] done — rule=${ruleRows.length}, ${Date.now() - t0}ms`,
  )
}

main().catch((e) => {
  console.error(`[fatal] ${e instanceof Error ? e.message : e}`)
  process.exit(1)
})
