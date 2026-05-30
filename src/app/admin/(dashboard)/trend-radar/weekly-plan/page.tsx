import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import { buildPlan, currentWeekStart, type RecommendRow } from './planner'
import PlanBoard from './PlanBoard'

export const dynamic = 'force-dynamic'

const CAPACITY_OPTIONS = [5, 10, 15, 20] as const
const PERCAT_OPTIONS = [2, 3, 5] as const
const MARGIN_WEIGHT_OPTIONS = [
  { v: 0, label: '점수만' },
  { v: 0.5, label: '균형 (기본)' },
  { v: 1, label: '마진 중시' },
] as const

async function fetchRecommend(): Promise<{ rows: RecommendRow[]; error: string | null }> {
  const sb = createAdminClient()
  // RPC는 DB(supabase/ggsan_recommend_rpc.sql)에 존재하나 generated 타입 미반영.
  const { data, error } = await sb.rpc('jimscanner_ggsan_recommend' as never, {
    days_window: 30,
    min_sim: 0.2,
    min_score: 0.5,
    result_limit: 200,
  } as never)
  if (error) return { rows: [], error: error.message }
  return { rows: (data ?? []) as RecommendRow[], error: null }
}

async function fetchSaved(weekStart: string): Promise<Record<string, boolean>> {
  const sb = createAdminClient()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (sb as any)
    .from('jimscanner_trends_weekly_plan')
    .select('goods_no, status')
    .eq('week_start', weekStart)
  if (error) return {}
  const map: Record<string, boolean> = {}
  for (const r of (data ?? []) as { goods_no: string; status: string }[]) {
    map[r.goods_no] = r.status === 'done'
  }
  return map
}

function buildHref(current: Record<string, string>, override: Record<string, string>): string {
  const params = new URLSearchParams()
  for (const [k, v] of Object.entries(current)) if (v) params.set(k, v)
  for (const [k, v] of Object.entries(override)) params.set(k, v)
  const qs = params.toString()
  return '/admin/trend-radar/weekly-plan' + (qs ? `?${qs}` : '')
}

export default async function WeeklyPlanPage({
  searchParams,
}: {
  searchParams: Promise<{ cap?: string; percat?: string; mw?: string }>
}) {
  const sp = await searchParams
  const cap = CAPACITY_OPTIONS.includes(parseInt(sp.cap ?? '', 10) as never)
    ? parseInt(sp.cap!, 10)
    : 10
  const percat = PERCAT_OPTIONS.includes(parseInt(sp.percat ?? '', 10) as never)
    ? parseInt(sp.percat!, 10)
    : 3
  const mwRaw = parseFloat(sp.mw ?? '0.5')
  const marginWeight = MARGIN_WEIGHT_OPTIONS.some((o) => Math.abs(o.v - mwRaw) < 0.001) ? mwRaw : 0.5

  const weekStart = currentWeekStart(new Date())

  const [{ rows, error }, savedDone] = await Promise.all([fetchRecommend(), fetchSaved(weekStart)])

  const items = buildPlan(rows, { capacity: cap, perCategoryCap: percat, marginWeight })
  const hasSaved = Object.keys(savedDone).length > 0

  const current: Record<string, string> = {
    cap: String(cap),
    percat: String(percat),
    mw: String(marginWeight),
  }

  // 카테고리별 선정 분포 (상한 도달 여부 표시용)
  const catDist = new Map<string, number>()
  for (const it of items) {
    const k = it.cate_label ?? it.cate_cd ?? '미분류'
    catDist.set(k, (catDist.get(k) ?? 0) + 1)
  }

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold">🗓 주간 등록 캐파 플래너</h1>
          <p className="text-sm text-gray-500 mt-1">
            {weekStart} 주차 · 기대가치(final_score × 기대마진) × 캐파·카테고리 상한 제약 greedy 배치
          </p>
        </div>
        <Link href="/admin/trend-radar/recommend" className="text-sm text-gray-700 hover:text-black underline">
          → 추천 후보 전체
        </Link>
      </header>

      <div className="rounded border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-900">
        1인 셀러 병목은 <strong>점수가 아니라 주간 등록 처리량</strong>. 한정된 캐파를 기대가치 순으로
        배분하고, 카테고리 편중을 상한으로 막으며, 시한성(임박·TV) 아이템을 &apos;지금&apos; 으로 우선
        시퀀싱합니다. 미완료 선정은 다음 주 재배치 시 자동 정리됩니다.
      </div>

      {/* 제약 입력 */}
      <div className="rounded border border-gray-200 px-4 py-3 space-y-3">
        <ControlRow label="주간 캐파">
          {CAPACITY_OPTIONS.map((v) => (
            <Chip key={v} href={buildHref(current, { cap: String(v) })} active={cap === v} text={`${v}건`} />
          ))}
        </ControlRow>
        <ControlRow label="카테고리당 상한">
          {PERCAT_OPTIONS.map((v) => (
            <Chip key={v} href={buildHref(current, { percat: String(v) })} active={percat === v} text={`${v}건`} />
          ))}
        </ControlRow>
        <ControlRow label="가치 산식">
          {MARGIN_WEIGHT_OPTIONS.map((o) => (
            <Chip
              key={o.v}
              href={buildHref(current, { mw: String(o.v) })}
              active={Math.abs(marginWeight - o.v) < 0.001}
              text={o.label}
            />
          ))}
        </ControlRow>
        {catDist.size > 0 && (
          <div className="flex flex-wrap gap-1 border-t border-gray-100 pt-2 text-[11px]">
            <span className="text-gray-400 mr-1">카테고리 분포:</span>
            {[...catDist.entries()].map(([k, n]) => (
              <span
                key={k}
                className={`px-1.5 py-0.5 rounded ${n >= percat ? 'bg-amber-100 text-amber-800 font-semibold' : 'bg-gray-100 text-gray-600'}`}
              >
                {k} {n}{n >= percat ? ' (상한)' : ''}
              </span>
            ))}
          </div>
        )}
      </div>

      {error && (
        <div className="rounded border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800">
          RPC 에러: <code className="font-mono text-xs">{error}</code>
          <p className="text-xs mt-2 text-red-700">
            RPC <code>jimscanner_ggsan_recommend</code> 또는 테이블{' '}
            <code>jimscanner_trends_weekly_plan</code> 미적용 가능성. supabase/ 마이그레이션 확인.
          </p>
        </div>
      )}

      {!error && rows.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500 space-y-2">
          <div className="text-base font-medium">추천 후보 없음 — 배치할 게 없습니다</div>
          <div className="text-xs text-gray-400">
            trends_keywords 누적 부족 또는 cron 중단 가능성. /admin/trend-radar/sources 확인.
          </div>
        </div>
      ) : (
        <PlanBoard
          weekStart={weekStart}
          items={items}
          savedDone={savedDone}
          hasSaved={hasSaved}
          capacity={cap}
        />
      )}
    </div>
  )
}

function ControlRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 flex-wrap">
      <span className="text-xs text-gray-500 w-24">{label}</span>
      {children}
    </div>
  )
}

function Chip({ href, active, text }: { href: string; active: boolean; text: string }) {
  return (
    <Link
      href={href}
      className={`px-2 py-1 text-xs rounded ${active ? 'bg-black text-white font-semibold' : 'text-gray-500 hover:text-black bg-gray-100'}`}
    >
      {text}
    </Link>
  )
}
