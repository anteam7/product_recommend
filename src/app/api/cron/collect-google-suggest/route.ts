import { NextResponse, type NextRequest } from 'next/server'
import { SUGGEST_SEEDS } from '@/lib/market-keywords'
import { insertMarketRaw, isAuthorizedCron, type MarketRawInsert } from '@/lib/market-signals'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

const SLEEP_MS = 200 // 시드 사이 sleep

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}

async function fetchSuggest(query: string): Promise<string[]> {
  const url = `https://suggestqueries.google.com/complete/search?client=firefox&hl=ko&q=${encodeURIComponent(query)}`
  const res = await fetch(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0 Safari/537.36',
    },
  })
  if (!res.ok) return []
  const json = (await res.json().catch(() => null)) as unknown
  if (!Array.isArray(json) || json.length < 2) return []
  const list = json[1]
  if (!Array.isArray(list)) return []
  return list.filter((x): x is string => typeof x === 'string').slice(0, 10)
}

export async function GET(request: NextRequest) {
  if (!isAuthorizedCron(request))
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const errors: { seed: string; reason: string }[] = []
  const rows: MarketRawInsert[] = []

  for (const seed of SUGGEST_SEEDS) {
    try {
      const sugs = await fetchSuggest(seed)
      for (const s of sugs) {
        rows.push({
          source: 'google_suggest',
          dedup_key: `${seed}::${s}`,
          title: s,
          query: seed,
          metadata: { suggestion: s },
        })
      }
      await sleep(SLEEP_MS)
    } catch (e) {
      errors.push({ seed, reason: e instanceof Error ? e.message : String(e) })
    }
  }

  const result = await insertMarketRaw(rows)
  return NextResponse.json({
    ok: true,
    seeds: SUGGEST_SEEDS.length,
    fetched: rows.length,
    inserted: result.inserted,
    errors,
    executed_at: new Date().toISOString(),
  })
}
