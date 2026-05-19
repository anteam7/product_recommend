#!/usr/bin/env node
/**
 * 리젝 학습 필터 — 로지스틱 회귀 학습 스크립트.
 *
 * 흐름:
 *  1) jimscanner_trends_reject_labels 에서 (product_id, decision) 라벨 로드
 *     - reject/hide → y=1, approve → y=0
 *  2) 각 product 의 피처 벡터 추출 — products + aliases + latest score + ggsan 매칭
 *  3) 표준화 후 SGD 로지스틱 회귀 학습 (L2 정규화, 200 epoch)
 *  4) jimscanner_trends_reject_model_runs 에 메타+계수 insert + is_active=true
 *  5) 활성 모델로 전체 product 의 jimscanner_trends_scores.reject_prob 갱신 (latest row 만)
 *
 * 실행:
 *   node scripts/train-reject-model.mjs
 *   node scripts/train-reject-model.mjs --shadow   (UI 디스카운트 X, 점수만 기록)
 *   node scripts/train-reject-model.mjs --threshold 0.7
 *
 * cron: 일 1회 (KST 03:30 권장).
 */

import { createClient } from '@supabase/supabase-js'

const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!url || !key) {
  console.error('NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY 필요')
  process.exit(1)
}

const args = process.argv.slice(2)
let isShadow = false
let threshold = 0.6
let minSamples = 20
for (let i = 0; i < args.length; i++) {
  const a = args[i]
  if (a === '--shadow') isShadow = true
  else if (a === '--threshold') threshold = parseFloat(args[++i])
  else if (a === '--min-samples') minSamples = parseInt(args[++i], 10)
}

const sb = createClient(url, key, { auth: { persistSession: false } })

// ─── 1) 라벨 로드 ───────────────────────────────────────────
const { data: labels, error: labelErr } = await sb
  .from('jimscanner_trends_reject_labels')
  .select('product_id, decision, created_at')
  .order('created_at', { ascending: false })

if (labelErr) {
  console.error('label load error:', labelErr.message)
  process.exit(1)
}

// product_id 별 최신 결정만 (중복 라벨 방지)
const labelMap = new Map()
for (const l of labels ?? []) {
  if (!labelMap.has(l.product_id)) labelMap.set(l.product_id, l.decision)
}
const positives = []
const negatives = []
for (const [pid, d] of labelMap.entries()) {
  if (d === 'reject' || d === 'hide') positives.push(pid)
  else if (d === 'approve') negatives.push(pid)
}
console.log(`라벨: positive(reject)=${positives.length}, negative(approve)=${negatives.length}`)

if (positives.length + negatives.length < minSamples) {
  console.log(`샘플 부족 (< ${minSamples}). 학습 건너뜀.`)
  process.exit(0)
}

// ─── 2) 피처 추출 ───────────────────────────────────────────
const allLabeledIds = [...positives, ...negatives]

const { data: products } = await sb
  .from('jimscanner_trends_products')
  .select('id, category_top, alias_count, llm_classified_at')
  .in('id', allLabeledIds)

const { data: latestScores } = await sb
  .from('jimscanner_trends_scores')
  .select('product_id, trend_score, commerce_score, supplier_score, competition_score, final_score, computed_at, score_components')
  .in('product_id', allLabeledIds)
  .order('computed_at', { ascending: false })

const scoreByProd = new Map()
for (const s of latestScores ?? []) {
  if (!scoreByProd.has(s.product_id)) scoreByProd.set(s.product_id, s)
}

const prodById = new Map((products ?? []).map((p) => [p.id, p]))

// 카테고리 one-hot 차원 (health/living/digital)
const CATS = ['health', 'living', 'digital']

function featurize(pid) {
  const p = prodById.get(pid) ?? {}
  const s = scoreByProd.get(pid) ?? {}
  const comp = s.score_components ?? {}
  const tvPush = Number(comp?.commerce?.tv_push ?? 0)
  const serpAd = Number(comp?.competition?.serp_ad_share ?? 0)
  const sourceDiversity = Number(comp?.trend?.source_consensus ?? 0)
  return [
    Number(p.alias_count ?? 0),
    p.llm_classified_at ? 1 : 0,
    Number(s.trend_score ?? 0),
    Number(s.commerce_score ?? 0),
    Number(s.supplier_score ?? 0),
    Number(s.competition_score ?? 0),
    Number(s.final_score ?? 0),
    tvPush,
    serpAd,
    sourceDiversity,
    ...CATS.map((c) => (p.category_top === c ? 1 : 0)),
  ]
}

const FEATURE_NAMES = [
  'alias_count',
  'llm_classified',
  'trend_score',
  'commerce_score',
  'supplier_score',
  'competition_score',
  'final_score',
  'tv_push',
  'serp_ad_share',
  'source_diversity',
  ...CATS.map((c) => `cat_${c}`),
]

const X = []
const Y = []
for (const pid of positives) { X.push(featurize(pid)); Y.push(1) }
for (const pid of negatives) { X.push(featurize(pid)); Y.push(0) }

// ─── 3) 표준화 + 로지스틱 회귀 (SGD, L2) ─────────────────────
const D = FEATURE_NAMES.length
const N = X.length
const means = new Array(D).fill(0)
const stds = new Array(D).fill(1)
for (let d = 0; d < D; d++) {
  let sum = 0
  for (let i = 0; i < N; i++) sum += X[i][d]
  means[d] = sum / N
  let sq = 0
  for (let i = 0; i < N; i++) { const v = X[i][d] - means[d]; sq += v * v }
  stds[d] = Math.sqrt(sq / N) || 1
}
const Xn = X.map((row) => row.map((v, d) => (v - means[d]) / stds[d]))

