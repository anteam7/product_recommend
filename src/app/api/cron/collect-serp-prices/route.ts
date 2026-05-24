import { NextResponse, type NextRequest } from 'next/server'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import { isAuthorizedCron } from '@/lib/market-signals'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

/**
 * SERP 가격분산 알파 cron.
 *
 * 핀한 후보 (jimscanner_trends_pins) 와 최근 7일 high-final-score (>=50) 후보 키워드를
 * 합쳐서 각 키워드에 대해 Naver 쇼핑 SERP top 20~30 listing 의 lprice 를 수집,
 * CV / IQR / minmax gap 등을 계산해 jimscanner_serp_price_snapshot 에 누적.
 */

const NAVER_SHOP_API = 'https://openapi.naver.com/v1/search/shop.json'
const PER_KEYWORD_DISPLAY = 30
const MAX_KEYWORDS_PER_RUN = 40 // API quota 보호

type NaverShopItem = {
  title?: string
  link?: string
  lprice?: string
  hprice?: string
  mallName?: string
  productId?: string
  category1?: string
  category2?: string
}

function stripTags(s: string | undefined): string {
  if (!s) return ''
  return s
    .replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim()
}

async function fetchSerp(query: string): Promise<NaverShopItem[]> {
  const id = process.env.NAVER_OPENAPI_CLIENT_ID
  const secret = process.env.NAVER_OPENAPI_CLIENT_SECRET
  if (!id || !secret) throw new Error('NAVER_OPENAPI 키 미설정')

  const url = `${NAVER_SHOP_API}?query=${encodeURIComponent(
    query,
  )}&display=${PER_KEYWORD_DISPLAY}&sort=sim`

  const res = await fetch(url, {
    headers: {
      'X-Naver-Client-Id': id,
      'X-Naver-Client-Secret': secret,
    },
  })
  if (!res.ok) {
    throw new Error(`naver_shop ${res.status}: ${await res.text().catch(() => '')}`)
  }
  const json = (await res.json()) as { items?: NaverShopItem[] }
  return json.items ?? []
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0
  if (sorted.length === 1) return sorted[0]
  const pos = (sorted.length - 1) * q
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  if (lo === hi) return sorted[lo]
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo)
}

function computeStats(rawPrices: number[]) {
  // 명백한 이상치 트림: lprice <= 0 또는 평균 ± 3σ 밖 제거 (간단)
  const prices = rawPrices.filter((p) => Number.isFinite(p) && p > 0)
  if (prices.length === 0) {
    return {
      n: 0,
      mean: null,
      median: null,
      p25: null,
      p75: null,
      min: null,
      max: null,
      stddev: null,
      cv: null,
      iqrRatio: null,
      minmaxGap: null,
    }
  }
  const sorted = [...prices].sort((a, b) => a - b)
  const n = sorted.length
  const mean = sorted.reduce((s, v) => s + v, 0) / n
  const variance = sorted.reduce((s, v) => s + (v - mean) ** 2, 0) / n
  const stddev = Math.sqrt(variance)
  const median = quantile(sorted, 0.5)
  const p25 = quantile(sorted, 0.25)
  const p75 = quantile(sorted, 0.75)
  const min = sorted[0]
  const max = sorted[n - 1]
  const cv = mean > 0 ? stddev / mean : null
  const iqrRatio = median > 0 ? (p75 - p25) / median : null
  const minmaxGap = median > 0 ? (max - min) / median : null
  return { n, mean, median, p25, p75, min, max, stddev, cv, iqrRatio, minmaxGap }
}

