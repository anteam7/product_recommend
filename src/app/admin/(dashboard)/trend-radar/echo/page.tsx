import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

type EchoSummaryRow = {
  keyword: string
  collected_at: string | null
  kr_hits: number | null
  us_hits: number | null
  jp_hits: number | null
  echo_score: number | null
  recommended_window: string | null
}

type FilterKey = 'all' | 'fad' | 'sustained' | 'cross'

const SCORE_LABEL: Record<number, { label: string; tone: string }> = {
  0: { label: '0 · K-fad', tone: 'text-red-600' },
  1: { label: '1 · cross-border', tone: 'text-amber-600' },
  2: { label: '2 · global sustained', tone: 'text-emerald-600' },
  3: { label: '3 · 전지역', tone: 'text-emerald-700 font-semibold' },
}

async function fetchData() {
  const sb = createAdminClient()
  const adminSb = sb as unknown as {
    from: (t: string) => {
      select: (s: string) => {
        order: (
          c: string,
          o: { ascending: boolean; nullsFirst?: boolean },
        ) => {
          limit: (n: number) => Promise<{ data: EchoSummaryRow[] | null; error: unknown }>
        }
      }
    }
  }

  const { data: summary } = await adminSb
    .from('jimscanner_trends_echo_summary')
    .select(
      'keyword, collected_at, kr_hits, us_hits, jp_hits, echo_score, recommended_window',
    )
    .order('echo_score', { ascending: false, nullsFirst: false })
    .limit(200)

  return { rows: (summary ?? []) as EchoSummaryRow[] }
}

function applyFilter(rows: EchoSummaryRow[], filter: FilterKey): EchoSummaryRow[] {
  switch (filter) {
    case 'fad':
      return rows.filter((r) => (r.echo_score ?? 0) === 0)
    case 'cross':
      return rows.filter((r) => (r.echo_score ?? 0) === 1)
    case 'sustained':
      return rows.filter((r) => (r.echo_score ?? 0) >= 2)
    default:
      return rows
  }
}

export default async function EchoPage({
  searchParams,
}: {
  searchParams: Promise<{ filter?: string }>
}) {
  const sp = await searchParams
  const filter: FilterKey =
    sp?.filter === 'fad' || sp?.filter === 'sustained' || sp?.filter === 'cross'
      ? sp.filter
      : 'all'

  const { rows } = await fetchData()
  const filtered = applyFilter(rows, filter)

  const counts = {
    all: rows.length,
    fad: rows.filter((r) => (r.echo_score ?? 0) === 0).length,
    cross: rows.filter((r) => (r.echo_score ?? 0) === 1).length,
    sustained: rows.filter((r) => (r.echo_score ?? 0) >= 2).length,
  }

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold">Cross-Lingual Demand Echo</h1>
          <p className="text-sm text-gray-500 mt-1">
            한·영·일 동시 트렌드 게이트 — K-fad vs global sustained 분리.
            echo_score 가중치로 핀 priority 조정 가능.
          </p>
        </div>
        <Link
          href="/admin/trend-radar"
          className="text-sm text-gray-700 hover:text-black underline"
        >
          ← 대시보드
        </Link>
      </header>

      <div className="flex gap-2 text-sm">
        {(
          [
            { key: 'all', label: `전체 (${counts.all})` },
            { key: 'fad', label: `fad만 (${counts.fad})` },
            { key: 'cross', label: `cross-border (${counts.cross})` },
            { key: 'sustained', label: `sustained만 (${counts.sustained})` },
          ] as { key: FilterKey; label: string }[]
        ).map((f) => {
          const active = filter === f.key
          const href = f.key === 'all' ? '?' : `?filter=${f.key}`
          return (
            <Link
              key={f.key}
              href={href}
              className={`px-3 py-1.5 rounded border ${
                active
                  ? 'bg-black text-white border-black'
                  : 'bg-white border-gray-300 hover:border-gray-500'
              }`}
            >
              {f.label}
            </Link>
          )
        })}
      </div>

      {filtered.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500">
          <p className="text-base font-medium">데이터 없음</p>
          <p className="text-sm mt-2">
            아직 echo cron 이 돌지 않았거나 (또는 마이그레이션 미적용),
            현재 필터에 해당하는 키워드가 없습니다.
            <br />
            로컬 실행:{' '}
            <code className="bg-gray-100 px-1.5 py-0.5 rounded">
              node --env-file=.env.local scripts/trend-echo-cron.mjs
            </code>
          </p>
        </div>
      ) : (
        <div className="rounded border border-gray-200 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-gray-500 text-xs">
              <tr>
                <th className="px-3 py-2 text-left">키워드</th>
                <th className="px-3 py-2 text-right">KR</th>
                <th className="px-3 py-2 text-right">US</th>
                <th className="px-3 py-2 text-right">JP</th>
                <th className="px-3 py-2 text-left">echo_score</th>
                <th className="px-3 py-2 text-left">권장 진입</th>
                <th className="px-3 py-2 text-right">collected_at</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {filtered.map((r) => {
                const score = r.echo_score ?? 0
                const tone = SCORE_LABEL[score]?.tone ?? 'text-gray-500'
                const label = SCORE_LABEL[score]?.label ?? `${score}`
                return (
                  <tr key={r.keyword}>
                    <td className="px-3 py-2 font-medium">{r.keyword}</td>
                    <td className="px-3 py-2 text-right font-mono text-gray-700">
                      {r.kr_hits ?? 0}
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-gray-700">
                      {r.us_hits ?? 0}
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-gray-700">
                      {r.jp_hits ?? 0}
                    </td>
                    <td className={`px-3 py-2 ${tone}`}>{label}</td>
                    <td className="px-3 py-2 text-gray-600">{r.recommended_window ?? '—'}</td>
                    <td className="px-3 py-2 text-right text-xs text-gray-400 font-mono">
                      {r.collected_at?.slice(5, 16) ?? '—'}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      <section className="rounded border border-dashed border-gray-300 p-4 text-xs text-gray-500 leading-relaxed">
        <strong className="text-gray-700">scoring 규칙:</strong>{' '}
        kr≥5 게이트 통과 후 us≥8(+reddit/amazon) 또는 jp≥5 이면 인접국 폭증으로 가산.{' '}
        0=한국 단발(K-fad, 위탁 비추천), 1=cross-border(인접국 1개 폭증, 7일 단기 진입),
        2=global sustained(KR+US, 30일 안정 진입), 3=전지역(KR+US+JP, 60일+ 본격 진입).{' '}
        cron 은 hourly 권장 — Vercel Hobby 한도 초과 시{' '}
        <code className="bg-gray-100 px-1 py-0.5 rounded">scripts/run-crons.mjs</code> 에 등록.
      </section>
    </div>
  )
}
