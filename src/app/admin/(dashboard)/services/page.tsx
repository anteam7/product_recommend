import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

export default async function ServicesListPage() {
  const supabase = createAdminClient()

  const [{ data: forwarders }, { data: services }] = await Promise.all([
    supabase.from('forwarders').select('id, name, slug, is_active').order('name'),
    supabase.from('forwarder_additional_services').select('forwarder_id, category, updated_at'),
  ])

  const fwdList = forwarders ?? []
  const svcList = services ?? []

  const stats = new Map<
    string,
    { count: number; categories: Set<string>; lastUpdated: string | null }
  >()
  for (const f of fwdList) {
    stats.set(f.id, { count: 0, categories: new Set(), lastUpdated: null })
  }
  for (const s of svcList) {
    if (!s.forwarder_id) continue
    const st = stats.get(s.forwarder_id)
    if (!st) continue
    st.count++
    if (s.category) st.categories.add(s.category)
    if (s.updated_at && (!st.lastUpdated || s.updated_at > st.lastUpdated)) {
      st.lastUpdated = s.updated_at
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">부가서비스 관리</h1>
        <p className="text-sm text-gray-500 mt-1">
          각 배대지의 검수·포장·통관·반송 등 부가서비스를 등록/수정합니다. 저장 시{' '}
          <code className="text-xs bg-gray-100 px-1 rounded">/forwarders/[slug]</code>에 즉시 반영됩니다.
        </p>
      </div>

      <div className="bg-white border rounded-lg overflow-x-auto">
        <table className="w-full text-sm min-w-[720px]">
          <thead className="bg-gray-50 border-b">
            <tr>
              <th className="text-left px-4 py-2 text-xs font-semibold text-gray-600 uppercase">배대지</th>
              <th className="text-right px-4 py-2 text-xs font-semibold text-gray-600 uppercase">서비스 수</th>
              <th className="text-left px-4 py-2 text-xs font-semibold text-gray-600 uppercase">카테고리</th>
              <th className="text-left px-4 py-2 text-xs font-semibold text-gray-600 uppercase">마지막 수정</th>
              <th className="text-right px-4 py-2 text-xs font-semibold text-gray-600 uppercase"></th>
            </tr>
          </thead>
          <tbody>
            {fwdList.map((f) => {
              const s = stats.get(f.id)!
              return (
                <tr key={f.id} className={`border-b last:border-b-0 ${!f.is_active ? 'opacity-50' : ''}`}>
                  <td className="px-4 py-2">
                    <div className="font-medium text-gray-900">{f.name}</div>
                    <div className="text-xs text-gray-500">{f.slug}</div>
                  </td>
                  <td className="px-4 py-2 text-right font-mono text-xs">
                    {s.count === 0 ? <span className="text-gray-300">0</span> : s.count}
                  </td>
                  <td className="px-4 py-2 text-xs">
                    {s.categories.size === 0 ? (
                      <span className="text-gray-300">—</span>
                    ) : (
                      Array.from(s.categories).sort().join(', ')
                    )}
                  </td>
                  <td className="px-4 py-2 text-xs text-gray-500 whitespace-nowrap">
                    {s.lastUpdated
                      ? new Date(s.lastUpdated).toLocaleString('ko-KR', {
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
                      href={`/admin/services/${f.slug}`}
                      className="text-xs text-blue-600 hover:underline font-medium"
                    >
                      편집 →
                    </Link>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      <div className="bg-blue-50 border border-blue-100 rounded-lg p-4 text-xs text-blue-900 leading-relaxed">
        <p className="font-semibold mb-1">편집 방식</p>
        <ul className="list-disc list-inside space-y-0.5">
          <li>카테고리별로 묶어 노출. 각 셀 클릭하면 인라인 편집.</li>
          <li>값 변경 후 포커스 떠나면 자동 저장 (약 500ms 후).</li>
          <li>행 추가/삭제는 각 카테고리 아래 버튼으로.</li>
          <li>가격은 원문(예: &ldquo;3,500원/박스&rdquo;)을 입력. 저장 시 숫자·통화 자동 추출.</li>
        </ul>
      </div>
    </div>
  )
}