function sigmoid(z) { return 1 / (1 + Math.exp(-z)) }

let w = new Array(D).fill(0)
let b = 0
const lr = 0.05
const lambda = 0.01
const epochs = 200

// 학습/검증 80/20 split (셔플 후)
const idx = [...Array(N).keys()]
for (let i = idx.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [idx[i], idx[j]] = [idx[j], idx[i]] }
const cut = Math.max(1, Math.floor(N * 0.8))
const trainIdx = idx.slice(0, cut)
const valIdx = idx.slice(cut)

let finalLoss = 0
for (let ep = 0; ep < epochs; ep++) {
  let loss = 0
  for (const i of trainIdx) {
    const xi = Xn[i]; const yi = Y[i]
    let z = b
    for (let d = 0; d < D; d++) z += w[d] * xi[d]
    const p = sigmoid(z)
    const err = p - yi
    loss += -(yi * Math.log(p + 1e-9) + (1 - yi) * Math.log(1 - p + 1e-9))
    for (let d = 0; d < D; d++) {
      w[d] -= lr * (err * xi[d] + lambda * w[d])
    }
    b -= lr * err
  }
  finalLoss = loss / trainIdx.length
}

// 검증 AUC (간이): val 셋의 평균 confidence
let valAuc = null
if (valIdx.length >= 2) {
  const preds = valIdx.map((i) => {
    let z = b; for (let d = 0; d < D; d++) z += w[d] * Xn[i][d]
    return { p: sigmoid(z), y: Y[i] }
  })
  // AUC 단순 계산 (모든 (pos, neg) 쌍 비교)
  const pos = preds.filter((p) => p.y === 1)
  const neg = preds.filter((p) => p.y === 0)
  if (pos.length > 0 && neg.length > 0) {
    let wins = 0; let ties = 0
    for (const a of pos) for (const c of neg) {
      if (a.p > c.p) wins++
      else if (a.p === c.p) ties++
    }
    valAuc = (wins + 0.5 * ties) / (pos.length * neg.length)
  }
}

console.log(`학습 완료: loss=${finalLoss.toFixed(4)} val_auc=${valAuc?.toFixed(3) ?? 'n/a'} epochs=${epochs}`)

// ─── 4) model_runs insert + 활성화 ───────────────────────────
await sb.from('jimscanner_trends_reject_model_runs').update({ is_active: false }).eq('is_active', true)

const { data: inserted, error: insErr } = await sb
  .from('jimscanner_trends_reject_model_runs')
  .insert({
    algorithm: 'logistic_regression',
    n_samples: N,
    n_positive: positives.length,
    n_negative: negatives.length,
    intercept: b,
    feature_names: FEATURE_NAMES,
    coefficients: w,
    feature_means: means,
    feature_stds: stds,
    train_loss: finalLoss,
    val_auc: valAuc,
    threshold,
    is_shadow_mode: isShadow,
    is_active: true,
    notes: `SGD lr=${lr} l2=${lambda} epochs=${epochs}`,
  })
  .select('id')
  .single()

if (insErr) {
  console.error('model_runs insert error:', insErr.message)
  process.exit(1)
}
console.log(`model_run id=${inserted.id} is_active=true shadow=${isShadow}`)

// ─── 5) 전체 product 의 latest score row 에 reject_prob 갱신 ──
const { data: allLatest } = await sb
  .from('jimscanner_trends_scores')
  .select('id, product_id, computed_at, score_components')
  .order('computed_at', { ascending: false })
  .limit(5000)

const seen = new Set()
const latestScoreRows = []
for (const s of allLatest ?? []) {
  if (seen.has(s.product_id)) continue
  seen.add(s.product_id)
  latestScoreRows.push(s)
}

const { data: allProducts } = await sb
  .from('jimscanner_trends_products')
  .select('id, category_top, alias_count, llm_classified_at')
  .in('id', latestScoreRows.map((s) => s.product_id))
const allProdById = new Map((allProducts ?? []).map((p) => [p.id, p]))

function predict(pid, sRow) {
  const p = allProdById.get(pid) ?? {}
  const s = sRow ?? {}
  const comp = s.score_components ?? {}
  const tvPush = Number(comp?.commerce?.tv_push ?? 0)
  const serpAd = Number(comp?.competition?.serp_ad_share ?? 0)
  const sourceDiversity = Number(comp?.trend?.source_consensus ?? 0)
  const feats = [
    Number(p.alias_count ?? 0),
    p.llm_classified_at ? 1 : 0,
    Number(s.trend_score ?? 0),
    Number(s.commerce_score ?? 0),
    Number(s.supplier_score ?? 0),
    Number(s.competition_score ?? 0),
    Number(s.final_score ?? 0),
    tvPush,
    serpAd,
    sourceDiversity,
    ...CATS.map((c) => (p.category_top === c ? 1 : 0)),
  ]
  let z = b
  for (let d = 0; d < D; d++) z += w[d] * ((feats[d] - means[d]) / stds[d])
  return sigmoid(z)
}

let updated = 0
for (const row of latestScoreRows) {
  const prob = predict(row.product_id, row)
  const { error } = await sb
    .from('jimscanner_trends_scores')
    .update({ reject_prob: Math.max(0, Math.min(1, prob)) })
    .eq('id', row.id)
  if (!error) updated++
}
console.log(`reject_prob 갱신: ${updated}/${latestScoreRows.length} score row`)
console.log('완료.')
