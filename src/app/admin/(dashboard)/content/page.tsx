import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import {
  type ForwarderContent,
  type ForwarderContentStatus,
  countContentChars,
  MIN_CONTENT_CHARS,
} from '@/lib/forwarder-content'
import { Badge } from '@/components/ui/badge'

export const dynamic = 'force-dynamic'

type ForwarderRow = {
  id: string
  name: string
  slug: string
  website: string | null
  is_active: boolean
}

const STATUS_LABELS: Record<ForwarderContentStatus | 'none', { label: string; className: string }> = {
  none: { label: '콘텐츠 없음', className: 'bg-gray-400' },
  draft: { label: '드래프트', className: 'bg-amber-500' },
  published: { label: '발행됨', className: 'bg-green-600' },
}

export default async function ContentListPage() {
  const supabase = createAdminClient()

  const [{ data: forwarders }, { data: contents }] = await Promise.all([
    supabase
      .from('forwarders')
      .select('id, name, slug, website, is_active')
      .order('name'),
    supabase.from('jimscanner_forwarder_content').select('*'),
  ])

  const forwarderList = (forwarders ?? []) as ForwarderRow[]
  const contentMap = new Map<string, ForwarderContent>()
  for (const c of (contents ?? []) as ForwarderContent[]) {
    contentMap.set(c.forwarder_id, c)
  }

  const publishedCount = Array.from(contentMap.values()).filter((c) => c.status === 'published').length
  const draftCount = Array.from(contentMap.values()).filter((c) => c.status === 'draft').length
  const noneCount = forwarderList.length - contentMap.size

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">콘텐츠 관리</h1>
        <p className="text-sm text-gray-500 mt-1">
          배대지별 상세 설명을 AI 초안으로 생성하고, 검토 후 발행합니다. 발행된 콘텐츠는{' '}
          <code className="text-xs bg-gray-100 px-1 rounded">/forwarders/[slug]</code>에 즉시 반영됩니다.
        </p>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="bg-white border rounded-lg p-4">
          <p className="text-xs text-gray-500">전체 배대지</p>
          <p className="text-2xl font-bold text-gray-900">{forwarderList.length}</p>
        </div>
        <div className="bg-white border rounded-lg p-4">
          <p className="text-xs text-gray-500">발행됨</p>
          <p className="text-2xl font-bold text-green-600">{publishedCount}</p>
        </div>
        <div className="bg-white border rounded-lg p-4">
          <p className="text-xs text-gray-500">드래프트</p>
          <p className="text-2xl font-bold text-amber-500">{draftCount}</p>
        </div>
        <div className="bg-white border rounded-lg p-4">
          <p className="text-xs text-gray-500">미작성</p>
          <p className="text-2xl font-bold text-gray-400">{noneCount}</p>
        </div>
      </div>

      <div className="bg-white border rounded-lg overflow-x-auto">
        <table className="w-full text-sm min-w-[720px]">
          <thead className="bg-gray-50 border-b">
            <tr>
              <th className="text-left px-4 py-2 text-xs font-semibold text-gray-600 uppercase">
                배대지
              </th>
              <th className="text-left px-4 py-2 text-xs font-semibold text-gray-600 uppercase">
                공식 사이트
              </th>
              <th className="text-left px-4 py-2 text-xs font-semibold text-gray-600 uppercase">
                상태
              </th>
              <th className="text-right px-4 py-2 text-xs font-semibold text-gray-600 uppercase">
                길이
              </th>
              <th className="text-left px-4 py-2 text-xs font-semibold text-gray-600 uppercase">
                마지막 수정
              </th>
              <th className="text-right px-4 py-2 text-xs font-semibold text-gray-600 uppercase">

              </th>
            </tr>
          </thead>
          <tbody>
            {forwarderList.map((f) => {
              const c = contentMap.get(f.id)
              const statusKey: ForwarderContentStatus | 'none' = c ? c.status : 'none'
              const meta = STATUS_LABELS[statusKey]
              const chars = c ? countContentChars(c) : 0
              const tooShort = c && chars < MIN_CONTENT_CHARS

              return (
                <tr key={f.id} className={`border-b last:border-b-0 ${!f.is_active ? 'opacity-50' : ''}`}>
                  <td className="px-4 py-2">
                    <div className="font-medium text-gray-900">{f.name}</div>
                    <div className="text-xs text-gray-500">{f.slug}</div>
                  </td>
                  <td className="px-4 py-2 text-xs">
                    {f.website ? (
                      <a
                        href={f.website}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-blue-600 hover:underline"
                      >
                        {f.website.replace(/^https?:\/\//, '').replace(/\/$/, '')}
                      </a>
                    ) : (
                      <span className="text-gray-400">—</span>
                    )}
                  </td>
                  <td className="px-4 py-2">
                    <Badge className={meta.className}>{meta.label}</Badge>
                  </td>
                  <td className="px-4 py-2 text-right font-mono text-xs">
                    {c ? (
                      <span className={tooShort ? 'text-amber-600' : 'text-gray-900'}>
                        {chars.toLocaleString()}자
                      </span>
                    ) : (
                      <span className="text-gray-300">—</span>
                    )}
                  </td>
                  <td className="px-4 py-2 text-xs text-gray-500 whitespace-nowrap">
                    {c
                      ? new Date(c.updated_at).toLocaleString('ko-KR', {
                          timeZone: 'Asia/Seoul',
                          month: '2-digit',
                          day: '2-digit',
                          hour: '2-digit',
                          minute: '2-digit',
                        })
                      : '—'}
                  </td>
                  <td className="px-4 py-2 text-right">
                    <Link
                      href={`/admin/content/${f.slug}`}
                      className="inline-block text-xs text-blue-600 hover:underline font-medium"
                    >
                      {c ? '편집' : '작성 시작'} →
                    </Link>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      <div className="bg-blue-50 border border-blue-100 rounded-lg p-4 text-xs text-blue-900 leading-relaxed">
        <p className="font-semibold mb-1">워크플로우</p>
        <ol className="list-decimal list-inside space-y-1">
          <li>편집 화면 진입 → &ldquo;AI 초안 생성&rdquo; 클릭</li>
          <li>공식 사이트에서 정보를 수집해 draft로 저장됩니다 (30초~1분 소요)</li>
          <li>각 섹션을 검토·수정 → &ldquo;발행&rdquo; 버튼 → 프론트 즉시 반영</li>
          <li>권장 최소 길이 {MIN_CONTENT_CHARS.toLocaleString()}자 (AdSense·SEO 기준)</li>
        </ol>
      </div>
    </div>
  )
}
