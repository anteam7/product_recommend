import { NextResponse, type NextRequest } from 'next/server'
import { insertMarketRaw, isAuthorizedCron, type MarketRawInsert } from '@/lib/market-signals'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

// 식약처 식품안전나라 — 회수·판매중지 / 원료 사용금지·위해 공고 수집
//   openAPI: https://openapi.foodsafetykorea.go.kr/api/{KEY}/{SERVICE}/json/{start}/{end}
//   I2810 = 회수판매중지 식품정보 (제품명·제조사·회수사유·공고일)
//   I0490 = 부정·불량식품 신고 (원료/위해정보 보조)
// 키 미설정 시 graceful no-op (사람이 MFDS_API_KEY 등록 후 동작).
const API_KEY = process.env.MFDS_API_KEY ?? ''
const SERVICES = ['I2810'] as const
const PAGE = 200

// metadata 안에서 제품명/제조사/회수사유/원료/공고일을 뽑아내는 후보 필드명.
// 식약처 서비스마다 컬럼명이 달라 여러 후보를 순회한다.
const FIELD_ALIASES = {
  product_name: ['PRDLST_NM', 'PRDT_NM', 'PRODUCT', 'PRDLST_NM_KOR', 'TITLE'],
  maker: ['BSSH_NM', 'MUFC_NM', 'CMPNY_NM', 'MAKER'],
  reason: ['RTRVL_RSON', 'DSPS_RSON', 'RECALL_RSON', 'RTRVL_CMD_CN', 'CONTENT', 'DTLS'],
  ingredient: ['RAWMTRL_NM', 'INGR_NM', 'HARM_INGR', 'HRM_INGR_NM'],
  notice_date: ['RTRVL_PNTTM', 'DSPS_DT', 'PBLNCDT', 'NTCDT', 'CRET_DTTM', 'RECALL_DT'],
} as const

function pick(row: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const k of keys) {
    const v = row[k]
    if (typeof v === 'string' && v.trim()) return v.trim()
  }
  return null
}

type ServicePayload = Record<string, { row?: Record<string, unknown>[]; RESULT?: { CODE?: string } }>

async function fetchService(service: string): Promise<Record<string, unknown>[]> {
  const url = `https://openapi.foodsafetykorea.go.kr/api/${API_KEY}/${service}/json/1/${PAGE}`
  const res = await fetch(url, { cache: 'no-store' })
  if (!res.ok) throw new Error(`${service} HTTP ${res.status}`)
  const json = (await res.json()) as ServicePayload
  const block = json[service]
  return Array.isArray(block?.row) ? block.row : []
}

export async function GET(request: NextRequest) {
  if (!isAuthorizedCron(request))
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  if (!API_KEY) {
    return NextResponse.json({
      ok: true,
      skipped: 'MFDS_API_KEY not set',
      inserted: 0,
      matched: 0,
      executed_at: new Date().toISOString(),
    })
  }

  const rows: MarketRawInsert[] = []
  const errors: string[] = []
  const seen = new Set<string>()

  for (const service of SERVICES) {
    let items: Record<string, unknown>[] = []
    try {
      items = await fetchService(service)
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e))
      continue
    }
    for (const it of items) {
      const productName = pick(it, FIELD_ALIASES.product_name)
      const maker = pick(it, FIELD_ALIASES.maker)
      const reason = pick(it, FIELD_ALIASES.reason)
      const ingredient = pick(it, FIELD_ALIASES.ingredient)
      const noticeDate = pick(it, FIELD_ALIASES.notice_date)
      if (!productName && !ingredient) continue

      // 안정적 dedup 키: 서비스·제품명·제조사·공고일 조합
      const dedupKey = `${service}::${productName ?? ''}::${maker ?? ''}::${noticeDate ?? ''}`.slice(0, 400)
      if (seen.has(dedupKey)) continue
      seen.add(dedupKey)

      rows.push({
        source: 'mfds_recall',
        dedup_key: dedupKey,
        title: productName ?? ingredient,
        metadata: {
          service,
          product_name: productName,
          maker,
          reason,
          ingredient,
          notice_date: noticeDate,
          // 원문 row 전체를 보존 (필드명이 서비스마다 달라 디버깅·재매핑 대비)
          raw: it,
        },
      })
    }
  }

  const result = await insertMarketRaw(rows)
  return NextResponse.json({
    ok: errors.length === 0,
    matched: rows.length,
    inserted: result.inserted,
    errors: errors.length ? errors : undefined,
    executed_at: new Date().toISOString(),
  })
}
