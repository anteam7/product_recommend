/**
 * 발굴↔소싱 카테고리 정합 매트릭스 API.
 * 두 분포(발굴 수요 / 소싱 공급)를 공통 카테고리 축으로 집계해 반환.
 */
import { NextResponse } from 'next/server'
import { createClient, isAdminEmail } from '@/lib/auth/server'
import { buildSourcingFitMatrix } from '@/lib/trend-radar/sourcing-fit'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  const sb = await createClient()
  const {
    data: { user },
  } = await sb.auth.getUser()
  if (!user || !isAdminEmail(user.email)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const result = await buildSourcingFitMatrix()
  return NextResponse.json(result)
}
