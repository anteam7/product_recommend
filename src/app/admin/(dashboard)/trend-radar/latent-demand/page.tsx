import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import LatentDemandActions from './LatentDemandActions'

export const dynamic = 'force-dynamic'

interface RankedRow {
  noun: string
  question_count: number
  unanswered_rate: number | null
  last7d: number
  prev23d: number
  acceleration: number | null
  latent_score: number | null
  last_seen: string
  mapping_status: string | null
  mapped_product_id_text: string | null
}

interface QuestionRow {
  id: string
  raw_text: string
  source_url: string | null
  extracted_noun: string | null
  extracted_need: string | null
  answer_count: number
  age_days: number
  mapping_status: string
  captured_at: string
  mapped_product_id: string | null
}

async function fetchData() {
  const sb = createAdminClient()

  // types/supabase.ts 에 아직 없는 테이블/뷰 — as any 캐스팅
  const [rankedRes, recentRes, pendingRes] = await Promise.all([
    (sb as any)
      .from('v_latent_demand_ranked')
      .select('*')
      .limit(100),
    (sb as any)
      .from('jimscanner_trends_latent_questions')
      .select(
        'id, raw_text, source_url, extracted_noun, extracted_need, answer_count, age_days, mapping_status, captured_at, mapped_product_id',
      )
      .order('captured_at', { ascending: false })
      .limit(50),
    (sb as any)
      .from('jimscanner_trends_latent_questions')
      .select('id', { count: 'exact', head: true })
      .eq('mapping_status', 'pending'),
  ])

  return {
    ranked: ((rankedRes.data ?? []) as RankedRow[]),
    recent: ((recentRes.data ?? []) as QuestionRow[]),
    pendingCount: (pendingRes.count as number | null) ?? 0,
    error: rankedRes.error?.message || recentRes.error?.message || null,
  }
}

function pct(n: number | null): string {
  if (n == null) return '—'
  return `${Math.round(n * 100)}%`
}

function fmtScore(n: number | null): string {
  if (n == null) return '—'
  return n.toFixed(2)
}

function fmtAccel(n: number | null): string {
  if (n == null) return '—'
  if (n >= 999) return '∞ (신규)'
  return `${n.toFixed(2)}x`
}

function StatusBadge({ status }: { status: string | null }) {
  const map: Record<string, { bg: string; fg: string; label: string }> = {
    pending: { bg: 'bg-gray-100', fg: 'text-gray-700', label: 'pending' },
    mapped: { bg: 'bg-green-100', fg: 'text-green-800', label: 'mapped' },
    new_candidate: { bg: 'bg-amber-100', fg: 'text-amber-800', label: 'new' },
    noise: { bg: 'bg-red-50', fg: 'text-red-500', label: 'noise' },
  }
  const s = map[status ?? 'pending'] ?? map.pending
  return (
    <span className={`inline-block rounded px-2 py-0.5 text-xs ${s.bg} ${s.fg}`}>{s.label}</span>
  )
}

