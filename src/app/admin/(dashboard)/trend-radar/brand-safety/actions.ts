'use server'

import { revalidatePath } from 'next/cache'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export async function whitelistHit(hitId: string): Promise<{ ok: boolean; error?: string }> {
  if (!hitId) return { ok: false, error: 'missing hitId' }
  const sb = createAdminClient()
  const { error } = await (sb as any)
    .from('jimscanner_trends_brand_risk_hits')
    .update({
      is_whitelisted: true,
      whitelisted_by: 'admin',
      whitelisted_at: new Date().toISOString(),
    })
    .eq('id', hitId)
  if (error) return { ok: false, error: error.message }
  revalidatePath('/admin/trend-radar/brand-safety')
  revalidatePath('/admin/trend-radar')
  return { ok: true }
}
