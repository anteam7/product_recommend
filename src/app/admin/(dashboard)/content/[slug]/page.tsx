import Link from 'next/link'
import { notFound } from 'next/navigation'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import { type ForwarderContent, emptyContentInput } from '@/lib/forwarder-content'
import { type ForwarderInfoSource } from '@/lib/forwarder-info-sources'
import ContentEditor from './ContentEditor'

export const dynamic = 'force-dynamic'

type ForwarderRow = {
  id: string
  name: string
  slug: string
  website: string | null
}

export default async function ContentEditPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const supabase = createAdminClient()

  const { data: forwarder } = await supabase
    .from('forwarders')
    .select('id, name, slug, website')
    .eq('slug', slug)
    .maybeSingle<ForwarderRow>()

  if (!forwarder) notFound()

  const [{ data: existing }, { data: infoSources }] = await Promise.all([
    supabase
      .from('jimscanner_forwarder_content')
      .select('*')
      .eq('forwarder_id', forwarder.id)
      .maybeSingle<ForwarderContent>(),
    supabase
      .from('jimscanner_forwarder_info_sources')
      .select('*')
      .eq('forwarder_id', forwarder.id)
      .order('source_type')
      .order('display_order')
      .order('created_at'),
  ])

  const initialContent = existing ?? {
    forwarder_id: forwarder.id,
    status: 'draft' as const,
    ...emptyContentInput(),
    source_urls: forwarder.website ? [forwarder.website] : [],
    created_by: null,
    reviewed_by: null,
    created_at: '',
    updated_at: '',
    published_at: null,
    overview: null,
    pricing_notes: null,
    recommended_for: null,
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <Link href="/admin/content" className="text-xs text-gray-500 hover:text-blue-600">
            ← 콘텐츠 목록
          </Link>
          <h1 className="text-2xl font-bold text-gray-900 mt-1">{forwarder.name}</h1>
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
                  공식 사이트 열기 ↗
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
          프론트 페이지 보기 ↗
        </Link>
      </div>

      <ContentEditor
        forwarderName={forwarder.name}
        forwarderSlug={forwarder.slug}
        forwarderWebsite={forwarder.website}
        initial={initialContent as ForwarderContent}
        initialInfoSources={(infoSources ?? []) as ForwarderInfoSource[]}
      />
    </div>
  )
}
