'use server'

import { createAdminClient } from '@/lib/auth/admin-supabase'

export interface EvidenceRow {
  source: string
  collected_at: string
  snippet: string
}

// 후보 클릭 시 동시발화 멘션 원문 타임라인 (service-role, 어드민 전용)
export async function fetchAstroturfEvidence(keyword: string): Promise<EvidenceRow[]> {
  const sb = createAdminClient()
  const { data, error } = await sb.rpc(
    'jimscanner_trends_astroturf_evidence' as never,
    { p_keyword: keyword } as never,
  )
  if (error) {
    console.error('[astroturf-evidence]', error.message)
    return []
  }
  return (data ?? []) as EvidenceRow[]
}
