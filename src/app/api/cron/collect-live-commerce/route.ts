/**
 * 라이브커머스 편성표 수집기 — Naver / Kakao / Coupang.
 *
 * 운영 의도: 향후 6~48h 의 공개 편성을 2h 주기로 수집·UPSERT 해서
 *   jimscanner_live_commerce_schedule 에 적재. 이후 매칭 RPC
 *   (jimscanner_live_ggsan_match) 가 ggsan 도매가와 fuzzy-match.
 *
 * 각 플랫폼 fetcher 는 독립적으로 try/catch. 1개 플랫폼 실패가
 * 다른 플랫폼 수집을 막지 않는다.
 *
 * 스케줄: 로컬 cron runner (scripts/run-crons.mjs) 가 2h 주기로 호출.
 */
import { NextResponse, type NextRequest } from 'next/server'
import { isAuthorizedCron } from '@/lib/market-signals'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import type { Json } from '@/lib/supabase'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36'

interface ScheduleRow {
  platform: 'naver' | 'kakao' | 'coupang'
  external_id: string
  product_title: string
  brand: string | null
  category: string | null
  mc: string | null
  scheduled_at: string
  ends_at: string | null
  image_url: string | null
  detail_url: string | null
  raw_payload: Json
}

function safeText(s: unknown, max = 200): string {
  return String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max)
}

function toIsoOrNull(v: unknown): string | null {
  if (v == null) return null
  if (typeof v === 'number') {
    const ms = v < 1e12 ? v * 1000 : v
    const d = new Date(ms)
    return Number.isNaN(d.getTime()) ? null : d.toISOString()
  }
  if (typeof v === 'string') {
    const d = new Date(v)
    return Number.isNaN(d.getTime()) ? null : d.toISOString()
  }
  return null
}

interface NaverBroadcast {
  id?: number | string
  title?: string
  liveTitle?: string
  broadcastStartTime?: string | number
  startTime?: string | number
  expectedStartDate?: string | number
  endTime?: string | number
  thumbnailImageUrl?: string
  liveThumbnailImageUrl?: string
  productName?: string
  representProductName?: string
  shopName?: string
  brandName?: string
  categoryName?: string
}

async function fetchNaverShoppingLive(): Promise<ScheduleRow[]> {
  // 네이버 쇼핑라이브 공개 예정/진행중 목록 (모바일 웹 fetch 와 동일 엔드포인트).
  // 엔드포인트가 변경/차단 시 0 건 반환 — 빌드/수집 자체는 실패하지 않게.
  const endpoints = [
    'https://apis.naver.com/livecommerceweb/livecommerceweb/v1/broadcast/list?page=1&size=40&statusType=READY',
    'https://shoppinglive.naver.com/api/v1/broadcasts/upcoming?page=1&size=40',
  ]
  const out: ScheduleRow[] = []
  for (const url of endpoints) {
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': UA,
          Accept: 'application/json, text/plain, */*',
          'Accept-Language': 'ko-KR,ko;q=0.9',
          Referer: 'https://shoppinglive.naver.com/',
        },
      })
      if (!res.ok) continue
      const json = (await res.json().catch(() => null)) as unknown
      const list = pickBroadcastList(json)
      for (const b of list) {
        const title = safeText(
          b.title ?? b.liveTitle ?? b.representProductName ?? b.productName,
        )
        if (!title) continue
        const scheduled = toIsoOrNull(
          b.broadcastStartTime ?? b.startTime ?? b.expectedStartDate,
        )
        if (!scheduled) continue
        const externalId = String(b.id ?? `${title}|${scheduled}`)
        out.push({
          platform: 'naver',
          external_id: externalId,
          product_title: title,
          brand: safeText(b.brandName ?? b.shopName) || null,
          category: safeText(b.categoryName) || null,
          mc: null,
          scheduled_at: scheduled,
          ends_at: toIsoOrNull(b.endTime),
          image_url: b.thumbnailImageUrl ?? b.liveThumbnailImageUrl ?? null,
          detail_url: `https://shoppinglive.naver.com/lives/${externalId}`,
          raw_payload: b as unknown as Json,
        })
      }
      if (out.length > 0) break // 첫 성공 엔드포인트에서 데이터 잡히면 다음 시도 안 함
    } catch {
      // 다음 엔드포인트 시도
    }
  }
  return dedupeByExternal(out)
}

