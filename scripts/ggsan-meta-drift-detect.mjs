#!/usr/bin/env node
/**
 * ggsan 메타 드리프트 감지기.
 *
 * 입력: 직전 스냅샷(jimscanner_ggsan_products 의 row) + 신규 스냅샷(detail-dump 결과)
 * 출력: 0..N 개의 drift 이벤트 → jimscanner_ggsan_meta_drift 적재.
 *
 * 호출 위치: scripts/ggsan-detail-dump.mjs 후속 단계.
 *   import { detectAndPersistDrift } from './ggsan-meta-drift-detect.mjs'
 *   await detectAndPersistDrift(supabase, prevRow, nextRow)
 *
 * Severity 룰:
 *   - image_url, brand 변경                                → HIGH
 *   - title  jaccard < 0.6 (or embed-cos < 0.85 후속)       → MID
 *   - options 추가/삭제 (raw_payload.options 길이 변화)      → MID
 *   - cate_cd 변경                                          → MID
 *   - 그 외 (price_text, status 등 비치명)                   → LOW
 */

const TRACKED_ATTRS = ['title', 'image_url', 'cate_cd', 'brand']

function tokenize(s) {
  if (!s) return []
  return String(s)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)
}

export function titleJaccard(a, b) {
  const A = new Set(tokenize(a))
  const B = new Set(tokenize(b))
  if (A.size === 0 && B.size === 0) return 1
  let inter = 0
  for (const t of A) if (B.has(t)) inter += 1
  const union = A.size + B.size - inter
  if (union === 0) return 1
  return inter / union
}

function optionsKey(raw) {
  if (!raw || typeof raw !== 'object') return ''
  const opts = raw.options ?? raw.option_list ?? raw.opt ?? null
  if (!opts) return ''
  if (Array.isArray(opts)) {
    return opts
      .map((o) => (typeof o === 'string' ? o : JSON.stringify(o)))
      .sort()
      .join('|')
  }
  return JSON.stringify(opts)
}

export function diffSnapshot(prev, next) {
  const events = []
  if (!prev) return events

  for (const attr of TRACKED_ATTRS) {
    const oldV = prev[attr] ?? null
    const newV = next[attr] ?? null
    if (oldV === newV) continue
    if (oldV == null && newV == null) continue

    let severity = 'LOW'
    let similarity = null
    let reason = `${attr} changed`

    if (attr === 'image_url' || attr === 'brand') {
      severity = 'HIGH'
      reason = `${attr} 변경 — 쿠팡 등록 SKU 정합성 위험`
    } else if (attr === 'title') {
      similarity = titleJaccard(oldV, newV)
      if (similarity < 0.6) {
        severity = 'MID'
        reason = `title jaccard=${similarity.toFixed(2)} (의미 변화 가능성)`
      } else {
        severity = 'LOW'
        reason = `title jaccard=${similarity.toFixed(2)} (사소 변경)`
      }
    } else if (attr === 'cate_cd') {
      severity = 'MID'
      reason = `cate_cd ${oldV} → ${newV}`
    }

    events.push({
      attr,
      old_value: oldV == null ? null : String(oldV),
      new_value: newV == null ? null : String(newV),
      severity,
      similarity,
      reason,
    })
  }

  // options 변경
  const oldOpts = optionsKey(prev.raw_payload)
  const newOpts = optionsKey(next.raw_payload)
  if (oldOpts !== newOpts && (oldOpts || newOpts)) {
    events.push({
      attr: 'options',
      old_value: oldOpts ? oldOpts.slice(0, 500) : null,
      new_value: newOpts ? newOpts.slice(0, 500) : null,
      severity: 'MID',
      similarity: null,
      reason: 'options 추가/삭제',
    })
  }

  return events
}

export async function detectAndPersistDrift(supabase, prevRow, nextRow, opts = {}) {
  const events = diffSnapshot(prevRow, nextRow)
  if (events.length === 0) return { inserted: 0, events: [] }

  const rows = events.map((e) => ({
    goods_no: nextRow.goods_no,
    attr: e.attr,
    old_value: e.old_value,
    new_value: e.new_value,
    severity: e.severity,
    similarity: e.similarity,
    reason: e.reason,
    detected_by: opts.detectedBy ?? 'ggsan-detail-dump',
  }))

  const { error } = await supabase.from('jimscanner_ggsan_meta_drift').insert(rows)
  if (error) {
    console.error('[drift] insert error:', error.message)
    return { inserted: 0, events, error }
  }
  return { inserted: rows.length, events }
}

// CLI 자가 테스트
if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}`) {
  const prev = {
    goods_no: 'TEST',
    title: '비타민C 1000mg 60정',
    image_url: 'https://x.com/old.jpg',
    cate_cd: '009',
    brand: '닥터스베스트',
    raw_payload: { options: ['60정', '120정'] },
  }
  const next = {
    goods_no: 'TEST',
    title: '비타민D3 2000IU 90정',
    image_url: 'https://x.com/new.jpg',
    cate_cd: '009',
    brand: '닥터스베스트',
    raw_payload: { options: ['90정'] },
  }
  const events = diffSnapshot(prev, next)
  console.log('events:', JSON.stringify(events, null, 2))
}
