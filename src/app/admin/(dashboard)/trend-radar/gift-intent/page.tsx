import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

interface GiftIntentRow {
  keyword: string
  gift_share: number
  occasion_breakdown: Record<string, number>
  sample_count: number
  computed_at: string
}

// 이벤트 캘린더 (KST 기준 주요 occasion D-day 계산용).
// 월/일 (1-indexed). 동일 연도에 이미 지났으면 다음 해로 자동 롤오버.
const OCCASION_CALENDAR: Array<{ key: string; label: string; month: number; day: number }> = [
  { key: '발렌타인', label: '발렌타인데이', month: 2, day: 14 },
  { key: '화이트데이', label: '화이트데이', month: 3, day: 14 },
  { key: '졸업', label: '졸업 시즌', month: 2, day: 1 },
  { key: '입학', label: '입학 시즌', month: 3, day: 2 },
  { key: '어버이날', label: '어버이날', month: 5, day: 8 },
  { key: '빼빼로데이', label: '빼빼로데이', month: 11, day: 11 },
  { key: '집들이', label: '집들이 시즌 (이사철)', month: 3, day: 15 },
  { key: '생일', label: '생일 (연중)', month: 0, day: 0 },
  { key: '돌잔치', label: '돌잔치 (연중)', month: 0, day: 0 },
  { key: '웨딩', label: '웨딩 시즌', month: 5, day: 1 },
  { key: '선물', label: '선물 일반 (연중)', month: 0, day: 0 },
  { key: '기념일', label: '기념일 일반 (연중)', month: 0, day: 0 },
]

function ddayFromNow(month: number, day: number): number | null {
  if (month === 0 || day === 0) return null
  const now = new Date()
  let target = new Date(now.getFullYear(), month - 1, day)
  if (target.getTime() < now.getTime() - 86400000) {
    target = new Date(now.getFullYear() + 1, month - 1, day)
  }
  return Math.round((target.getTime() - now.getTime()) / 86400000)
}

async function fetchData(): Promise<{ rows: GiftIntentRow[]; computedAt: string | null }> {
  const sb = createAdminClient()

  // 최신 snapshot 만 (keyword 별 latest)
  const { data } = await (sb as any)
    .from('jimscanner_gift_intent_scores')
    .select('keyword, gift_share, occasion_breakdown, sample_count, computed_at')
    .order('computed_at', { ascending: false })
    .limit(2000)

  const seen = new Set<string>()
  const latest: GiftIntentRow[] = []
  for (const r of (data ?? []) as GiftIntentRow[]) {
    if (seen.has(r.keyword)) continue
    seen.add(r.keyword)
    latest.push(r)
  }
  latest.sort((a, b) => b.gift_share - a.gift_share)
  return {
    rows: latest,
    computedAt: latest[0]?.computed_at ?? null,
  }
}

function premiumRange(giftShare: number): string {
  const lo = (giftShare * 15).toFixed(1)
  const hi = (giftShare * 30).toFixed(1)
  return `+${lo}% ~ +${hi}%`
}

export default async function GiftIntentPage() {
  const { rows, computedAt } = await fetchData()

  const upcoming = OCCASION_CALENDAR
    .map((o) => ({ ...o, dday: ddayFromNow(o.month, o.day) }))
    .filter((o) => o.dday !== null)
    .sort((a, b) => (a.dday! - b.dday!))

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold">Gift Intent 마진 윈도우</h1>
          <p className="text-sm text-gray-500 mt-1">
            선물·기념일 인텐트 비중 (gift_share) 기준 핀 후보. occasion breakdown + D-day + 마진 프리미엄 추천치.
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      {/* 이벤트 캘린더 D-day 오버레이 */}
      <section className="rounded border border-gray-200 p-4">
        <h2 className="text-sm font-semibold mb-3">📅 이벤트 캘린더 D-day</h2>
        <div className="flex flex-wrap gap-2 text-xs">
          {upcoming.map((o) => (
            <span
              key={o.key}
              className={`px-2 py-1 rounded border ${
                o.dday! <= 30
                  ? 'bg-rose-50 border-rose-200 text-rose-700'
                  : o.dday! <= 90
                    ? 'bg-amber-50 border-amber-200 text-amber-700'
                    : 'bg-gray-50 border-gray-200 text-gray-500'
              }`}
            >
              {o.label} · D-{o.dday}
            </span>
          ))}
        </div>
        <div className="mt-3 text-xs text-gray-500">
          연중 (선물·기념일·생일·돌잔치) 모디파이어는 시즈널리티 약하므로 D-day 미표시.
        </div>
      </section>

      {/* 본문 보드 */}
      {rows.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500">
          <p className="text-base font-medium">gift_intent 데이터 없음</p>
          <p className="text-sm mt-2">
            scripts/compute-gift-intent.mjs 실행 후 다시 방문.
            <br />
            naver_blog / naver_news / google_suggest 누적이 부족하면 매칭률 0.
          </p>
        </div>
      ) : (
        <section className="rounded border border-gray-200">
          <div className="px-4 py-2 border-b border-gray-100 text-xs text-gray-500 flex justify-between">
            <span>최신 스냅샷: {computedAt?.slice(0, 16) ?? '—'}</span>
            <span>{rows.length} keywords</span>
          </div>
          <div className="divide-y divide-gray-100">
            {rows.slice(0, 200).map((r) => {
              const buckets = Object.entries(r.occasion_breakdown ?? {})
                .sort((a, b) => b[1] - a[1])
                .slice(0, 5)
              const sharePct = (r.gift_share * 100).toFixed(1)
              return (
                <div key={r.keyword} className="px-4 py-3 grid grid-cols-12 gap-3 items-center text-sm">
                  <div className="col-span-4">
                    <div className="font-medium">{r.keyword}</div>
                    <div className="text-xs text-gray-500 mt-1">
                      sample {r.sample_count} docs
                    </div>
                  </div>
                  <div className="col-span-2">
                    <div className="text-base font-mono font-semibold">{sharePct}%</div>
                    <div className="text-[10px] text-gray-400">gift_share</div>
                  </div>
                  <div className="col-span-4 flex flex-wrap gap-1">
                    {buckets.map(([k, v]) => (
                      <span
                        key={k}
                        className="px-1.5 py-0.5 rounded bg-violet-50 border border-violet-200 text-violet-700 text-[11px]"
                      >
                        {k} {(v * 100).toFixed(0)}%
                      </span>
                    ))}
                  </div>
                  <div className="col-span-2 text-right">
                    <div className="text-xs font-mono text-emerald-700">
                      {premiumRange(r.gift_share)}
                    </div>
                    <div className="text-[10px] text-gray-400">margin premium</div>
                  </div>
                </div>
              )
            })}
          </div>
        </section>
      )}

      <p className="text-xs text-gray-400">
        margin premium = gift_share × 15~30%. 선물 인텐트가 가격민감도가 낮음을 활용한 위탁 상품 마진 흡수 가이드.
      </p>
    </div>
  )
}
