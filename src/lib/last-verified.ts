import { createAdminClient } from '@/lib/auth/admin-supabase'

/**
 * 각 배대지의 "요금 마지막 확인/업데이트 일시" 를 Map 으로 반환.
 *
 * 우선순위:
 *   1) jimscanner_rate_check_results.applied_at  — AI 추출 결과를 운영자가 "반영" 한 시점 (가장 강한 신호)
 *   2) shipping_rates.max(updated_at)            — 관리자 요금 수동 편집 or 이전 반영 흔적 (폴백)
 */
export async function getLastVerifiedMap(): Promise<Map<string, string>> {
  const admin = createAdminClient()

  const [appliedRes, ratesRes] = await Promise.all([
    admin
      .from('jimscanner_rate_check_results')
      .select('forwarder_id, applied_at')
      .not('applied_at', 'is', null)
      .order('applied_at', { ascending: false }),
    admin.from('shipping_rates').select('forwarder_id, updated_at'),
  ])

  const map = new Map<string, string>()
  for (const row of appliedRes.data ?? []) {
    const id = row.forwarder_id as string
    const at = row.applied_at as string | null
    if (!at) continue
    const existing = map.get(id)
    if (!existing || existing < at) map.set(id, at)
  }

  for (const row of ratesRes.data ?? []) {
    const id = row.forwarder_id as string
    const at = row.updated_at as string | null
    if (!at) continue
    if (map.has(id)) continue // applied_at이 우선
    const existing = map.get(id)
    if (!existing || existing < at) map.set(id, at)
  }
  // shipping_rates 는 여러 행이므로 max 로 다시 정리
  const maxByFwd = new Map<string, string>()
  for (const row of ratesRes.data ?? []) {
    const id = row.forwarder_id as string
    const at = row.updated_at as string | null
    if (!at) continue
    const existing = maxByFwd.get(id)
    if (!existing || existing < at) maxByFwd.set(id, at)
  }
  // applied_at 없는 곳만 max updated_at 으로 채움
  for (const [id, at] of maxByFwd) {
    if (!map.has(id)) map.set(id, at)
  }

  return map
}
