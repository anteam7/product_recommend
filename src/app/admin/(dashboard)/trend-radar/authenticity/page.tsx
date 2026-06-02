import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import AuthenticityBoard, { type Candidate } from './AuthenticityBoard'

export const dynamic = 'force-dynamic'

async function fetchCandidates(): Promise<Candidate[]> {
  const sb = createAdminClient()
  // astroturf_score >= 30 후보만 (잡음 제거). RPC 가 4피처 가중합 반환.
  const { data, error } = await sb.rpc(
    'jimscanner_trends_astroturf_scores' as never,
    { p_min_score: 30 } as never,
  )
  if (error) {
    console.error('[astroturf-scores]', error.message)
    return []
  }
  return (data ?? []) as Candidate[]
}

export default async function AuthenticityPage() {
  const candidates = await fetchCandidates()

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold">🛡 진위 게이트 — 인위적 동시버스트 탐지</h1>
          <p className="mt-1 max-w-3xl text-sm text-gray-500">
            여러 커뮤니티(뽐뿌·디시·82쿡·네판·클리앙·퀘이사·블로그)에 <b>짧은 창 안에 같은 문구로 동시
            등장</b>한 키워드는 수요 확증이 아니라 협찬·뒷광고·바이럴 푸시일 수 있습니다. 동시성·문구
            유사도·유기신호 미확증·무램프 급발진을 합산한 <b>astroturf_score</b>가 높을수록 소싱 함정 의심.
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 underline hover:text-black">
          ← 대시보드
        </Link>
      </header>

      {candidates.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500">
          의심 후보 없음. 커뮤니티 cron 누적 후 다시 방문하거나, SQL 마이그레이션
          (<code>supabase/trends_v4_astroturf.sql</code>) 적용 여부를 확인하세요.
        </div>
      ) : (
        <AuthenticityBoard candidates={candidates} />
      )}
    </div>
  )
}
