import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

interface CompanionRow {
  seed_id: string
  seed_name: string
  seed_score: number | null
  candidate_id: string
  candidate_name: string
  candidate_brand: string | null
  candidate_category_top: string | null
  candidate_category_mid: string | null
  candidate_intent_label: string | null
  candidate_score: number | null
  candidate_has_ggsan: boolean
  co_count: number
  pmi: number
  jaccard: number
  sample_title: string | null
  sample_url: string | null
  last_co_at: string | null
}

async function fetchCompanions() {
  const sb = createAdminClient()
  const { data, error } = await (sb as any)
    .from('jimscanner_trends_companions')
    .select('*')
    .eq('candidate_has_ggsan', false)
    .gte('seed_score', 40)
    .gte('co_count', 2)
    .order('pmi', { ascending: false })
    .limit(100)

  if (error) {
    return { rows: [] as CompanionRow[], error: error.message }
  }
  return { rows: (data ?? []) as CompanionRow[], error: null }
}

export default async function CompanionsBoardPage() {
  const { rows, error } = await fetchCompanions()

  return (
    <div className="space-y-4 p-6">
      <header>
        <h1 className="text-2xl font-bold">인접 발굴 (Companion Whitespace)</h1>
        <p className="text-sm text-gray-500 mt-1">
          score ≥ 40 인 상품과 같은 문서에 자주 등장하지만 ggsan 도매몰에는 아직 매칭되지 않은
          상품 후보. PMI 내림차순.
        </p>
      </header>

      {error && (
        <div className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          쿼리 실패: {error}
          <br />
          <span className="text-xs">
            (matview 가 아직 REFRESH 되지 않았을 수 있음 — scripts/refresh-cooccurrence.mjs --first
            실행 필요)
          </span>
        </div>
      )}

      {rows.length === 0 && !error ? (
        <p className="text-sm text-gray-400">현재 노출할 화이트스페이스 후보가 없습니다.</p>
      ) : (
        <div className="rounded border border-gray-200 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-gray-500 text-xs uppercase">
              <tr>
                <th className="px-3 py-2 text-left">시드 상품 (score)</th>
                <th className="px-3 py-2 text-left">→ 인접 후보 (미매칭)</th>
                <th className="px-3 py-2 text-left">카테고리 / brand</th>
                <th className="px-3 py-2 text-right">PMI</th>
                <th className="px-3 py-2 text-right">co</th>
                <th className="px-3 py-2 text-right">jaccard</th>
                <th className="px-3 py-2 text-right">cand score</th>
                <th className="px-3 py-2 text-left">대표 문서</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {rows.map((r, i) => (
                <tr key={`${r.seed_id}-${r.candidate_id}-${i}`} className="hover:bg-amber-50/40">
                  <td className="px-3 py-2">
                    <Link
                      href={`/admin/trend-radar/products/${r.seed_id}`}
                      className="hover:underline"
                    >
                      {r.seed_name}
                    </Link>
                    <span className="ml-1 text-[10px] font-mono text-gray-500">
                      ({r.seed_score != null ? Math.round(r.seed_score) : '—'})
                    </span>
                  </td>
                  <td className="px-3 py-2">
                    <Link
                      href={`/admin/trend-radar/products/${r.candidate_id}`}
                      className="font-medium hover:underline"
                    >
                      {r.candidate_name}
                    </Link>
                    {r.candidate_intent_label && (
                      <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-700">
                        {r.candidate_intent_label}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-xs text-gray-500">
                    {r.candidate_category_top}
                    {r.candidate_category_mid ? ` / ${r.candidate_category_mid}` : ''}
                    {r.candidate_brand ? ` · ${r.candidate_brand}` : ''}
                  </td>
                  <td className="px-3 py-2 text-right font-mono font-bold">
                    {Number(r.pmi).toFixed(2)}
                  </td>
                  <td className="px-3 py-2 text-right font-mono">{r.co_count}</td>
                  <td className="px-3 py-2 text-right font-mono">
                    {Number(r.jaccard).toFixed(3)}
                  </td>
                  <td className="px-3 py-2 text-right font-mono">
                    {r.candidate_score != null ? Math.round(r.candidate_score) : '—'}
                  </td>
                  <td className="px-3 py-2 text-xs text-gray-500 max-w-xs truncate italic">
                    {r.sample_url ? (
                      <a
                        href={r.sample_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="hover:underline"
                      >
                        “{r.sample_title ?? r.sample_url}”
                      </a>
                    ) : (
                      <>“{r.sample_title ?? '—'}”</>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="text-[11px] text-gray-400">
        데이터 갱신: nightly cron — <code>node scripts/refresh-cooccurrence.mjs</code> (matview
        REFRESH).
      </p>
    </div>
  )
}
