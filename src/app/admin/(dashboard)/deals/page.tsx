import { createAdminClient } from '@/lib/auth/admin-supabase'
import type { SaleEvent } from '@/lib/deals'
import DealsManager from './DealsManager'

export const dynamic = 'force-dynamic'

export default async function AdminDealsPage() {
  const supabase = createAdminClient()
  const { data } = await supabase
    .from('jimscanner_sale_events')
    .select('*')
    .order('status', { ascending: true }) // suggested 먼저 (알파벳 순서상)
    .order('start_at', { ascending: true, nullsFirst: false })

  const events = (data ?? []) as SaleEvent[]

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">세일 이벤트</h1>
        <p className="text-sm text-gray-500 mt-1">
          해외 직구 세일 이벤트 관리. 루틴 또는 수동으로 수집된 이벤트를 검토·게시합니다.
        </p>
      </div>
      <DealsManager initial={events} />
    </div>
  )
}
