import { createAdminClient } from '@/lib/auth/admin-supabase'
import type { Json } from '@/lib/supabase'

export type AdminAction = {
  actor: string | null | undefined
  action: string
  target_type: string
  target_id: string
  summary?: string | null
  metadata?: Record<string, unknown>
}

export type AdminActionRow = {
  id: string
  created_at: string
  actor: string | null
  action: string
  target_type: string | null
  target_id: string | null
  summary: string | null
  metadata: Record<string, unknown>
}

/**
 * 관리자 액션 로그 기록. 실패해도 throw 하지 않음 — 본 작업을 절대 방해하지 않기 위해.
 */
export async function logAdminAction(a: AdminAction): Promise<void> {
  try {
    const admin = createAdminClient()
    await admin.from('jimscanner_admin_actions').insert({
      actor: a.actor ?? null,
      action: a.action,
      target_type: a.target_type,
      target_id: a.target_id,
      summary: a.summary ?? null,
      metadata: (a.metadata ?? {}) as Json,
    })
  } catch (err) {
    // 로그 실패는 콘솔에만
    console.warn('[admin-log] insert failed', err)
  }
}
