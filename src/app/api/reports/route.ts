import { NextResponse, type NextRequest } from 'next/server'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import {
  REPORT_TARGET_TYPES,
  REPORT_REASON_CATEGORIES,
  type ReportTargetType,
} from '@/lib/reports'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// 레이트리밋 윈도우 (분, 최대 건수)
const RATE_WINDOWS: { minutes: number; max: number }[] = [
  { minutes: 10, max: 3 },
  { minutes: 60, max: 10 },
  { minutes: 60 * 24, max: 30 },
]

// 동일 IP × 동일 target 중복 방지 윈도우 (분)
const DUPLICATE_WINDOW_MIN = 10

function getClientIp(req: NextRequest): string | null {
  const xff = req.headers.get('x-forwarded-for')
  if (xff) return xff.split(',')[0].trim()
  const real = req.headers.get('x-real-ip')
  if (real) return real.trim()
  return null
}

function countUrls(text: string): number {
  const matches = text.match(/https?:\/\/[^\s]+/gi)
  return matches ? matches.length : 0
}

async function verifyCaptcha(token: string | null | undefined, ip: string): Promise<boolean> {
  const secret = process.env.HCAPTCHA_SECRET_KEY
  if (!secret) return true // 키 미설정 시 스킵 (점진적 활성화)
  if (!token) return false
  try {
    const body = new URLSearchParams({ secret, response: token, remoteip: ip })
    const res = await fetch('https://hcaptcha.com/siteverify', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    })
    const data = (await res.json()) as { success?: boolean }
    return data.success === true
  } catch {
    return false
  }
}

type Body = {
  target_type?: unknown
  target_slug?: unknown
  target_id?: unknown
  target_url?: unknown
  reason_category?: unknown
  description?: unknown
  correct_info?: unknown
  source_url?: unknown
  reporter_email?: unknown
  hcaptcha_token?: unknown
}

function asString(v: unknown, max?: number): string | null {
  if (typeof v !== 'string') return null
  const t = v.trim()
  if (!t) return null
  return max ? t.slice(0, max) : t
}

