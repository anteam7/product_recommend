// /api/admin/search-console?days=7 — GSC 데이터 조회 (어드민 전용)

import { NextResponse, type NextRequest } from 'next/server'
import { createClient, isAdminEmail } from '@/lib/auth/server'
import { fetchGscReport } from '@/lib/search-console'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 30

const VALID_DAYS = new Set([7, 14, 30, 90])

async function requireAdmin() {
  const sb = await createClient()
  const {
    data: { user },
  } = await sb.auth.getUser()
  if (!user || !isAdminEmail(user.email)) return null
  return user
}

export async function GET(request: NextRequest) {
  const user = await requireAdmin()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const url = new URL(request.url)
  const daysRaw = Number(url.searchParams.get('days') ?? 7)
  const days = VALID_DAYS.has(daysRaw) ? daysRaw : 7

  try {
    const report = await fetchGscReport({ days })
    return NextResponse.json(report)
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    )
  }
}