function pickBroadcastList(json: unknown): NaverBroadcast[] {
  if (!json || typeof json !== 'object') return []
  const j = json as Record<string, unknown>
  const candidates: unknown[] = [
    j.broadcasts,
    j.list,
    j.data,
    j.content,
    (j.result as Record<string, unknown> | undefined)?.broadcasts,
    (j.result as Record<string, unknown> | undefined)?.list,
    (j.data as Record<string, unknown> | undefined)?.broadcasts,
    (j.data as Record<string, unknown> | undefined)?.list,
  ]
  for (const c of candidates) {
    if (Array.isArray(c)) return c as NaverBroadcast[]
  }
  return []
}

async function fetchKakaoShoppingLive(): Promise<ScheduleRow[]> {
  // 카카오쇼핑라이브 공개 편성 목록. 엔드포인트가 비공개로 잠겨있을 수 있어
  // try-only stub. 추후 실제 endpoint 확인되면 채워넣는다.
  try {
    const res = await fetch(
      'https://shoppinglive.kakao.com/api/v1/broadcast/upcoming?page=1&size=40',
      {
        headers: {
          'User-Agent': UA,
          Accept: 'application/json, text/plain, */*',
          Referer: 'https://shoppinglive.kakao.com/',
        },
      },
    )
    if (!res.ok) return []
    const json = (await res.json().catch(() => null)) as unknown
    const list = pickBroadcastList(json)
    const out: ScheduleRow[] = []
    for (const b of list) {
      const title = safeText(b.title ?? b.liveTitle ?? b.productName)
      const scheduled = toIsoOrNull(b.broadcastStartTime ?? b.startTime)
      if (!title || !scheduled) continue
      const externalId = String(b.id ?? `${title}|${scheduled}`)
      out.push({
        platform: 'kakao',
        external_id: externalId,
        product_title: title,
        brand: safeText(b.brandName ?? b.shopName) || null,
        category: safeText(b.categoryName) || null,
        mc: null,
        scheduled_at: scheduled,
        ends_at: toIsoOrNull(b.endTime),
        image_url: b.thumbnailImageUrl ?? null,
        detail_url: `https://shoppinglive.kakao.com/live/${externalId}`,
        raw_payload: b as unknown as Json,
      })
    }
    return dedupeByExternal(out)
  } catch {
    return []
  }
}

async function fetchCoupangLive(): Promise<ScheduleRow[]> {
  // 쿠팡라이브 (live.coupang.com) 공개 스케줄 — 외부 봇 차단 엄격.
  // 실패 시 0 건 반환. 추후 인증 토큰 확보 후 확장.
  try {
    const res = await fetch(
      'https://live.coupang.com/api/v1/broadcasts/schedule?page=1&size=40',
      {
        headers: {
          'User-Agent': UA,
          Accept: 'application/json, text/plain, */*',
          Referer: 'https://live.coupang.com/',
        },
      },
    )
    if (!res.ok) return []
    const json = (await res.json().catch(() => null)) as unknown
    const list = pickBroadcastList(json)
    const out: ScheduleRow[] = []
    for (const b of list) {
      const title = safeText(b.title ?? b.productName ?? b.representProductName)
      const scheduled = toIsoOrNull(
        b.broadcastStartTime ?? b.startTime ?? b.expectedStartDate,
      )
      if (!title || !scheduled) continue
      const externalId = String(b.id ?? `${title}|${scheduled}`)
      out.push({
        platform: 'coupang',
        external_id: externalId,
        product_title: title,
        brand: safeText(b.brandName) || null,
        category: safeText(b.categoryName) || null,
        mc: null,
        scheduled_at: scheduled,
        ends_at: toIsoOrNull(b.endTime),
        image_url: b.thumbnailImageUrl ?? null,
        detail_url: `https://live.coupang.com/lives/${externalId}`,
        raw_payload: b as unknown as Json,
      })
    }
    return dedupeByExternal(out)
  } catch {
    return []
  }
}

