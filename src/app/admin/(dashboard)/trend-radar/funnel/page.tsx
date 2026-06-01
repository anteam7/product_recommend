import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

// jimscanner_trends_v4_funnel (뷰) — supabase generated types 갱신 전까지 임시 캐스팅.
interface FunnelRow {
  product_id: string
  canonical_name: string
  category_top: string
  discovered_at: string
  pinned_at: string | null
  sourced_at: string | null
  registered_at: string | null
  is_selling: boolean
  latest_status: string | null
}

const DAY = 86400_000

// 단계별 적체 경고 임계치(일). 이 일수를 넘기면 stale.
const STALE_DAYS = {
  toPinned: 14, // 발굴됐는데 핀 안 함
  toSourced: 7, // 핀했는데 미소싱
  toRegistered: 10, // 소싱했는데 미등록
} as const

function daysBetween(from: string, to: number) {
  return Math.floor((to - new Date(from).getTime()) / DAY)
}

function isoWeek(d: Date) {
  // ISO-8601 주차 키 'YYYY-Www'
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
  const dayNum = (date.getUTCDay() + 6) % 7
  date.setUTCDate(date.getUTCDate() - dayNum + 3)
  const firstThursday = new Date(Date.UTC(date.getUTCFullYear(), 0, 4))
  const week =
    1 +
    Math.round(
      ((date.getTime() - firstThursday.getTime()) / DAY - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7,
    )
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, '0')}`
}

function median(nums: number[]) {
  if (nums.length === 0) return null
  const s = [...nums].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2)
}

async function fetchFunnel() {
  // 신규 뷰 — generated types 갱신 전까지 임시 캐스팅
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sb = createAdminClient() as any
  const { data, error } = await sb
    .from('jimscanner_trends_v4_funnel')
    .select(
      'product_id, canonical_name, category_top, discovered_at, pinned_at, sourced_at, registered_at, is_selling, latest_status',
    )
    .order('discovered_at', { ascending: false })
    .limit(5000)
  return { rows: (data ?? []) as FunnelRow[], error: error?.message ?? null }
}

export default async function FunnelPage() {
  const { rows, error } = await fetchFunnel()
  const now = Date.now()

  // ── ① 깔때기 단계 카운트 ──
  const counts = {
    discovered: rows.length,
    pinned: rows.filter((r) => r.pinned_at).length,
    sourced: rows.filter((r) => r.sourced_at).length,
    registered: rows.filter((r) => r.registered_at).length,
    selling: rows.filter((r) => r.is_selling).length,
  }
  const stages: { key: keyof typeof counts; label: string; color: string }[] = [
    { key: 'discovered', label: '① 발굴', color: 'bg-slate-400' },
    { key: 'pinned', label: '② 핀', color: 'bg-blue-400' },
    { key: 'sourced', label: '③ 소싱', color: 'bg-violet-400' },
    { key: 'registered', label: '④ 등록', color: 'bg-emerald-400' },
    { key: 'selling', label: '⑤ 판매중', color: 'bg-emerald-600' },
  ]
  const maxCount = Math.max(counts.discovered, 1)

  // ── ② 단계 적체(aging): 현재 단계에서 다음 단계로 못 넘어간 stale 항목 ──
  type StaleItem = {
    product_id: string
    name: string
    stage: string
    enteredAt: string
    days: number
    threshold: number
  }
  const stale: StaleItem[] = []
  for (const r of rows) {
    if (r.is_selling) continue // 판매중이면 적체 아님
    if (r.sourced_at && !r.registered_at) {
      stale.push({
        product_id: r.product_id,
        name: r.canonical_name,
        stage: '소싱→미등록',
        enteredAt: r.sourced_at,
        days: daysBetween(r.sourced_at, now),
        threshold: STALE_DAYS.toRegistered,
      })
    } else if (r.pinned_at && !r.sourced_at) {
      stale.push({
        product_id: r.product_id,
        name: r.canonical_name,
        stage: '핀→미소싱',
        enteredAt: r.pinned_at,
        days: daysBetween(r.pinned_at, now),
        threshold: STALE_DAYS.toSourced,
      })
    } else if (!r.pinned_at) {
      stale.push({
        product_id: r.product_id,
        name: r.canonical_name,
        stage: '발굴→미핀',
        enteredAt: r.discovered_at,
        days: daysBetween(r.discovered_at, now),
        threshold: STALE_DAYS.toPinned,
      })
    }
  }
  // 임계 초과(경고)만, 정체 오래된 순
  const staleWarn = stale
    .filter((s) => s.days >= s.threshold)
    .sort((a, b) => b.days - a.days)
    .slice(0, 40)

  // ── ③ 주차 코호트 리텐션: 발굴 주차별 단계 도달률 + 등록까지 중앙값 ──
  const cohortMap = new Map<
    string,
    { week: string; discovered: number; pinned: number; sourced: number; registered: number; leadDays: number[] }
  >()
  for (const r of rows) {
    const wk = isoWeek(new Date(r.discovered_at))
    let c = cohortMap.get(wk)
    if (!c) {
      c = { week: wk, discovered: 0, pinned: 0, sourced: 0, registered: 0, leadDays: [] }
      cohortMap.set(wk, c)
    }
    c.discovered++
    if (r.pinned_at) c.pinned++
    if (r.sourced_at) c.sourced++
    if (r.registered_at) {
      c.registered++
      c.leadDays.push(Math.max(0, daysBetween(r.discovered_at, new Date(r.registered_at).getTime())))
    }
  }
  const cohorts = [...cohortMap.values()].sort((a, b) => b.week.localeCompare(a.week)).slice(0, 10)

  const pct = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 100) : 0)

  return (
    <div className="space-y-8 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold">발굴 → 등록 전환 깔때기</h1>
          <p className="text-sm text-gray-500 mt-1">
            워크플로 단계별 전환율과 적체를 측정 · 처리량 손실 지점을 드러냄
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      {error && (
        <div className="rounded border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          뷰 <code className="font-mono">jimscanner_trends_v4_funnel</code> 조회 실패: {error}
          <br />
          <span className="text-xs">
            supabase/trends_v4_funnel.sql 마이그레이션을 먼저 적용하세요.
          </span>
        </div>
      )}

      {/* ① 깔때기 차트 */}
      <section>
        <h2 className="text-sm font-semibold text-gray-700 mb-3">① 단계별 잔존 · 전환율</h2>
        <div className="space-y-2">
          {stages.map((st, i) => {
            const n = counts[st.key]
            const prev = i === 0 ? n : counts[stages[i - 1].key]
            const widthPct = Math.max((n / maxCount) * 100, n > 0 ? 2 : 0)
            return (
              <div key={st.key} className="flex items-center gap-3">
                <div className="w-20 text-sm text-gray-600 shrink-0">{st.label}</div>
                <div className="flex-1 bg-gray-100 rounded h-8 relative overflow-hidden">
                  <div
                    className={`${st.color} h-full rounded transition-all flex items-center px-2`}
                    style={{ width: `${widthPct}%` }}
                  >
                    <span className="text-xs font-mono font-bold text-white">{n.toLocaleString()}</span>
                  </div>
                </div>
                <div className="w-28 text-right text-xs text-gray-500 shrink-0">
                  {i === 0 ? (
                    <span className="text-gray-400">기준</span>
                  ) : (
                    <>
                      <span className="font-mono font-semibold text-gray-700">{pct(n, prev)}%</span>
                      <span className="text-gray-400"> / 전체 {pct(n, maxCount)}%</span>
                    </>
                  )}
                </div>
              </div>
            )
          })}
        </div>
        <p className="text-xs text-gray-400 mt-3">
          전환율 = 직전 단계 대비. 등록 연결은 supplier_source+id ↔ listings.source+source_goods_no 기준.
        </p>
      </section>

      {/* ② 단계 적체 테이블 */}
      <section>
        <div className="flex items-baseline justify-between mb-3">
          <h2 className="text-sm font-semibold text-gray-700">
            ② 단계 적체 경고{' '}
            <span className="text-xs font-normal text-gray-500 ml-1">
              (임계 초과 정체 · {stale.length}건 중 {staleWarn.length}건 경고)
            </span>
          </h2>
        </div>
        {staleWarn.length === 0 ? (
          <div className="rounded border border-dashed border-gray-300 p-8 text-center text-sm text-gray-500">
            임계를 넘긴 적체 항목 없음 👍
          </div>
        ) : (
          <div className="rounded border border-gray-200 divide-y divide-gray-100">
            <div className="grid grid-cols-12 px-3 py-2 text-xs text-gray-500 bg-gray-50">
              <div className="col-span-6">상품</div>
              <div className="col-span-2">정체 단계</div>
              <div className="col-span-2 text-right">진입일</div>
              <div className="col-span-2 text-right">정체일수</div>
            </div>
            {staleWarn.map((s) => {
              const sev = s.days >= s.threshold * 2 ? 'text-red-600' : 'text-amber-600'
              return (
                <Link
                  key={`${s.product_id}-${s.stage}`}
                  href={`/admin/trend-radar/products/${s.product_id}`}
                  className="grid grid-cols-12 px-3 py-2 text-sm items-center hover:bg-gray-50"
                >
                  <div className="col-span-6 truncate font-medium">{s.name}</div>
                  <div className="col-span-2 text-xs text-gray-600">{s.stage}</div>
                  <div className="col-span-2 text-right text-xs text-gray-400 font-mono">
                    {s.enteredAt.slice(0, 10)}
                  </div>
                  <div className={`col-span-2 text-right font-mono font-bold ${sev}`}>
                    {s.days}일
                    <span className="text-xs font-normal text-gray-400"> /{s.threshold}</span>
                  </div>
                </Link>
              )
            })}
          </div>
        )}
      </section>

      {/* ③ 주차 코호트 리텐션 */}
      <section>
        <h2 className="text-sm font-semibold text-gray-700 mb-3">
          ③ 주차 코호트{' '}
          <span className="text-xs font-normal text-gray-500 ml-1">
            (발굴 주차별 단계 도달률 · 등록까지 중앙값)
          </span>
        </h2>
        {cohorts.length === 0 ? (
          <div className="rounded border border-dashed border-gray-300 p-8 text-center text-sm text-gray-500">
            데이터 없음
          </div>
        ) : (
          <div className="rounded border border-gray-200 divide-y divide-gray-100">
            <div className="grid grid-cols-12 px-3 py-2 text-xs text-gray-500 bg-gray-50">
              <div className="col-span-3">발굴 주차</div>
              <div className="col-span-2 text-right">발굴</div>
              <div className="col-span-2 text-right">핀%</div>
              <div className="col-span-2 text-right">소싱%</div>
              <div className="col-span-2 text-right">등록%</div>
              <div className="col-span-1 text-right">중앙</div>
            </div>
            {cohorts.map((c) => (
              <div key={c.week} className="grid grid-cols-12 px-3 py-2 text-sm items-center">
                <div className="col-span-3 font-mono text-xs text-gray-600">{c.week}</div>
                <div className="col-span-2 text-right font-mono">{c.discovered}</div>
                <div className="col-span-2 text-right font-mono text-blue-600">
                  {pct(c.pinned, c.discovered)}%
                </div>
                <div className="col-span-2 text-right font-mono text-violet-600">
                  {pct(c.sourced, c.discovered)}%
                </div>
                <div className="col-span-2 text-right font-mono text-emerald-600">
                  {pct(c.registered, c.discovered)}%
                </div>
                <div className="col-span-1 text-right text-xs text-gray-500">
                  {median(c.leadDays) === null ? '—' : `${median(c.leadDays)}일`}
                </div>
              </div>
            ))}
          </div>
        )}
        <p className="text-xs text-gray-400 mt-3">
          중앙 = 발굴→등록 도달 product 의 소요일 중앙값. 빈칸은 아직 등록 도달 없음.
        </p>
      </section>
    </div>
  )
}
