import { createAdminClient } from '@/lib/auth/admin-supabase'
import type { Json } from '@/lib/supabase'

export type MarketSource =
  | 'google_suggest'
  | 'naver_news'
  | 'naver_blog'
  | 'clien_park'
  | 'quasarzone_sale'
  | 'kca_press'

export type MarketRawInsert = {
  source: MarketSource
  dedup_key: string                 // source 안에서 중복 판별 키 (URL · query::suggestion · external_id 등)
  source_url?: string | null
  title?: string | null
  query?: string | null
  external_id?: string | null
  metadata?: Record<string, unknown>
}

/**
 * raw 시그널 다수를 dedup 으로 적재. 이미 있는 (source, dedup_key) 는 skip.
 * 새로 insert 된 행 수를 반환.
 */
export async function insertMarketRaw(
  rows: MarketRawInsert[],
): Promise<{ inserted: number; total: number }> {
  if (rows.length === 0) return { inserted: 0, total: 0 }
  const admin = createAdminClient()

  const payload = rows.map((r) => ({
    source: r.source,
    dedup_key: r.dedup_key,
    source_url: r.source_url ?? null,
    title: r.title ?? null,
    query: r.query ?? null,
    external_id: r.external_id ?? null,
    metadata: (r.metadata ?? {}) as Json,
  }))

  // ignoreDuplicates: 이미 있는 dedup_key 는 무시. 새로 들어간 행만 select 결과에 등장.
  const { data, error } = await admin
    .from('jimscanner_market_raw')
    .upsert(payload, { onConflict: 'source,dedup_key', ignoreDuplicates: true })
    .select('id')

  if (error) throw new Error(`insertMarketRaw: ${error.message}`)

  return { inserted: data?.length ?? 0, total: rows.length }
}

/**
 * 만료된 raw 행 정리. 별도 cron 으로 호출하거나 각 수집 cron 끝에 호출.
 */
export async function cleanupExpiredRaw(): Promise<number> {
  const admin = createAdminClient()
  const { error, count } = await admin
    .from('jimscanner_market_raw')
    .delete({ count: 'exact' })
    .lt('expires_at', new Date().toISOString())
  if (error) throw new Error(`cleanupExpiredRaw: ${error.message}`)
  return count ?? 0
}

/**
 * 모든 cron 라우트가 사용하는 인증 헬퍼.
 * Vercel Cron 은 `Authorization: Bearer ${CRON_SECRET}` 헤더를 자동 첨부함.
 * (수동 호출 시에도 같은 헤더 사용)
 */
export function isAuthorizedCron(request: Request): boolean {
  const expected = process.env.CRON_SECRET
  if (!expected) return false
  const auth = request.headers.get('authorization') ?? ''
  return auth === `Bearer ${expected}`
}
