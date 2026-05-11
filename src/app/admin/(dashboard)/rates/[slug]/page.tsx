import Link from 'next/link'
import { notFound } from 'next/navigation'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import RatesEditor from './RatesEditor'

export const dynamic = 'force-dynamic'

export default async function RatesEditPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const supabase = createAdminClient()

  const { data: forwarder } = await supabase
    .from('forwarders')
    .select('id, name, slug, website')
    .eq('slug', slug)
    .maybeSingle<{ id: string; name: string; slug: string; website: string | null }>()

  if (!forwarder) notFound()

  const { data: rates } = await supabase
    .from('shipping_rates')
    .select('*')
    .eq('forwarder_id', forwarder.id)
    .order('country')
    .order('grade_level')
    .order('center_name')
    .order('weight_min')

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <Link href="/admin/rates" className="text-xs text-gray-500 hover:text-blue-600">
            ← 요금 관리 목록
          </Link>
          <h1 className="text-2xl font-bold text-gray-900 mt-1">{forwarder.name} 요금표</h1>
          <p className="text-sm text-gray-500">
            slug <code className="bg-gray-100 px-1 rounded">{forwarder.slug}</code>
            {forwarder.website && (
              <>
                {' · '}
                <a
                  href={forwarder.website}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-blue-600 hover:underline"
                >
                  공식 사이트 ↗
                </a>
              </>
            )}
          </p>
        </div>
        <Link
          href={`/forwarders/${forwarder.slug}`}
          target="_blank"
          rel="noopener noreferrer"
          className="text-sm text-blue-600 hover:underline"
        >
          프론트 페이지 ↗
        </Link>
      </div>

      <RatesEditor
        forwarderId={forwarder.id}
        forwarderName={forwarder.name}
        slug={forwarder.slug}
        initialRates={rates ?? []}
      />
    </div>
  )
}