async function gatherTargetKeywords(
  admin: ReturnType<typeof createAdminClient>,
): Promise<Array<{ keyword: string; product_id?: string; category_top?: string }>> {
  const set = new Map<string, { keyword: string; product_id?: string; category_top?: string }>()

  // 1) 핀한 키워드
  const { data: pins } = await admin
    .from('jimscanner_trends_pins')
    .select('keyword')
    .order('pinned_at', { ascending: false })
    .limit(MAX_KEYWORDS_PER_RUN)
  for (const p of (pins ?? []) as Array<{ keyword: string | null }>) {
    if (!p.keyword) continue
    set.set(p.keyword, { keyword: p.keyword })
  }

  // 2) 최근 7일 high final_score 후보 (canonical_name + alias)
  if (set.size < MAX_KEYWORDS_PER_RUN) {
    const sb = admin as any
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString()
    const { data: scores } = await sb
      .from('jimscanner_trends_scores')
      .select('product_id, final_score, computed_at')
      .gte('computed_at', sevenDaysAgo)
      .gte('final_score', 50)
      .order('final_score', { ascending: false })
      .limit(60)

    const ids = Array.from(
      new Set(((scores ?? []) as Array<{ product_id: string }>).map((s) => s.product_id)),
    ).slice(0, MAX_KEYWORDS_PER_RUN)

    if (ids.length > 0) {
      const { data: prods } = await sb
        .from('jimscanner_trends_products')
        .select('id, canonical_name, category_top')
        .in('id', ids)
      for (const p of (prods ?? []) as Array<{
        id: string
        canonical_name: string
        category_top: string
      }>) {
        if (!p.canonical_name) continue
        if (set.has(p.canonical_name)) continue
        if (set.size >= MAX_KEYWORDS_PER_RUN) break
        set.set(p.canonical_name, {
          keyword: p.canonical_name,
          product_id: p.id,
          category_top: p.category_top,
        })
      }
    }
  }

  return Array.from(set.values()).slice(0, MAX_KEYWORDS_PER_RUN)
}

export async function GET(request: NextRequest) {
  if (!isAuthorizedCron(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const admin = createAdminClient()
  const startedAt = Date.now()

  let targets: Awaited<ReturnType<typeof gatherTargetKeywords>>
  try {
    targets = await gatherTargetKeywords(admin)
  } catch (e) {
    return NextResponse.json(
      { error: 'gather_failed', detail: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    )
  }

  if (targets.length === 0) {
    return NextResponse.json({ ok: true, fetched: 0, inserted: 0, note: 'no targets' })
  }

  let fetched = 0
  let inserted = 0
  const errors: Array<{ keyword: string; reason: string }> = []

  for (const t of targets) {
    try {
      const items = await fetchSerp(t.keyword)
      fetched++

      const rawPrices: number[] = []
      const sampled: Array<{
        title: string
        price: number
        mallName: string
        link: string
      }> = []

      for (const item of items) {
        const lp = item.lprice ? Number(item.lprice) : NaN
        if (!Number.isFinite(lp) || lp <= 0) continue
        rawPrices.push(lp)
        sampled.push({
          title: stripTags(item.title),
          price: lp,
          mallName: stripTags(item.mallName),
          link: item.link ?? '',
        })
      }

      const stats = computeStats(rawPrices)

      const { error } = await (admin as any).from('jimscanner_serp_price_snapshot').insert({
        keyword: t.keyword,
        prices: sampled,
        n_listings: stats.n,
        mean_price: stats.mean,
        median_price: stats.median,
        p25_price: stats.p25,
        p75_price: stats.p75,
        min_price: stats.min,
        max_price: stats.max,
        stddev_price: stats.stddev,
        cv: stats.cv,
        iqr_ratio: stats.iqrRatio,
        minmax_gap_ratio: stats.minmaxGap,
        product_id: t.product_id ?? null,
        category_top: t.category_top ?? null,
      })

      if (error) errors.push({ keyword: t.keyword, reason: error.message })
      else inserted++
    } catch (e) {
      errors.push({
        keyword: t.keyword,
        reason: e instanceof Error ? e.message : String(e),
      })
    }
  }

  return NextResponse.json({
    ok: errors.length === 0,
    fetched,
    inserted,
    targets: targets.length,
    durationMs: Date.now() - startedAt,
    errors: errors.slice(0, 10),
  })
}
