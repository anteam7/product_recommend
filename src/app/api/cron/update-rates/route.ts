import { NextResponse, type NextRequest } from 'next/server'
import { updateAllRates } from '@/lib/exchange-rates'
import { isAuthorizedCron } from '@/lib/market-signals'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Vercel Cron 호출용 엔드포인트.
 * Vercel이 `Authorization: Bearer $CRON_SECRET` 헤더를 자동 첨부한다.
 * vercel.json의 crons 항목과 연결.
 */
export async function GET(request: NextRequest) {
  if (!isAuthorizedCron(request))
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const results = await updateAllRates('cron')
  const allOk = results.every((r) => r.status === 'success')

  return NextResponse.json(
    {
      ok: allOk,
      executed_at: new Date().toISOString(),
      results,
    },
    { status: allOk ? 200 : 500 },
  )
}
