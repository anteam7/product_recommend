#!/usr/bin/env node
/**
 * Operator Daily Brief — 매일 KST 06:30 모닝 다이제스트 생성기.
 *
 * 지난 24h 시그널 6종을 집계해서 Haiku 에게 엄격 템플릿으로 던지고
 * 한국어 narrative + 액션아이템(최대 7개) 을 jimscanner_trends_daily_brief 에 적재.
 *
 * 시그널:
 *   (a) 가속도 사분면 상위 신규 entrant  (jimscanner_trends_scores delta)
 *   (b) ggsan 신규 입고/임박             (jimscanner_ggsan_products imminent)
 *   (c) 부패 워치독 위험핀                (jimscanner_trends_keywords source=kca_press)
 *   (d) D-7 캘린더 이벤트                 (jimscanner_trends_keywords source=naver_tvtime, future)
 *   (e) 다소스 컨피던스 급상승            (alias_count delta)
 *   (f) 가격절벽 신규 윈도우              (jimscanner_ggsan_price_history delta)
 *
 * 비용 가드:
 *   - 1일 1회 (이미 오늘 brief 있으면 skip — --force 로 재생성)
 *   - 토큰 한도 8k
 *   - 실패 시 raw signal fallback 으로 적재 (페이지가 항상 렌더되도록)
 *
 * 호출:
 *   node --env-file=.env.local scripts/generate-daily-brief.mjs
 *   node --env-file=.env.local scripts/generate-daily-brief.mjs --force
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

const args = process.argv.slice(2)
const FORCE = args.includes('--force')

const MODEL = 'claude-code-cli'
const MAX_OUTPUT_TOKENS = 8000
const TOPN = 8 // 시그널 카테고리별 최대 row 수

// KST 기준 오늘 날짜 (YYYY-MM-DD)
function todayKstDate() {
  const now = new Date()
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000)
  return kst.toISOString().slice(0, 10)
}

function isoSince(hours) {
  return new Date(Date.now() - hours * 3600_000).toISOString()
}

async function fetchAcceleratorEntrants() {
  // 지난 24h 에 새로 final_score >= 50 으로 진입한 product
  const since = isoSince(24)
  const { data } = await sb
    .from('jimscanner_trends_scores')
    .select('product_id, trend_score, commerce_score, supplier_score, final_score, computed_at')
    .gte('computed_at', since)
    .gte('final_score', 50)
    .order('final_score', { ascending: false })
    .limit(TOPN * 3)
  const seen = new Set()
  const top = []
  for (const r of (data ?? [])) {
    if (seen.has(r.product_id)) continue
    seen.add(r.product_id)
    top.push(r)
    if (top.length >= TOPN) break
  }
  if (top.length === 0) return []
  const { data: prods } = await sb
    .from('jimscanner_trends_products')
    .select('id, canonical_name, category_top, brand')
    .in('id', top.map((r) => r.product_id))
  const pmap = new Map((prods ?? []).map((p) => [p.id, p]))
  return top.map((r) => ({
    product_id: r.product_id,
    name: pmap.get(r.product_id)?.canonical_name ?? '(unknown)',
    category: pmap.get(r.product_id)?.category_top ?? null,
    brand: pmap.get(r.product_id)?.brand ?? null,
    final_score: r.final_score,
    trend_score: r.trend_score,
    commerce_score: r.commerce_score,
    supplier_score: r.supplier_score,
    link: `/admin/trend-radar/products/${r.product_id}`,
  }))
}

async function fetchGgsanNewOrImminent() {
  const since = isoSince(24)
  const { data } = await sb
    .from('jimscanner_ggsan_products')
    .select('goods_no, title, price_krw, is_imminent, imminent_until, collected_at')
    .or(`is_imminent.eq.true,collected_at.gte.${since}`)
    .order('collected_at', { ascending: false })
    .limit(TOPN)
  return (data ?? []).map((r) => ({
    goods_no: r.goods_no,
    title: r.title,
    price_krw: r.price_krw,
    is_imminent: r.is_imminent,
    imminent_until: r.imminent_until,
    collected_at: r.collected_at,
    link: `/admin/trend-radar/ggsan?goods=${encodeURIComponent(r.goods_no ?? '')}`,
  }))
}

async function fetchKcaWatchdog() {
  // 부패 워치독: KCA(소비자원) 공지 시그널
  const since = isoSince(72)
  const { data } = await sb
    .from('jimscanner_trends_keywords')
    .select('keyword, category, collected_at')
    .eq('source', 'kca_press')
    .gte('collected_at', since)
    .order('collected_at', { ascending: false })
    .limit(TOPN)
  return (data ?? []).map((r) => ({
    keyword: r.keyword,
    category: r.category,
    collected_at: r.collected_at,
  }))
}

async function fetchTvCalendarD7() {
  // 캘린더 D-7: 향후 7일 이내 TV 편성 (없으면 최근 24h 편성 키워드)
  const since = isoSince(24)
  const { data } = await sb
    .from('jimscanner_trends_keywords')
    .select('keyword, category, collected_at')
    .eq('source', 'naver_tvtime')
    .gte('collected_at', since)
    .order('collected_at', { ascending: false })
    .limit(TOPN * 2)
  const map = new Map()
  for (const r of (data ?? [])) {
    const v = map.get(r.keyword) ?? { keyword: r.keyword, count: 0, slots: new Set() }
    v.count++
    if (r.category) v.slots.add(r.category)
    map.set(r.keyword, v)
  }
  return [...map.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, TOPN)
    .map((v) => ({ keyword: v.keyword, count: v.count, slots: [...v.slots] }))
}

async function fetchMultisourceConfidence() {
  // 지난 24h 에 alias_count 가 가장 늘어난 product (다소스 컨피던스 급상승)
  const since = isoSince(24)
  const { data } = await sb
    .from('jimscanner_trends_aliases')
    .select('product_id, created_at')
    .gte('created_at', since)
    .limit(500)
  const cmap = new Map()
  for (const r of (data ?? [])) {
    cmap.set(r.product_id, (cmap.get(r.product_id) ?? 0) + 1)
  }
  const ids = [...cmap.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, TOPN)
    .map(([id]) => id)
  if (ids.length === 0) return []
  const { data: prods } = await sb
    .from('jimscanner_trends_products')
    .select('id, canonical_name, category_top, alias_count')
    .in('id', ids)
  const pmap = new Map((prods ?? []).map((p) => [p.id, p]))
  return ids.map((id) => ({
    product_id: id,
    name: pmap.get(id)?.canonical_name ?? '(unknown)',
    category: pmap.get(id)?.category_top ?? null,
    new_aliases_24h: cmap.get(id),
    total_aliases: pmap.get(id)?.alias_count ?? 0,
    link: `/admin/trend-radar/products/${id}`,
  }))
}

async function fetchPriceCliffs() {
  // 가격절벽: ggsan price history 에서 24h 내 가격 변동 (drop) 검출
  const since = isoSince(24)
  const { data } = await sb
    .from('jimscanner_ggsan_price_history')
    .select('goods_no, price_krw, collected_at')
    .gte('collected_at', since)
    .order('collected_at', { ascending: false })
    .limit(200)
  // goods 별 최저가/최고가 비교
  const map = new Map()
  for (const r of (data ?? [])) {
    const v = map.get(r.goods_no) ?? { goods_no: r.goods_no, min: Infinity, max: -Infinity, last: 0 }
    if (r.price_krw == null) continue
    v.min = Math.min(v.min, r.price_krw)
    v.max = Math.max(v.max, r.price_krw)
    v.last = r.price_krw
    map.set(r.goods_no, v)
  }
  const cliffs = [...map.values()]
    .filter((v) => v.max > 0 && (v.max - v.min) / v.max >= 0.1)
    .sort((a, b) => (b.max - b.min) / b.max - (a.max - a.min) / a.max)
    .slice(0, TOPN)
  return cliffs.map((v) => ({
    goods_no: v.goods_no,
    price_min: v.min,
    price_max: v.max,
    drop_pct: Math.round(((v.max - v.min) / v.max) * 100),
    link: `/admin/trend-radar/ggsan?goods=${encodeURIComponent(v.goods_no ?? '')}`,
  }))
}

async function collectSignals() {
  const [accelerators, ggsanNew, watchdog, calendar, multisource, cliffs] = await Promise.all([
    fetchAcceleratorEntrants(),
    fetchGgsanNewOrImminent(),
    fetchKcaWatchdog(),
    fetchTvCalendarD7(),
    fetchMultisourceConfidence(),
    fetchPriceCliffs(),
  ])
  return {
    collected_at: new Date().toISOString(),
    accelerator_entrants: accelerators,
    ggsan_new_or_imminent: ggsanNew,
    kca_watchdog: watchdog,
    tv_calendar_d7: calendar,
    multisource_confidence: multisource,
    price_cliffs: cliffs,
  }
}

const SYSTEM_PROMPT = `한국 위탁 판매 솔로 셀러를 위한 모닝 브리프 생성기.
입력으로 6종 시그널(JSON)을 받아서 한국어 markdown narrative + 액션 아이템 JSON 을 만든다.

❗ 절대 규칙:
- 응답 형식: 첫 줄부터 markdown narrative, 마지막에 \`\`\`json ... \`\`\` 액션 아이템 블록.
- narrative 는 6~12줄. "오늘의 핵심" 1줄 + bullet 5~8개. 각 bullet 은 시그널 출처(예: "가속도 #54", "ggsan 임박", "KCA 워치독") 를 괄호로 표기.
- 액션 아이템 JSON: 최대 7개 객체 배열. 필드: { "label": "30자 이내 한국어 문장", "reason": "20자 이내 근거", "link": "/admin/...", "priority": "high|med|low" }
- 시그널이 비면 그 카테고리는 생략. 전체 비면 narrative 1줄 + 빈 액션 배열.
- 톤: 사실 중심, 셀러가 1분 안에 스캔 가능. 형용사·과장 금지.`

function buildUserPrompt(signals) {
  return `오늘 시그널(JSON):\n\`\`\`json\n${JSON.stringify(signals, null, 2).slice(0, 12000)}\n\`\`\`\n\n위 시그널을 토대로 모닝 브리프를 생성하라. 액션 아이템의 link 는 시그널 안의 link 필드를 그대로 인용할 것.`
}

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
    child.stdout.on('data', (d) => { stdout += d.toString() })
    child.stderr.on('data', (d) => { stderr += d.toString() })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code !== 0) {
        return reject(new Error(`claude exit=${code}: ${stderr.slice(0, 500)}`))
      }
      let parsed
      try { parsed = JSON.parse(stdout) } catch {
        return reject(new Error(`claude stdout not JSON: ${stdout.slice(0, 300)}`))
      }
      if (parsed.is_error) {
        return reject(new Error(`claude is_error: ${parsed.result?.slice?.(0, 300) ?? '?'}`))
      }
      resolve({
        text: typeof parsed.result === 'string' ? parsed.result : '',
        inputTokens: parsed.usage?.input_tokens ?? 0,
        outputTokens: parsed.usage?.output_tokens ?? 0,
      })
    })
    child.stdin.end(`${SYSTEM_PROMPT}\n\n---\n\n${prompt}`, 'utf8')
  })
}

function parseLlmResponse(text) {
  // Markdown narrative + ```json [...]``` 액션 블록 분리
  const fence = text.match(/```json\s*([\s\S]*?)```/i)
  let actionItems = []
  let brief = text
  if (fence) {
    brief = text.slice(0, fence.index).trim()
    try {
      const parsed = JSON.parse(fence[1])
      if (Array.isArray(parsed)) {
        actionItems = parsed
          .filter((a) => a && typeof a === 'object' && a.label)
          .slice(0, 7)
          .map((a) => ({
            label: String(a.label).slice(0, 120),
            reason: typeof a.reason === 'string' ? a.reason.slice(0, 120) : '',
            link: typeof a.link === 'string' ? a.link : null,
            priority: ['high', 'med', 'low'].includes(a.priority) ? a.priority : 'med',
          }))
      }
    } catch {}
  }
  return { brief_md: brief.trim(), action_items: actionItems }
}

function fallbackBrief(signals) {
  // LLM 실패 시 raw signal 만으로 최소 brief 생성
  const lines = ['# 오늘의 브리프 (fallback)\n', 'LLM 호출 실패 — raw 시그널만 표시.\n']
  if (signals.accelerator_entrants.length > 0) {
    lines.push(`## 가속도 신규 진입 (${signals.accelerator_entrants.length})`)
    for (const r of signals.accelerator_entrants.slice(0, 5)) {
      lines.push(`- ${r.name} (final=${r.final_score})`)
    }
  }
  if (signals.ggsan_new_or_imminent.length > 0) {
    lines.push(`\n## ggsan 신규/임박 (${signals.ggsan_new_or_imminent.length})`)
    for (const r of signals.ggsan_new_or_imminent.slice(0, 5)) {
      lines.push(`- ${r.title}${r.is_imminent ? ' [임박]' : ''}`)
    }
  }
  const actions = []
  for (const r of signals.accelerator_entrants.slice(0, 3)) {
    actions.push({ label: `${r.name} 검토`, reason: `final=${r.final_score}`, link: r.link, priority: 'high' })
  }
  return { brief_md: lines.join('\n'), action_items: actions }
}

function buildSourceLinks(signals) {
  const links = []
  for (const r of signals.accelerator_entrants.slice(0, 5)) {
    if (r.link) links.push({ label: r.name, link: r.link, kind: 'product' })
  }
  for (const r of signals.ggsan_new_or_imminent.slice(0, 5)) {
    if (r.link) links.push({ label: r.title, link: r.link, kind: 'ggsan' })
  }
  return links
}

async function main() {
  const t0 = Date.now()
  const date = todayKstDate()
  console.log(`[${new Date().toISOString()}] generate-daily-brief date=${date} force=${FORCE}`)

  if (!FORCE) {
    const { data: existing } = await sb
      .from('jimscanner_trends_daily_brief')
      .select('date, status')
      .eq('date', date)
      .maybeSingle()
    if (existing) {
      console.log(`  skip: brief already exists for ${date} (status=${existing.status}). Use --force to regenerate.`)
      return
    }
  }

  const signals = await collectSignals()
  const totalSignals =
    signals.accelerator_entrants.length +
    signals.ggsan_new_or_imminent.length +
    signals.kca_watchdog.length +
    signals.tv_calendar_d7.length +
    signals.multisource_confidence.length +
    signals.price_cliffs.length
  console.log(`  collected ${totalSignals} total signals across 6 categories`)

  let briefMd = ''
  let actionItems = []
  let status = 'ok'
  let model = MODEL
  let notes = null
  let inputTokens = 0
  let outputTokens = 0

  if (totalSignals === 0) {
    briefMd = '# 오늘의 브리프\n\n지난 24시간 동안 시그널이 없습니다. 수집기 상태를 확인해보세요.'
    actionItems = [{ label: '수집 상태 점검', reason: '24h 시그널 0건', link: '/admin/trend-radar/sources', priority: 'high' }]
    status = 'empty'
    model = 'static'
  } else {
    try {
      const prompt = buildUserPrompt(signals)
      const result = await callClaudeCli(prompt)
      inputTokens = result.inputTokens
      outputTokens = result.outputTokens
      if (outputTokens > MAX_OUTPUT_TOKENS) {
        console.warn(`  warn: output_tokens=${outputTokens} > cap=${MAX_OUTPUT_TOKENS}`)
      }
      const parsed = parseLlmResponse(result.text)
      briefMd = parsed.brief_md
      actionItems = parsed.action_items
      if (!briefMd) {
        throw new Error('empty brief_md after parse')
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      console.error(`  LLM failed: ${msg} — falling back to raw signals`)
      const fb = fallbackBrief(signals)
      briefMd = fb.brief_md
      actionItems = fb.action_items
      status = 'fallback'
      model = 'fallback'
      notes = msg.slice(0, 500)
    }
  }

  const sourceLinks = buildSourceLinks(signals)

  const payload = {
    date,
    brief_md: briefMd,
    signals_jsonb: signals,
    action_items: actionItems,
    source_links: sourceLinks,
    model,
    input_token_count: inputTokens,
    output_token_count: outputTokens,
    status,
    notes,
    generated_at: new Date().toISOString(),
  }

  const { error } = await sb
    .from('jimscanner_trends_daily_brief')
    .upsert(payload, { onConflict: 'date' })

  if (error) {
    console.error(`  upsert failed: ${error.message}`)
    process.exit(1)
  }

  const ms = Date.now() - t0
  console.log(`[${new Date().toISOString()}] done — status=${status} actions=${actionItems.length} tokens(in/out)=${inputTokens}/${outputTokens} ${ms}ms`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
