#!/usr/bin/env node
/**
 * 컴플라이언스 게이트 스캐너.
 *
 * 한국 규제 사전(jimscanner_compliance_rules)을 로드한 뒤
 * 핀·ggsan 상품·trend product·trend keyword 의 title/description/keyword
 * 를 banned_phrases 로 스캔해서 jimscanner_compliance_findings 에 적재한다.
 *
 * 사용법:
 *   node --env-file=.env.local scripts/check-compliance.mjs            # 전체 스캔
 *   node --env-file=.env.local scripts/check-compliance.mjs --kind=pin # 특정 타겟만
 *
 * 멱등: 같은 (target_kind, target_id, rule_id, matched_text) 는 UNIQUE 로
 * 중복 INSERT 방지. 해제(resolved_at NOT NULL)된 finding 은 다시 잡히지 않도록
 * SELECT 로 가드한다.
 */

import { createClient } from '@supabase/supabase-js'

const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!url || !key) {
  console.error('SUPABASE env missing. Run with --env-file=.env.local')
  process.exit(1)
}

const sb = createClient(url, key, { auth: { persistSession: false } })

const args = process.argv.slice(2)
const kindArg = args.find((a) => a.startsWith('--kind='))?.split('=')[1]
const KINDS = kindArg
  ? [kindArg]
  : ['pin', 'ggsan_product', 'trend_product', 'trend_keyword']

const t0 = Date.now()

async function loadRules() {
  const { data, error } = await sb
    .from('jimscanner_compliance_rules')
    .select('rule_id, domain, rule_name, banned_phrases, action, severity')
    .eq('is_active', true)
  if (error) throw new Error(`rules load: ${error.message}`)
  return data ?? []
}

function scanText(text, rules) {
  const hits = []
  if (!text) return hits
  const lower = text.toLowerCase()
  for (const rule of rules) {
    for (const phrase of rule.banned_phrases ?? []) {
      if (!phrase) continue
      const p = phrase.toLowerCase()
      if (lower.includes(p)) {
        hits.push({ rule, matched_text: phrase })
      }
    }
  }
  return hits
}

async function fetchTargets(kind) {
  switch (kind) {
    case 'pin': {
      const { data } = await sb
        .from('jimscanner_trends_pins')
        .select('keyword, source, notes')
      return (data ?? []).map((r) => ({
        target_id: `${r.source}::${r.keyword}`,
        target_label: r.keyword,
        text: [r.keyword, r.notes].filter(Boolean).join(' '),
      }))
    }
    case 'ggsan_product': {
      const { data } = await sb
        .from('jimscanner_ggsan_products')
        .select('goods_no, title, cate_label')
        .order('last_changed_at', { ascending: false })
        .limit(2000)
      return (data ?? []).map((r) => ({
        target_id: r.goods_no,
        target_label: r.title,
        text: [r.title, r.cate_label].filter(Boolean).join(' '),
      }))
    }
    case 'trend_product': {
      const { data } = await sb
        .from('jimscanner_trends_products')
        .select('id, canonical_name, description, category_top, category_mid')
        .order('last_seen_at', { ascending: false })
        .limit(2000)
      return (data ?? []).map((r) => ({
        target_id: r.id,
        target_label: r.canonical_name,
        text: [r.canonical_name, r.description, r.category_mid].filter(Boolean).join(' '),
      }))
    }
    case 'trend_keyword': {
      const { data } = await sb
        .from('jimscanner_trends_keywords')
        .select('id, keyword, source, category, notes')
        .order('collected_at', { ascending: false })
        .limit(2000)
      return (data ?? []).map((r) => ({
        target_id: r.id,
        target_label: r.keyword,
        text: [r.keyword, r.category, r.notes].filter(Boolean).join(' '),
      }))
    }
  }
  return []
}

async function fetchExistingResolved(kind) {
  // 해제된 finding 의 (target_id, rule_id, matched_text) 를 집합으로 만들어
  // 다시 INSERT 하지 않도록 가드.
  const { data } = await sb
    .from('jimscanner_compliance_findings')
    .select('target_id, rule_id, matched_text')
    .eq('target_kind', kind)
    .not('resolved_at', 'is', null)
  const set = new Set()
  for (const r of data ?? []) {
    set.add(`${r.target_id}|${r.rule_id}|${r.matched_text}`)
  }
  return set
}

let totalScanned = 0
let totalNewFindings = 0

const rules = await loadRules()
console.log(`[compliance] ${rules.length} active rules loaded`)

for (const kind of KINDS) {
  const targets = await fetchTargets(kind)
  const resolved = await fetchExistingResolved(kind)

  const rows = []
  for (const t of targets) {
    const hits = scanText(t.text, rules)
    for (const h of hits) {
      const dedupKey = `${t.target_id}|${h.rule.rule_id}|${h.matched_text}`
      if (resolved.has(dedupKey)) continue
      rows.push({
        target_kind: kind,
        target_id: t.target_id,
        target_label: t.target_label?.slice(0, 200) ?? null,
        rule_id: h.rule.rule_id,
        matched_text: h.matched_text,
        severity: h.rule.severity,
        action: h.rule.action,
      })
    }
  }
  totalScanned += targets.length

  if (rows.length === 0) {
    console.log(`  ${kind}: scanned=${targets.length}, hits=0`)
    continue
  }

  // upsert 로 멱등 처리 (UNIQUE 제약 충돌 시 무시)
  const { error, count } = await sb
    .from('jimscanner_compliance_findings')
    .upsert(rows, {
      onConflict: 'target_kind,target_id,rule_id,matched_text',
      ignoreDuplicates: true,
      count: 'exact',
    })
  if (error) {
    console.error(`  ${kind}: upsert error: ${error.message}`)
    continue
  }
  totalNewFindings += count ?? rows.length
  console.log(`  ${kind}: scanned=${targets.length}, hits=${rows.length}, new=${count ?? '?'}`)
}

const elapsed = Date.now() - t0
console.log(
  `[compliance] done — scanned=${totalScanned}, new findings=${totalNewFindings}, ${elapsed}ms`,
)
process.exit(0)
