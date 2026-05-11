import Link from 'next/link'
import { notFound } from 'next/navigation'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import { AdditionalService } from '@/types'
import ServicesEditor from './ServicesEditor'

export const dynamic = 'force-dynamic'

interface Props {
  params: Promise<{ slug: string }>
}

export default async function ServicesEditorPage({ params }: Props) {
  const { slug } = await params
  const supabase = createAdminClient()

  const { data: forwarder } = await supabase
    .from('forwarders')
    .select('id, name, slug, is_active')
    .eq('slug', slug)
    .single()
  if (!forwarder) notFound()

  const { data: services } = await supabase
    .from('forwarder_additional_services')
    .select('*')
    .eq('forwarder_id', forwarder.id)
    .order('category')
    .order('display_order')

  const list = (services ?? []) as AdditionalService[]

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <nav className="text-xs text-gray-500 mb-1">
            <Link href="/admin/services" className="hover:underline">부가서비스 관리</Link>
            {' / '}
            <span className="text-gray-900">{forwarder.name}</span>
          </nav>
          <h1 className="text-2xl font-bold text-gray-900">{forwarder.name} 부가서비스</h1>
          <p className="text-sm text-gray-500 mt-1">
            카테고리별로 그룹화되어 표시됩니다. 원문 가격(예: &ldquo;3,500원/박스&rdquo;)을 그대로 입력해도
            됩니다 — 저장 시 숫자·통화가 자동 추출됩니다.
          </p>
        </div>
        <Link
          href={`/forwarders/${slug}`}
          className="text-sm text-blue-600 hover:underline whitespace-nowrap"
          target="_blank"
          rel="noreferrer"
        >
          프론트 보기 ↗
        </Link>
      </div>

      <ServicesEditor
        forwarderId={forwarder.id}
        forwarderSlug={forwarder.slug}
        initial={list}
      />
    </div>
  )
}
