import { createClient } from '@supabase/supabase-js'
import type { Database } from '../../../types/supabase'

/**
 * service_role 키를 사용하는 서버 전용 Supabase 클라이언트.
 * RLS를 우회하므로 **관리자 페이지·Cron 라우트에서만** 사용할 것.
 * 브라우저에 절대 노출 금지.
 */
export function createAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!serviceKey) {
    throw new Error('SUPABASE_SERVICE_ROLE_KEY 환경 변수가 설정되지 않았습니다.')
  }

  return createClient<Database>(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
}
