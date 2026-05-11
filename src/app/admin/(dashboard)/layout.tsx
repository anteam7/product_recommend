import { redirect } from 'next/navigation'
import { createClient, isAdminEmail } from '@/lib/auth/server'
import AdminShell from './AdminShell'

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user || !isAdminEmail(user.email)) {
    redirect('/admin/login')
  }

  return <AdminShell userEmail={user.email ?? ''}>{children}</AdminShell>
}
