import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * 발굴 트리거 룰 엔진.
 *
 * recompute_scores cron 직후 호출되어, 직전 스냅샷과 현재 스냅샷을 비교해
 * 룰을 충족하는 product 를 jimscanner_trends_alerts 에 fired 로 기록한다.
 *
 * DB 스키마: supabase/trends_v5_alert_rules.sql
 * (마이그레이션 후 상태 가정 — 타입 미생성이라 `as any` 캐스팅 사용)
 *
 * 설계 원칙
 *  - 멱등: dedup_key 로 같은 (rule, product, 스냅샷) 중복 발화 차단.
 *  - 확장: condition.type 별 핸들러 맵. 신규 룰 타입은 핸들러만 추가하면 됨.
 *  - 채널: 'instant' 는 즉시 deliver, 'digest' 는 미전송으로 쌓아두고
 *    별도 digest 패스(또는 운영자 피드)에서 처리.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Admin = SupabaseClient<any, any, any>

interface AlertRule {
  id: string
  name: string
  condition: Record<string, unknown>
  category_top: string | null
  channel: string
  enabled: boolean
}

interface ScoreRow {
  product_id: string
  trend_score: number
  commerce_score: number
  supplier_score: number
  competition_score: number
  final_score: number
  computed_at: string
}

interface FiredAlert {
  rule_id: string
  product_id: string
  product_name: string | null
  category_top: string | null
  trigger_value: number | null
  message: string
  payload: Record<string, unknown>
  dedup_key: string
  channel: string
  delivered: boolean
  delivered_at: string | null
}

export interface EvaluateResult {
  status: 'ok' | 'partial' | 'error'
  rules_evaluated: number
  products_scanned: number
  fired: number
  delivered: number
  error?: string
}

const METRIC_KEYS = [
  'trend_score',
  'commerce_score',
  'supplier_score',
  'competition_score',
  'final_score',
] as const

type MetricKey = (typeof METRIC_KEYS)[number]

function isMetric(m: unknown): m is MetricKey {
  return typeof m === 'string' && (METRIC_KEYS as readonly string[]).includes(m)
}

/** product_id 별 최신 2개 스냅샷 ([latest, prev]) 를 모은다. */
function groupLatestTwo(rows: ScoreRow[]): Map<string, ScoreRow[]> {
  const byProduct = new Map<string, ScoreRow[]>()
  // rows 는 computed_at desc 정렬 가정
  for (const r of rows) {
    const arr = byProduct.get(r.product_id)
    if (!arr) byProduct.set(r.product_id, [r])
    else if (arr.length < 2) arr.push(r)
  }
  return byProduct
}

export async function evaluateAlerts(admin: Admin): Promise<EvaluateResult> {
  try {
    // 1) 활성 룰 로드
    const { data: ruleData, error: ruleErr } = await admin
      .from('jimscanner_trends_alert_rules')
      .select('id, name, condition, category_top, channel, enabled')
      .eq('enabled', true)
    if (ruleErr) throw ruleErr
    const rules = (ruleData ?? []) as AlertRule[]
    if (rules.length === 0) {
      return { status: 'ok', rules_evaluated: 0, products_scanned: 0, fired: 0, delivered: 0 }
    }

    // 2) 최근 score 스냅샷 로드 (product 별 최신 2개를 만들기 위해 넉넉히)
    const { data: scoreData, error: scoreErr } = await admin
      .from('jimscanner_trends_scores')
      .select(
        'product_id, trend_score, commerce_score, supplier_score, competition_score, final_score, computed_at',
      )
      .order('computed_at', { ascending: false })
      .limit(6000)
    if (scoreErr) throw scoreErr
    const byProduct = groupLatestTwo((scoreData ?? []) as ScoreRow[])

    // 3) product 메타 (이름/카테고리)
    const productIds = [...byProduct.keys()]
    const nameById = new Map<string, { name: string; category: string }>()
    if (productIds.length > 0) {
      const { data: prods } = await admin
        .from('jimscanner_trends_products')
        .select('id, canonical_name, category_top')
        .in('id', productIds)
      for (const p of (prods ?? []) as { id: string; canonical_name: string; category_top: string }[]) {
        nameById.set(p.id, { name: p.canonical_name, category: p.category_top })
      }
    }

    // 4) 룰 평가 → 발화 후보 수집
    const candidates: FiredAlert[] = []
    for (const rule of rules) {
      for (const [pid, snaps] of byProduct) {
        const meta = nameById.get(pid)
        if (rule.category_top && meta && meta.category !== rule.category_top) continue
        const fired = evaluateRule(rule, snaps, meta)
        if (fired) candidates.push(fired)
      }
    }

    // 5) 멱등 insert (dedup_key UNIQUE — 중복은 무시)
    let firedCount = 0
    let deliveredCount = 0
    if (candidates.length > 0) {
      const { data: inserted, error: insErr } = await admin
        .from('jimscanner_trends_alerts')
        .upsert(candidates, { onConflict: 'dedup_key', ignoreDuplicates: true })
        .select('id, rule_id')
      if (insErr) throw insErr
      const insertedRows = (inserted ?? []) as { id: string; rule_id: string }[]
      firedCount = insertedRows.length
      deliveredCount = candidates.filter((c) => c.delivered).length

      // 6) 룰별 fired_count 증가 (자가 튜닝 노이즈 추적용)
      const perRule = new Map<string, number>()
      for (const row of insertedRows) perRule.set(row.rule_id, (perRule.get(row.rule_id) ?? 0) + 1)
      for (const [ruleId, n] of perRule) {
        // 단순 증가: 현재값 읽어 +n (경합 무시 — 단일 cron)
        const { data: cur } = await admin
          .from('jimscanner_trends_alert_rules')
          .select('fired_count')
          .eq('id', ruleId)
          .single()
        const base = ((cur as { fired_count?: number } | null)?.fired_count) ?? 0
        await admin
          .from('jimscanner_trends_alert_rules')
          .update({ fired_count: base + n })
          .eq('id', ruleId)
      }
    }

    return {
      status: 'ok',
      rules_evaluated: rules.length,
      products_scanned: byProduct.size,
      fired: firedCount,
      delivered: deliveredCount,
    }
  } catch (e) {
    return {
      status: 'error',
      rules_evaluated: 0,
      products_scanned: 0,
      fired: 0,
      delivered: 0,
      error: e instanceof Error ? e.message : String(e),
    }
  }
}