function dedupeByExternal(rows: ScheduleRow[]): ScheduleRow[] {
  const map = new Map<string, ScheduleRow>()
  for (const r of rows) {
    map.set(`${r.platform}|${r.external_id}`, r)
  }
  return [...map.values()]
}

async function recordRun(opts: {
  source: string
  status: 'ok' | 'partial' | 'error'
  fetched: number
  inserted: number
  durationMs: number
  errorMessage?: string
}) {
  const sb = createAdminClient()
  await sb.from('jimscanner_trends_runs').insert({
    source: opts.source,
    status: opts.status,
    fetched_count: opts.fetched,
    inserted_count: opts.inserted,
    duration_ms: opts.durationMs,
    error_message: opts.errorMessage ?? null,
    triggered_by: 'vercel_cron',
    finished_at: new Date().toISOString(),
  })
}

export async function GET(request: NextRequest) {
  if (!isAuthorizedCron(request))
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const t0 = Date.now()
  const perPlatform: Record<string, { fetched: number; error: string | null }> = {
    naver: { fetched: 0, error: null },
    kakao: { fetched: 0, error: null },
    coupang: { fetched: 0, error: null },
  }

  const results: ScheduleRow[] = []
  const [naverRes, kakaoRes, coupangRes] = await Promise.allSettled([
    fetchNaverShoppingLive(),
    fetchKakaoShoppingLive(),
    fetchCoupangLive(),
  ])

  if (naverRes.status === 'fulfilled') {
    perPlatform.naver.fetched = naverRes.value.length
    results.push(...naverRes.value)
  } else {
    perPlatform.naver.error = String(naverRes.reason)
  }
  if (kakaoRes.status === 'fulfilled') {
    perPlatform.kakao.fetched = kakaoRes.value.length
    results.push(...kakaoRes.value)
  } else {
    perPlatform.kakao.error = String(kakaoRes.reason)
  }
  if (coupangRes.status === 'fulfilled') {
    perPlatform.coupang.fetched = coupangRes.value.length
    results.push(...coupangRes.value)
  } else {
    perPlatform.coupang.error = String(coupangRes.reason)
  }

  let inserted = 0
  try {
    if (results.length > 0) {
      const sb = createAdminClient()
      // chunk 100 으로 UPSERT (platform+external_id UNIQUE 키)
      for (let i = 0; i < results.length; i += 100) {
        const chunk = results.slice(i, i + 100)
        const { error, count } = await sb
          // 마이그레이션 후 가정 — 타입은 아직 generate 안 됨
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          .from('jimscanner_live_commerce_schedule' as any)
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          .upsert(chunk as any, {
            onConflict: 'platform,external_id',
            ignoreDuplicates: false,
            count: 'exact',
          })
        if (error) throw new Error(`upsert: ${error.message}`)
        if (typeof count === 'number') inserted += count
        else inserted += chunk.length
      }
    }

    const hasAnyData = results.length > 0
    const allPlatformsFailed =
      perPlatform.naver.error && perPlatform.kakao.error && perPlatform.coupang.error
    const status: 'ok' | 'partial' | 'error' = allPlatformsFailed
      ? 'error'
      : hasAnyData
        ? perPlatform.naver.error || perPlatform.kakao.error || perPlatform.coupang.error
          ? 'partial'
          : 'ok'
        : 'partial'

    await recordRun({
      source: 'live_commerce',
      status,
      fetched: results.length,
      inserted,
      durationMs: Date.now() - t0,
      errorMessage: allPlatformsFailed
        ? 'all platforms failed'
        : Object.entries(perPlatform)
            .filter(([, v]) => v.error)
            .map(([k, v]) => `${k}:${v.error}`)
            .join('; ') || undefined,
    })

    return NextResponse.json({
      ok: !allPlatformsFailed,
      fetched: results.length,
      inserted,
      per_platform: perPlatform,
      duration_ms: Date.now() - t0,
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    await recordRun({
      source: 'live_commerce',
      status: 'error',
      fetched: results.length,
      inserted,
      durationMs: Date.now() - t0,
      errorMessage: msg,
    }).catch(() => {})
    return NextResponse.json({ ok: false, error: msg }, { status: 500 })
  }
}
