'use server'

import { revalidatePath } from 'next/cache'
import { createAdminClient } from '@/lib/auth/admin-supabase'

const ALLOWED_VERDICTS = ['reproducible', 'one_off', 'noise'] as const
type Verdict = (typeof ALLOWED_VERDICTS)[number]

export async function setSpikeVerdict(formData: FormData) {
  const id = String(formData.get('id') ?? '').trim()
  const verdictRaw = String(formData.get('verdict') ?? '').trim()
  if (!id) return
  const verdict = (ALLOWED_VERDICTS as readonly string[]).includes(verdictRaw)
    ? (verdictRaw as Verdict)
    : null

  const sb = createAdminClient()
  // jimscanner_trends_spike_attribution 은 새 테이블 — types 미반영. `as any` 캐스팅.
  await (sb.from('jimscanner_trends_spike_attribution' as never) as never as ReturnType<typeof sb.from>)
    .update({
      verdict,
      verdict_at: verdict ? new Date().toISOString() : null,
    } as never)
    .eq('id', id)

  revalidatePath('/admin/trend-radar/attribution')
}
