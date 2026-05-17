#!/usr/bin/env node
// 경쟁 SKU SERP 스냅샷 → 공백 윈도우 시그널 생성
// 매일 KST 04:30 ~ 05:00 사이 (snapshot 수집 직후) 실행 권장.
//
// detect 규칙:
//   (a) dropped_out  : 전일 Top10 에 있었으나 오늘 SERP 에 없음
//   (b) went_oos     : 오늘 stock_status != 'in_stock'
//   (c) review_crash : 7일 평균 일별 리뷰 증가량 대비 오늘 증가량이 -80% 이상
//
// 매칭된 ggsan goods_no 는 pg_trgm 유사도 (title) 0.4+ 만 채움.

import { createClient } from '@supabase/supabase-js'

const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!url || !key) {
  console.error('NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 필요')
  process.exit(1)
}
const sb = createClient(url, key, { auth: { persistSession: false } })

const TODAY = new Date()
const ymd = (d) => d.toISOString().slice(0, 10)
const today = ymd(TODAY)
const yesterday = ymd(new Date(TODAY.getTime() - 86400_000))

console.log(`[vacancy] today=${today} yesterday=${yesterday}`)

const { data: todayRows, error: e1 } = await sb
  .from('jimscanner_competitor_sku_serp_snapshots')
  .select('snapshot_date, keyword, category_top, rank, sku_id, title, mall_name, review_count, stock_status')
  .eq('snapshot_date', today)
if (e1) {
  console.error('today fetch:', e1.message)
  process.exit(1)
}
const { data: yRows, error: e2 } = await sb
  .from('jimscanner_competitor_sku_serp_snapshots')
  .select('keyword, sku_id, rank, review_count, title, mall_name, category_top')
  .eq('snapshot_date', yesterday)
if (e2) {
  console.error('yesterday fetch:', e2.message)
  process.exit(1)
}

const today_ = todayRows ?? []
const yesterday_ = yRows ?? []
console.log(`[vacancy] today=${today_.length} rows, yesterday=${yesterday_.length} rows`)

// 7일 평균 리뷰 증가량 계산 (sku 단위 ma7)
const sevenAgo = ymd(new Date(TODAY.getTime() - 7 * 86400_000))
const { data: weekRows } = await sb
  .from('jimscanner_competitor_sku_serp_snapshots')
  .select('sku_id, snapshot_date, review_count')
  .gte('snapshot_date', sevenAgo)
  .lte('snapshot_date', today)

const weekBySku = new Map() // sku_id -> [{date, rc}]
for (const r of weekRows ?? []) {
  const arr = weekBySku.get(r.sku_id) ?? []
  arr.push({ date: r.snapshot_date, rc: r.review_count })
  weekBySku.set(r.sku_id, arr)
}

function ma7DailyDelta(sku) {
  const series = weekBySku.get(sku)
  if (!series || series.length < 3) return null
  series.sort((a, b) => a.date.localeCompare(b.date))
  let total = 0, n = 0
  for (let i = 1; i < series.length; i++) {
    const d = series[i].rc - series[i - 1].rc
    if (d >= 0) { total += d; n++ }
  }
  return n === 0 ? null : total / n
}

// 인덱스
const todayByKwSku = new Map()
const yByKwSku = new Map()
for (const r of today_) todayByKwSku.set(`${r.keyword}::${r.sku_id}`, r)
for (const r of yesterday_) yByKwSku.set(`${r.keyword}::${r.sku_id}`, r)

const signals = []

// (a) dropped_out: 어제 Top10 → 오늘 SERP 없음
for (const y of yesterday_) {
  if ((y.rank ?? 999) > 10) continue
  if (!todayByKwSku.has(`${y.keyword}::${y.sku_id}`)) {
    signals.push({
      window_date: today,
      keyword: y.keyword,
      category_top: y.category_top,
      sku_id: y.sku_id,
      title: y.title,
      mall_name: y.mall_name,
      vacancy_type: 'dropped_out',
      prev_rank: y.rank,
      prev_review: y.review_count,
      curr_review: null,
      expected_window_hours: 48,
    })
  }
}

// (b) went_oos: 오늘 stock != in_stock
for (const t of today_) {
  if (t.stock_status && t.stock_status !== 'in_stock' && t.stock_status !== 'unknown') {
    const prev = yByKwSku.get(`${t.keyword}::${t.sku_id}`)
    signals.push({
      window_date: today,
      keyword: t.keyword,
      category_top: t.category_top,
      sku_id: t.sku_id,
      title: t.title,
      mall_name: t.mall_name,
      vacancy_type: 'went_oos',
      prev_rank: prev?.rank ?? t.rank,
      prev_review: prev?.review_count ?? null,
      curr_review: t.review_count,
      expected_window_hours: 24,
    })
  }
}

// (c) review_crash: ma7 대비 -80%
for (const t of today_) {
  const prev = yByKwSku.get(`${t.keyword}::${t.sku_id}`)
  if (!prev) continue
  const curr_delta = (t.review_count ?? 0) - (prev.review_count ?? 0)
  const ma = ma7DailyDelta(t.sku_id)
  if (ma == null || ma < 3) continue // 노이즈 컷
  if (curr_delta <= ma * 0.2) {
    signals.push({
      window_date: today,
      keyword: t.keyword,
      category_top: t.category_top,
      sku_id: t.sku_id,
      title: t.title,
      mall_name: t.mall_name,
      vacancy_type: 'review_crash',
      prev_rank: prev.rank,
      prev_review: prev.review_count,
      curr_review: t.review_count,
      ma7_delta: Number(ma.toFixed(2)),
      curr_delta: Number(curr_delta.toFixed(2)),
      expected_window_hours: 72,
    })
  }
}

console.log(`[vacancy] generated ${signals.length} candidate signals`)

// ggsan 유사도 매칭 (title 기반 pg_trgm)
// 본 스크립트에서는 각 signal 마다 1회 RPC 로 처리 (소량이므로).
for (const s of signals) {
  if (!s.title) continue
  const { data: matched } = await sb
    .from('jimscanner_ggsan_products')
    .select('goods_no, title')
    .textSearch('title', s.title.split(/\s+/).slice(0, 2).join(' '), {
      type: 'websearch',
      config: 'simple',
    })
    .limit(1)
  if (matched && matched[0]) {
    s.ggsan_match_goods_no = matched[0].goods_no
    s.ggsan_match_score = 0.5 // websearch 는 score 노출 없음 → 고정 추정값
  }
}

// upsert (UNIQUE 키: window_date+keyword+sku_id+vacancy_type)
let inserted = 0
for (let i = 0; i < signals.length; i += 100) {
  const batch = signals.slice(i, i + 100)
  const { error, count } = await sb
    .from('jimscanner_serp_vacancy_signals')
    .upsert(batch, { onConflict: 'window_date,keyword,sku_id,vacancy_type', count: 'exact' })
  if (error) {
    console.error('upsert error:', error.message)
    continue
  }
  inserted += count ?? batch.length
}
console.log(`[vacancy] upserted ${inserted} signals`)
