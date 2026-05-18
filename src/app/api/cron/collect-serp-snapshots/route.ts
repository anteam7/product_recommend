import { NextResponse, type NextRequest } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { isAuthorizedCron } from '@/lib/market-signals'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

const CATEGORY_QUERIES: Record<string, string[]> = {
  health: ['오메가3', '유산균', '비타민', '루테인', '콜라겐'],
  living: ['주방세제', '세탁세제', '청소포', '수세미', '욕실청소'],
  digital: ['보조배터리', '블루투스이어폰', '무선마우스', '키보드', '충전기'],
}

function currentWeekMonday(): string {
  const now = new Date()
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000)
  const dow = kst.getUTCDay()
  const offset = dow === 0 ? -6 : 1 - dow
  const monday = new Date(kst)
  monday.setUTCDate(kst.getUTCDate() + offset)
  return monday.toISOString().slice(0, 10)
}

async function fetchNaverShoppingTop50(query: string, id: string, secret: string) {
  const url = `https://openapi.naver.com/v1/search/shop.json?query=${encodeURIComponent(query)}&display=50&sort=sim`
  const res = await fetch(url, {
    headers: { 'X-Naver-Client-Id': id, 'X-Naver-Client-Secret': secret },
  })
  if (!res.ok) throw new Error(`naver ${res.status}`)
  const j = (await res.json()) as { items?: any[] }
  return j.items ?? []
}

export async function GET(request: NextRequest) {
  if (!isAuthorizedCron(request))
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  const naverId = process.env.NAVER_OPENAPI_CLIENT_ID
  const naverSecret = process.env.NAVER_OPENAPI_CLIENT_SECRET
  if (!url || !key)
    return NextResponse.json({ error: 'supabase env missing' }, { status: 500 })
  if (!naverId || !naverSecret)
    return NextResponse.json({ error: 'naver env missing' }, { status: 500 })

  const admin = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  const week = currentWeekMonday()
  const results: Array<{ category: string; inserted: number; error?: string }> = []
  let totalInserted = 0

  for (const [category, queries] of Object.entries(CATEGORY_QUERIES)) {
    const merged = new Map<string, any>()
    let rank = 0
    try {
      for (const q of queries) {
        let items: any[] = []
        try {
          items = await fetchNaverShoppingTop50(q, naverId, naverSecret)
        } catch {
          continue
        }
        for (const it of items) {
          const pid = String(it.productId ?? it.productCode ?? '')
          if (!pid || merged.has(pid)) continue
          rank++
          merged.set(pid, {
            category,
            week,
            rank,
            product_id: pid,
            seller: it.mallName ?? null,
            reviews: null,
          })
          if (rank >= 50) break
        }
        if (rank >= 50) break
        await new Promise((r) => setTimeout(r, 250))
      }
      const rows = [...merged.values()]
      if (rows.length > 0) {
        const { error } = await (admin as any)
          .from('jimscanner_serp_snapshots')
          .upsert(rows, { onConflict: 'category,week,rank' })
        if (error) throw new Error(error.message)
      }
      results.push({ category, inserted: rows.length })
      totalInserted += rows.length
    } catch (e) {
      results.push({
        category,
        inserted: 0,
        error: e instanceof Error ? e.message : String(e),
      })
    }
  }

  const ok = results.every((r) => !r.error)
  return NextResponse.json(
    { ok, week, total_inserted: totalInserted, results },
    { status: ok ? 200 : 500 },
  )
}
