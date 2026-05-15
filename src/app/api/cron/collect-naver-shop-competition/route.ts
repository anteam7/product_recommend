import { NextResponse, type NextRequest } from 'next/server'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import { isAuthorizedCron } from '@/lib/market-signals'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

type NaverShopItem = {
  title?: string
  link?: string
  image?: string
  lprice?: string
  hprice?: string
  mallName?: string
  productId?: string
  productType?: string
  brand?: string
  maker?: string
  category1?: string
  category2?: string
  category3?: string
  category4?: string
}

const BATCH_SIZE = 200 // 하루 1회 ggsan_recent 최근 200건

function stripTags(s: string | undefined): string {
  if (!s) return ''
  return s.replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim()
}

function quantile(sorted: number[], q: number): number | null {
  if (sorted.length === 0) return null
  const pos = (sorted.length - 1) * q
  const base = Math.floor(pos)
  const rest = pos - base
  if (sorted[base + 1] !== undefined) {
    return Math.round(sorted[base] + rest * (sorted[base + 1] - sorted[base]))
  }
  return sorted[base]
}

/** 검색용 질의: ggsan title 에서 핵심 토큰만 추출. 너무 길면 결과 0 나옴. */
function buildQuery(title: string): string {
  // 괄호/특수문자 제거, 토큰 6개 이하로 컷
  const cleaned = title.replace(/[\[\](){}<>「」『』]/g, ' ').replace(/[~^*"']/g, ' ')
  const tokens = cleaned.split(/\s+/).filter(Boolean).slice(0, 6)
  return tokens.join(' ').trim()
}

async function searchShop(query: string): Promise<{ total: number; items: NaverShopItem[] }> {
  const id = process.env.NAVER_OPENAPI_CLIENT_ID
  const secret = process.env.NAVER_OPENAPI_CLIENT_SECRET
  if (!id || !secret) throw new Error('NAVER_OPENAPI 키 미설정')

  const url = `https://openapi.naver.com/v1/search/shop.json?query=${encodeURIComponent(query)}&display=10&sort=sim`
  const res = await fetch(url, {
    headers: {
      'X-Naver-Client-Id': id,
      'X-Naver-Client-Secret': secret,
    },
  })
  if (!res.ok) throw new Error(`Naver shop ${res.status}`)
  const json = (await res.json()) as { total?: number; items?: NaverShopItem[] }
  return { total: json.total ?? 0, items: json.items ?? [] }
}

function summarizeItems(items: NaverShopItem[]) {
  const prices = items
    .map((it) => parseInt(it.lprice ?? '0', 10))
    .filter((n) => Number.isFinite(n) && n > 0)
    .sort((a, b) => a - b)

  const mallCount = new Map<string, number>()
  let overseaCount = 0
  for (const it of items) {
    const mall = (it.mallName ?? '').trim() || '(unknown)'
    mallCount.set(mall, (mallCount.get(mall) ?? 0) + 1)
    // '해외직구' 시그널: category 또는 productType=='해외직구' 또는 title 포함
    const cat = `${it.category1 ?? ''} ${it.category2 ?? ''}`
    const title = stripTags(it.title)
    if (cat.includes('해외직구') || title.includes('해외직구') || it.productType === '4') {
      overseaCount += 1
    }
  }
  let topMall = ''
  let topCount = 0
  for (const [m, c] of mallCount.entries()) {
    if (c > topCount) {
      topMall = m
      topCount = c
    }
  }
  const n = Math.max(items.length, 1)

  return {
    price_p25: quantile(prices, 0.25),
    price_p50: quantile(prices, 0.5),
    price_p75: quantile(prices, 0.75),
    top_mall_name: topMall || null,
    top_mall_share: topMall ? topCount / n : null,
    oversea_share: overseaCount / n,
  }
}

export async function GET(request: NextRequest) {
  if (!isAuthorizedCron(request))
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const sb = createAdminClient()

  // ggsan_recent: 최근에 본 ggsan 상품 BATCH_SIZE개
  const { data: products, error: prodErr } = await sb
    .from('jimscanner_ggsan_products' as never)
    .select('goods_no, title')
    .order('last_seen_at', { ascending: false })
    .limit(BATCH_SIZE)

  if (prodErr) {
    return NextResponse.json({ error: `ggsan select: ${prodErr.message}` }, { status: 500 })
  }

  const rows = (products ?? []) as { goods_no: string; title: string }[]
  const inserts: Record<string, unknown>[] = []
  const errors: { goods_no: string; reason: string }[] = []
  let okCount = 0

  for (const p of rows) {
    const query = buildQuery(p.title)
    if (!query) continue
    try {
      const { total, items } = await searchShop(query)
      const summary = summarizeItems(items)
      inserts.push({
        goods_no: p.goods_no,
        query,
        listing_count: total,
        ...summary,
        top_items: items.slice(0, 10).map((it) => ({
          title: stripTags(it.title),
          lprice: parseInt(it.lprice ?? '0', 10) || null,
          mallName: it.mallName ?? null,
          productType: it.productType ?? null,
          category2: it.category2 ?? null,
          link: it.link ?? null,
        })),
      })
      okCount += 1
      // Naver Shop API rate: ~10 req/sec. 안전하게 50ms 간격.
      await new Promise((r) => setTimeout(r, 50))
    } catch (e) {
      errors.push({ goods_no: p.goods_no, reason: e instanceof Error ? e.message : String(e) })
    }
  }

  // 적재
  let inserted = 0
  if (inserts.length > 0) {
    const { error: insErr, count } = await sb
      .from('jimscanner_competition_snapshots' as never)
      .insert(inserts as never, { count: 'exact' })
    if (insErr) {
      return NextResponse.json(
        {
          ok: false,
          error: `insert: ${insErr.message}`,
          attempted: inserts.length,
          fetched: okCount,
          errors,
        },
        { status: 500 },
      )
    }
    inserted = count ?? inserts.length
  }

  return NextResponse.json({
    ok: true,
    candidates: rows.length,
    fetched: okCount,
    inserted,
    errors: errors.slice(0, 20),
    executed_at: new Date().toISOString(),
  })
}
