import { createAdminClient } from '@/lib/auth/admin-supabase'
import RunCheckButton from './RunCheckButton'
import ResultsTable, { type ResultRow, type ExtractedRate } from './ResultsTable'

export const dynamic = 'force-dynamic'

type Run = {
  id: string
  triggered_by: string
  started_at: string
  completed_at: string | null
  total_forwarders: number | null
  changed_count: number | null // 재활용: 추출 성공 배대지 수
  no_change_count: number | null // 재활용: 요금 없음 배대지 수
  error_count: number | null
  skipped_count: number | null
}

type RawResult = {
  id: string
  run_id: string
  forwarder_id: string
  forwarder_slug: string
  forwarder_name: string
  status: string
  extracted_rates: ExtractedRate[] | null
  extracted_count: number | null
  ai_summary: string | null
  page_url: string | null
  error_message: string | null
  applied_at: string | null
  applied_by: string | null
  checked_at: string
}

function formatKST(iso: string) {
  return new Date(iso).toLocaleString('ko-KR', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export default async function RateChecksPage() {
  const admin = createAdminClient()

  const [runsRes, resultsRes, fwdRes, dbCountsRes] = await Promise.all([
    admin
      .from('jimscanner_rate_check_runs')
      .select('*')
      .order('started_at', { ascending: false })
      .limit(10),
    admin
      .from('jimscanner_rate_check_results')
      .select('*')
      .order('checked_at', { ascending: false })
      .limit(200),
    admin
      .from('forwarders')
      .select('id, slug, name, rate_page_url, is_active')
      .eq('is_active', true),
    admin.from('shipping_rates').select('forwarder_id'),
  ])

  const runs = (runsRes.data ?? []) as Run[]
  const allResults = (resultsRes.data ?? []) as RawResult[]
  const forwarders = (fwdRes.data ?? []) as Array<{
    id: string
    rate_page_url: string | null
  }>
  const dbCountRows = (dbCountsRes.data ?? []) as Array<{ forwarder_id: string }>

  const dbCountByFwd = new Map<string, number>()
  for (const r of dbCountRows) {
    dbCountByFwd.set(r.forwarder_id, (dbCountByFwd.get(r.forwarder_id) ?? 0) + 1)
  }

  const latestRun = runs[0] ?? null
  const latestResults: ResultRow[] = latestRun
    ? allResults
        .filter((r) => r.run_id === latestRun.id)
        .map((r) => ({
          id: r.id,
          run_id: r.run_id,
          forwarder_id: r.forwarder_id,
          forwarder_slug: r.forwarder_slug,
          forwarder_name: r.forwarder_name,
          status: r.status,
          extracted_rates: r.extracted_rates,
          extracted_count: r.extracted_count ?? 0,
          ai_summary: r.ai_summary,
          page_url: r.page_url,
          error_message: r.error_message,
          applied_at: r.applied_at,
          applied_by: r.applied_by,
          checked_at: r.checked_at,
          db_rate_count: dbCountByFwd.get(r.forwarder_id) ?? 0,
        }))
    : []

  const totalExtractedRates = latestResults.reduce((s, r) => s + r.extracted_count, 0)
  const registered = forwarders.filter((f) => f.rate_page_url && f.rate_page_url.trim() !== '').length
  const missing = forwarders.length - registered

  return (
    <div className="space-y-8">
      <div className="flex items-start justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">요금 추출 · DB 반영</h1>
          <p className="text-sm text-gray-500 mt-1">
            각 배대지의 요금 페이지를 AI(Gemini 2.5 Flash)로 스캔해 <strong>구조화 추출</strong> →
            운영자가 검수 후 shipping_rates 에 반영.
          </p>
        </div>
        <RunCheckButton />
      </div>

      {/* 등록 현황 */}
      <section className="grid sm:grid-cols-3 gap-4">
        <div className="bg-white border rounded-lg p-4">
          <p className="text-xs text-gray-500 uppercase">rate_page_url 등록</p>
          <p className="mt-1 text-2xl font-bold text-gray-900">
            {registered}{' '}
            <span className="text-sm font-normal text-gray-500">/ {forwarders.length}곳</span>
          </p>
          {missing > 0 && (
            <p className="text-xs text-amber-700 mt-1">{missing}곳 미등록 → &apos;생략&apos; 처리</p>
          )}
        </div>
        {latestRun && (
          <>
            <div className="bg-white border rounded-lg p-4">
              <p className="text-xs text-gray-500 uppercase">마지막 스캔</p>
              <p className="mt-1 text-sm text-gray-900">{formatKST(latestRun.started_at)}</p>
              <p className="text-xs text-gray-600 mt-1">
                추출 <span className="text-green-700 font-semibold">{latestRun.changed_count ?? 0}</span>
                곳 · 요금 없음 {latestRun.no_change_count ?? 0} · 오류 {latestRun.error_count ?? 0} · 생략{' '}
                {latestRun.skipped_count ?? 0}
              </p>
            </div>
            <div className="bg-white border rounded-lg p-4">
              <p className="text-xs text-gray-500 uppercase">총 추출 rows</p>
              <p className="mt-1 text-2xl font-bold text-green-700 tabular-nums">
                {totalExtractedRates.toLocaleString('ko-KR')}
              </p>
              <p className="text-xs text-gray-500 mt-1">이 run 에서 AI 가 파싱한 요금 행 총합</p>
            </div>
          </>
        )}
      </section>

      {/* 최신 run 상세 */}
      <section>
        <h2 className="text-lg font-semibold text-gray-900 mb-4">
          {latestRun ? '최신 스캔 결과' : '아직 스캔 이력 없음'}
        </h2>
        {!latestRun ? (
          <div className="text-sm text-gray-500 bg-white border rounded-lg p-6 text-center">
            &quot;지금 스캔&quot; 을 눌러 첫 스캔을 실행하세요. rate_page_url 등록된 배대지만 AI 추출이
            진행됩니다.
          </div>
        ) : latestResults.length === 0 ? (
          <div className="text-sm text-gray-500 bg-white border rounded-lg p-6 text-center">
            이 run 에 저장된 결과가 없습니다.
          </div>
        ) : (
          <ResultsTable rows={latestResults} />
        )}
      </section>

      {/* 이력 */}
      {runs.length > 1 && (
        <section>
          <h2 className="text-lg font-semibold text-gray-900 mb-4">최근 10회 실행 이력</h2>
          <div className="bg-white border rounded-lg overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b">
                <tr>
                  <th className="text-left px-4 py-2 text-xs font-semibold text-gray-600 uppercase">
                    시작 (KST)
                  </th>
                  <th className="text-left px-4 py-2 text-xs font-semibold text-gray-600 uppercase">
                    트리거
                  </th>
                  <th className="text-right px-4 py-2 text-xs font-semibold text-gray-600 uppercase">총</th>
                  <th className="text-right px-4 py-2 text-xs font-semibold text-gray-600 uppercase">
                    추출
                  </th>
                  <th className="text-right px-4 py-2 text-xs font-semibold text-gray-600 uppercase">
                    요금없음
                  </th>
                  <th className="text-right px-4 py-2 text-xs font-semibold text-gray-600 uppercase">
                    오류
                  </th>
                  <th className="text-right px-4 py-2 text-xs font-semibold text-gray-600 uppercase">
                    생략
                  </th>
                </tr>
              </thead>
              <tbody>
                {runs.map((r) => (
                  <tr key={r.id} className="border-b last:border-b-0">
                    <td className="px-4 py-2 text-xs text-gray-700 whitespace-nowrap">
                      {formatKST(r.started_at)}
                    </td>
                    <td className="px-4 py-2 text-xs text-gray-600 whitespace-nowrap">
                      {r.triggered_by}
                    </td>
                    <td className="px-4 py-2 text-right">{r.total_forwarders ?? '—'}</td>
                    <td className="px-4 py-2 text-right text-green-700 font-semibold">
                      {r.changed_count ?? 0}
                    </td>
                    <td className="px-4 py-2 text-right text-amber-700">{r.no_change_count ?? 0}</td>
                    <td className="px-4 py-2 text-right text-red-700">{r.error_count ?? 0}</td>
                    <td className="px-4 py-2 text-right text-gray-500">{r.skipped_count ?? 0}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <div className="bg-blue-50 border border-blue-100 rounded-lg p-4 text-xs text-blue-900 leading-relaxed">
        <p className="font-semibold mb-1">사용 방법</p>
        <ol className="list-decimal pl-4 space-y-0.5">
          <li>&quot;지금 스캔&quot; 클릭 → AI 가 각 배대지의 요금 페이지에서 요금을 추출.</li>
          <li>결과 표에서 &quot;미리보기&quot; 로 추출 샘플 확인. 커버리지(추출/DB 비율) 가 낮으면 주의.</li>
          <li>문제없어 보이면 &quot;반영&quot; 버튼 클릭 → 해당 배대지의 shipping_rates 교체.</li>
        </ol>
        <p className="mt-2 text-[11px] text-blue-800">
          반영은 forwarder 단위로 기존 shipping_rates 전체를 추출본으로 교체하므로, 적용 전 반드시
          검수가 필요합니다.
        </p>
      </div>
    </div>
  )
}