export default async function LatentDemandPage() {
  const { ranked, recent, pendingCount, error } = await fetchData()

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold">Latent Demand (지식인 Q&amp;A)</h1>
          <p className="text-sm text-gray-500 mt-1">
            답변 없는 쇼핑 의도 질문 = 공급 갭 + 표출된 구매 의도. 빈도 × 부재율 × 30일 가속도 정렬.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs text-gray-500">
            LLM 추출 대기: <strong className="text-gray-700">{pendingCount}</strong>
          </span>
          <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
            ← 대시보드
          </Link>
        </div>
      </header>

      {error && (
        <div className="rounded border border-red-200 bg-red-50 p-3 text-xs text-red-700">
          <strong>DB 오류:</strong> {error} — supabase/trends_qna.sql 마이그레이션 미적용일 수 있음.
        </div>
      )}

      <section>
        <h2 className="text-sm font-semibold text-gray-700 mb-2">상위 latent noun (최근 30일)</h2>
        <div className="rounded border border-gray-200 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-gray-500 text-xs">
              <tr>
                <th className="px-3 py-2 text-left">noun</th>
                <th className="px-3 py-2 text-right">질문수</th>
                <th className="px-3 py-2 text-right">미응답률</th>
                <th className="px-3 py-2 text-right">7d / prev23d</th>
                <th className="px-3 py-2 text-right">가속도</th>
                <th className="px-3 py-2 text-right">latent score</th>
                <th className="px-3 py-2 text-left">상태</th>
                <th className="px-3 py-2 text-left">액션</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {ranked.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-3 py-8 text-center text-gray-400">
                    아직 데이터 없음. cron 누적 + LLM 추출 후 다시 방문.
                  </td>
                </tr>
              ) : (
                ranked.map((r) => (
                  <tr key={r.noun}>
                    <td className="px-3 py-2 font-mono text-gray-800">
                      {r.noun === '__unmapped__' ? (
                        <span className="text-gray-400 italic">미추출</span>
                      ) : (
                        r.noun
                      )}
                    </td>
                    <td className="px-3 py-2 text-right">{r.question_count}</td>
                    <td className="px-3 py-2 text-right">{pct(r.unanswered_rate)}</td>
                    <td className="px-3 py-2 text-right text-gray-500">
                      {r.last7d} / {r.prev23d}
                    </td>
                    <td className="px-3 py-2 text-right">{fmtAccel(r.acceleration)}</td>
                    <td className="px-3 py-2 text-right font-semibold">{fmtScore(r.latent_score)}</td>
                    <td className="px-3 py-2">
                      <StatusBadge status={r.mapping_status} />
                    </td>
                    <td className="px-3 py-2">
                      <LatentDemandActions
                        noun={r.noun}
                        mapped={!!r.mapped_product_id_text}
                      />
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <h2 className="text-sm font-semibold text-gray-700 mb-2">최근 50 질문 원본</h2>
        <div className="rounded border border-gray-200 divide-y divide-gray-100">
          {recent.length === 0 ? (
            <div className="px-3 py-8 text-center text-gray-400 text-sm">
              아직 수집된 질문 없음.
            </div>
          ) : (
            recent.map((q) => (
              <div key={q.id} className="px-3 py-2 text-sm grid grid-cols-12 gap-2 items-start">
                <div className="col-span-7">
                  {q.source_url ? (
                    <a
                      href={q.source_url}
                      target="_blank"
                      rel="noreferrer"
                      className="text-gray-800 hover:underline"
                    >
                      {q.raw_text.slice(0, 160)}
                    </a>
                  ) : (
                    <span className="text-gray-800">{q.raw_text.slice(0, 160)}</span>
                  )}
                </div>
                <div className="col-span-2 text-xs text-gray-500">
                  {q.extracted_noun ? (
                    <>
                      <span className="font-mono">{q.extracted_noun}</span>
                      {q.extracted_need ? (
                        <span className="text-gray-400"> / {q.extracted_need}</span>
                      ) : null}
                    </>
                  ) : (
                    <span className="text-gray-300 italic">미추출</span>
                  )}
                </div>
                <div className="col-span-1 text-right text-xs text-gray-500">
                  답변 {q.answer_count}
                </div>
                <div className="col-span-1 text-right text-xs text-gray-500">
                  {q.age_days}d
                </div>
                <div className="col-span-1 text-right">
                  <StatusBadge status={q.mapping_status} />
                </div>
              </div>
            ))
          )}
        </div>
      </section>

      <section className="rounded border border-dashed border-gray-300 p-4 text-xs text-gray-500">
        <strong className="text-gray-700">파이프라인:</strong>{' '}
        <code>scripts/scout-knowledge-qna.mjs</code>{' '}
        → <code>/api/cron/collect-naver-kin</code> 1일 1회 → market_raw(source=
        <code>naver_kin</code>) 적재 → <code>jimscanner_trends_latent_questions</code>{' '}
        pending 큐 → LLM 추출 routine 이 noun + need 채움 → canonical
        product 매핑 시도, 실패 시 <code>new_candidate</code> 로 분리.
      </section>
    </div>
  )
}
