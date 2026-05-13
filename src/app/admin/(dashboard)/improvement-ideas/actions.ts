'use server'

import { revalidatePath } from 'next/cache'
import { createAdminClient } from '@/lib/auth/admin-supabase'

const VALID_STATUSES = ['proposed', 'in_progress', 'done', 'rejected', 'duplicate'] as const
type Status = (typeof VALID_STATUSES)[number]

// jimscanner_improvement_ideas 는 generated Database 타입에 아직 없어서
// `as any` 로 우회. types/supabase.ts 재생성 시 제거 가능 (rpc_type_workaround 패턴 참고).
function sbLoose() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return createAdminClient() as any
}

export async function updateIdeaStatus(id: string, status: Status) {
  if (!VALID_STATUSES.includes(status)) {
    return { ok: false as const, error: `invalid status: ${status}` }
  }
  const { error } = await sbLoose()
    .from('jimscanner_improvement_ideas')
    .update({ status })
    .eq('id', id)
  if (error) return { ok: false as const, error: error.message as string }
  revalidatePath('/admin/improvement-ideas')
  return { ok: true as const }
}

export async function updateIdeaNote(id: string, note: string) {
  const trimmed = note.trim().slice(0, 2000)
  const { error } = await sbLoose()
    .from('jimscanner_improvement_ideas')
    .update({ note: trimmed || null })
    .eq('id', id)
  if (error) return { ok: false as const, error: error.message as string }
  revalidatePath('/admin/improvement-ideas')
  return { ok: true as const }
}
