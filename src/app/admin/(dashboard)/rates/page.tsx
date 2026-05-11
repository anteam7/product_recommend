import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

const COUNTRY_FLAGS: Record<string, string> = { US: '🇺🇸', JP: '🇯🇵', CN: '🇨🇳', EU: '🇪🇺' }

export default async function RatesListPage() {
  const supabase = createAdminClient()

  const [{ data: forwarders }, { data: rates }, { data: centers }, { data: grades }] = await Promise.all([
    supabase
      .from('forwarders')
      .select('id, name, slug, is_active')
      .order('name'),
    supabase
      .from('shipping_rates')
      .select('forwarder_id, country, updated_at'),
    supabase
      .from('centers')
      .select('forwarder_id'),
    supabase
      .from('member_grade_definitions')
      .select('forwarder_id'),
  ])

  const fwdList = forwarders ?? []
  const rateList = rates ?? []
  const centerList = centers ?? []
  const gradeList = grades ?? []

  const stats = new Map<string, { countries: Set<string>; count: number; lastUpdated: string | null; centerCount: number; gradeCount: number }>()
  for (const f of fwdList) {
    stats.set(f.id, { countries: new Set(), count: 0, lastUpdated: null, centerCount: 0, gradeCount: 0 })
  }
  for (const r of rateList) {
    if (!r.forwarder_id) continue
    const s = stats.get(r.forwarder_id)
    if (!s) continue
    s.countries.add(r.country)
    s.count++
    if (r.updated_at && (!s.lastUpdated || r.updated_at > s.lastUpdated)) {
      s.lastUpdated = r.updated_at
    }
  }
  for (const c of centerList) {
    if (!c.forwarder_id) continue
    const s = stats.get(c.forwarder_id)
    if (s) s.centerCount++
  }
  for (const g of gradeList) {
    if (!g.forwarder_id) continue
    const s = stats.get(g.forwarder_id)
    if (s) s.gradeCount++
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">요금 관리</h1>
        <p className="text-sm text-gray-500 mt-1">
          각 배대지의 무게 구간별 배송비를 인라인으로 편집합니다. 저장 시 자동으로 프론트에 반영됩니다.
        </p>
      </div>

      <div className="bg-white border rounded-lg overflow-x-auto">
        <table className="w-full text-sm min-w-[720px]">
          <thead className="bg-gray-50 border-b">
            <tr>
              <th className="text-left px-4 py-2 text-xs font-semibold text-gray-600 uppercase">배대지</th>
              <th className="text-left px-4 py-2 text-xs font-semibold text-gray-600 uppercase">커버 국가</th>
              <th className="text-right px-4 py-2 text-xs font-semibold text-gray-600 uppercase">요금 행수</th>
              <th className="text-right px-4 py-2 text-xs font-semibold text-gray-600 uppercase">센터</th>
              <th className="text-right px-4 py-2 text-xs font-semibold text-gray-600 uppercase">등급</th>
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
                  <td className="px-4 py-2 text-sm">
                    {Array.from(s.countries).sort().map((c) => (
                      <span key={c} className="mr-1" title={c}>
                        {COUNTRY_FLAGS[c] || c}
                      </span>
                    ))}
                    {s.countries.size === 0 && <span className="text-gray-300">—</span>}
                  </td>
                  <td className="px-4 py-2 text-right font-mono text-xs">
                    {s.count === 0 ? <span className="text-gray-300">0</span> : s.count}
                  </td>
                  <td className="px-4 py-2 text-right font-mono text-xs">{s.centerCount}</td>
                  <td className="px-4 py-2 text-right font-mono text-xs">{s.gradeCount}</td>
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
                      href={`/admin/rates/${f.slug}`}
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
          <li>각 셀을 클릭하면 바로 편집 가능합니다.</li>
          <li>값 변경 후 포커스를 떠나면 자동 저장 (약 500ms 후).</li>
          <li>저장 성공 시 녹색 체크, 실패 시 빨간 경고가 셀 우측에 잠깐 표시됩니다.</li>
          <li>행 추가/삭제는 각 국가 탭의 하단/우측 버튼으로 처리.</li>
        </ul>
      </div>
    </div>
  )
}