export async function POST(request: NextRequest) {
  const ip = getClientIp(request)
  if (!ip) {
    return NextResponse.json({ error: 'IP를 확인할 수 없습니다' }, { status: 400 })
  }

  const ua = request.headers.get('user-agent')?.slice(0, 500) ?? null

  // 알려진 봇 UA 사전 차단 (간단 패턴)
  if (!ua || /bot|spider|crawler|wget|curl|scrapy|phantomjs/i.test(ua)) {
    return NextResponse.json({ error: '차단된 요청입니다' }, { status: 403 })
  }

  const body = (await request.json().catch(() => ({}))) as Body

  const targetType = asString(body.target_type)
  if (!targetType || !REPORT_TARGET_TYPES.includes(targetType as ReportTargetType)) {
    return NextResponse.json({ error: '유효하지 않은 target_type' }, { status: 400 })
  }

  const targetUrl = asString(body.target_url, 500)
  if (!targetUrl) {
    return NextResponse.json({ error: 'target_url 필수' }, { status: 400 })
  }

  const reasonCategory = asString(body.reason_category, 50)
  if (
    !reasonCategory ||
    !REPORT_REASON_CATEGORIES.some((r) => r.value === reasonCategory)
  ) {
    return NextResponse.json({ error: '유효하지 않은 reason_category' }, { status: 400 })
  }

  const description = asString(body.description)
  if (!description || description.length < 10 || description.length > 1000) {
    return NextResponse.json(
      { error: '설명은 10자 이상 1000자 이하' },
      { status: 400 },
    )
  }

  const targetSlug = asString(body.target_slug, 200)
  const targetId = asString(body.target_id, 200)
  const correctInfo = asString(body.correct_info, 2000)
  const sourceUrl = asString(body.source_url, 500)
  const reporterEmail = asString(body.reporter_email, 255)

  // 이메일 간단 검증
  if (reporterEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(reporterEmail)) {
    return NextResponse.json({ error: '유효하지 않은 이메일' }, { status: 400 })
  }

  // URL 스팸 탐지: description에 URL 3개 이상이면 spam 큐로 바로 분류
  const suspectedSpam = countUrls(description) >= 3

  // 자동 중복 감지: 동일 target이 최근 resolved 되었으면 duplicate로 자동 분류
  // 이미 정정된 내용을 또 신고하는 케이스(유저가 캐시 안 깨져서 못 본 경우 포함).
  const DUPLICATE_RESOLVED_WINDOW_DAYS = 30

  // hCaptcha 검증 (키 있을 때만)
  const captchaOk = await verifyCaptcha(asString(body.hcaptcha_token), ip)
  if (!captchaOk) {
    return NextResponse.json({ error: '캡차 검증 실패' }, { status: 403 })
  }

  const admin = createAdminClient()

  // IP 블록리스트
  const { data: blocked } = await admin
    .from('jimscanner_report_ip_blocklist')
    .select('ip')
    .eq('ip', ip)
    .maybeSingle()
  if (blocked) {
    return NextResponse.json({ error: '차단된 IP' }, { status: 403 })
  }

  // 동일 IP × 동일 target 중복 방지 (10분)
  if (targetSlug || targetId) {
    const sinceIso = new Date(Date.now() - DUPLICATE_WINDOW_MIN * 60_000).toISOString()
    let q = admin
      .from('jimscanner_reports')
      .select('id', { count: 'exact', head: true })
      .eq('reporter_ip', ip)
      .eq('target_type', targetType)
      .gte('created_at', sinceIso)
    if (targetSlug) q = q.eq('target_slug', targetSlug)
    if (targetId) q = q.eq('target_id', targetId)
    const { count } = await q
    if ((count ?? 0) > 0) {
      return NextResponse.json(
        { error: '같은 대상에 대한 신고가 이미 접수되었습니다. 잠시 후 다시 시도해주세요.' },
        { status: 429 },
      )
    }
  }

  // IP 레이트리밋: 여러 윈도우 체크
  for (const w of RATE_WINDOWS) {
    const sinceIso = new Date(Date.now() - w.minutes * 60_000).toISOString()
    const { count } = await admin
      .from('jimscanner_reports')
      .select('id', { count: 'exact', head: true })
      .eq('reporter_ip', ip)
      .gte('created_at', sinceIso)
    if ((count ?? 0) >= w.max) {
      return NextResponse.json(
        {
          error: `신고 한도 초과 (${w.minutes}분 ${w.max}건). 잠시 후 다시 시도해주세요.`,
        },
        { status: 429 },
      )
    }
  }

  // 자동 중복 감지
  let autoDuplicate = false
  if (!suspectedSpam && (targetSlug || targetId)) {
    const sinceIso = new Date(
      Date.now() - DUPLICATE_RESOLVED_WINDOW_DAYS * 24 * 60 * 60_000,
    ).toISOString()
    let dq = admin
      .from('jimscanner_reports')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'resolved')
      .eq('target_type', targetType)
      .gte('resolved_at', sinceIso)
    if (targetSlug) dq = dq.eq('target_slug', targetSlug)
    if (targetId) dq = dq.eq('target_id', targetId)
    const { count: resolvedCount } = await dq
    if ((resolvedCount ?? 0) > 0) autoDuplicate = true
  }

  const initialStatus = suspectedSpam
    ? 'spam'
    : autoDuplicate
      ? 'duplicate'
      : 'pending'

  // 저장
  const { data: inserted, error } = await admin
    .from('jimscanner_reports')
    .insert({
      target_type: targetType,
      target_slug: targetSlug,
      target_id: targetId,
      target_url: targetUrl,
      reason_category: reasonCategory,
      description,
      correct_info: correctInfo,
      source_url: sourceUrl,
      reporter_email: reporterEmail,
      reporter_ip: ip,
      reporter_ua: ua,
      status: initialStatus,
    })
    .select('id, status, created_at')
    .single()

  if (error) {
    console.error('[reports] insert failed', error)
    return NextResponse.json({ error: '저장 실패' }, { status: 500 })
  }

  return NextResponse.json({
    ok: true,
    id: inserted.id,
    status: inserted.status,
  })
}