/** 단일 룰 × 단일 product 평가. 충족 시 FiredAlert, 아니면 null. */
function evaluateRule(
  rule: AlertRule,
  snaps: ScoreRow[],
  meta: { name: string; category: string } | undefined,
): FiredAlert | null {
  const latest = snaps[0]
  const prev = snaps[1]
  if (!latest) return null

  const cond = rule.condition ?? {}
  const type = String(cond.type ?? '')
  // 스냅샷 식별 — 같은 latest 스냅샷에서 한 번만 발화
  const snapTag = latest.computed_at

  const base = (triggerValue: number, message: string, extra: Record<string, unknown> = {}) => ({
    rule_id: rule.id,
    product_id: latest.product_id,
    product_name: meta?.name ?? null,
    category_top: meta?.category ?? null,
    trigger_value: triggerValue,
    message,
    payload: { type, latest_computed_at: latest.computed_at, ...extra },
    dedup_key: `${rule.id}:${latest.product_id}:${snapTag}`,
    channel: rule.channel,
    delivered: rule.channel === 'instant',
    delivered_at: rule.channel === 'instant' ? latest.computed_at : null,
  })

  switch (type) {
    case 'score_delta': {
      if (!prev) return null
      const metric = isMetric(cond.metric) ? cond.metric : 'final_score'
      const op = String(cond.op ?? '>')
      const threshold = Number(cond.threshold ?? 0)
      const delta = Number(latest[metric]) - Number(prev[metric])
      const pass = op === '<' ? delta < threshold : delta > threshold
      if (!pass) return null
      const sign = delta >= 0 ? '+' : ''
      return base(
        delta,
        `${metric} ${sign}${delta.toFixed(0)} → ${Number(latest[metric]).toFixed(0)}`,
        { metric, delta, prev: prev[metric], curr: latest[metric] },
      )
    }
    case 'threshold_cross': {
      const metric = isMetric(cond.metric) ? cond.metric : 'final_score'
      const threshold = Number(cond.threshold ?? 0)
      const curr = Number(latest[metric])
      // 상향돌파: 직전엔 미만, 지금은 이상
      if (curr < threshold) return null
      if (prev && Number(prev[metric]) >= threshold) return null
      return base(curr, `${metric} ${threshold} 상향돌파 → ${curr.toFixed(0)}`, {
        metric,
        threshold,
        curr,
      })
    }
    case 'new_supplier_margin': {
      // supplier_score 가 의미있게 잡혀 있고(매칭됨) 직전 대비 신규/상승했을 때 근사.
      // 정밀 마진은 supplier price 결합 필요 — 1차는 supplier_score 게이트로 근사.
      const minMargin = Number(cond.min_margin_krw ?? 0)
      const sup = Number(latest.supplier_score)
      const wasMatched = prev ? Number(prev.supplier_score) > 0 : false
      if (sup <= 0 || wasMatched) return null
      // supplier_score(0~100) 를 마진 게이트의 대용 — 60 이상이면 마진성 있다고 본다.
      if (sup < 60) return null
      return base(sup, `신규 공급원 매칭 (supplier_score ${sup.toFixed(0)}, 마진≥${minMargin}원 후보)`, {
        supplier_score: sup,
        min_margin_krw: minMargin,
      })
    }
    case 'rank_velocity': {
      // final_score 의 절대 상승 속도(스냅샷 1틱당 Δ). score_delta 의 별칭에 가깝지만
      // 의미상 '브레이크아웃' 으로 분리 — threshold 이상 가속 시 발화.
      if (!prev) return null
      const metric = isMetric(cond.metric) ? cond.metric : 'final_score'
      const threshold = Number(cond.threshold ?? 0)
      const velocity = Number(latest[metric]) - Number(prev[metric])
      if (velocity < threshold) return null
      return base(velocity, `브레이크아웃: ${metric} 가속 +${velocity.toFixed(0)}`, {
        metric,
        velocity,
      })
    }
    case 'cold_start_token': {
      // 콜드스타트: 직전 스냅샷이 아예 없던(=신규 등장) product.
      if (prev) return null
      const curr = Number(latest.final_score)
      const floor = Number(cond.min_final_score ?? 0)
      if (curr < floor) return null
      return base(curr, `콜드스타트 신규 등장 (final_score ${curr.toFixed(0)})`, {
        first_snapshot: latest.computed_at,
      })
    }
    default:
      return null
  }
}
