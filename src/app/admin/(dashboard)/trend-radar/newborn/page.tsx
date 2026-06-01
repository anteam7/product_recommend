import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

// jimscanner_trends_newborn RPC 반환 row.
// 점수(score)가 못 보는 '나이(age)' 차원으로 첫 등장 24~72h 신생 토큰을 선점한다.
interface NewbornRow {
  product_id: string
  canonical_name: string
  category_top: string
  first_seen_at: string
  age_hours: number
  alias_count: number
  source_breadth: number
  mentions_early: number
  mentions_late: number
  accel_ratio: number
  ggsan_available: boolean
  ggsan_best_sim: number
  ggsan_min_price: number | null
  sprout_grade: 'A' | 'B' | 'C' | 'noise'
}

const WINDOWS = [
  { key: '24', label: '24h', max: 24 },
  { key: '48', label: '48h', max: 48 },
  { key: '72', label: '72h', max: 72 },
] as const

async function fetchNewborn(hoursMax: number) {
  const sb = createAdminClient()
  // RPC 타입은 generated types 에 아직 없음 → as any (마이그레이션 후 상태 가정)
  const { data, error } = await (sb as any).rpc('jimscanner_trends_newborn', {
    hours_min: 0,
    hours_max: hoursMax,
    result_limit: 150,
    ggsan_min_sim: 0.3,
  })
  if (error) return { rows: [] as NewbornRow[], error: error.message }
  return { rows: (data ?? []) as NewbornRow[], error: null as string | null }
}

export default async function NewbornPage({
  searchParams,
}: {
  searchParams: Promise<{ w?: string }>
}) {
  const sp = await searchParams
  const win = WINDOWS.find((w) => w.key === sp.w) ?? WINDOWS[2]
  const { rows, error } = await fetchNewborn(win.max)

  const live = rows.filter((r) => r.sprout_grade !== 'noise')
  const noise = rows.filter((r) => r.sprout_grade === 'noise')
  const counts = {
    A: live.filter((r) => r.sprout_grade === 'A').length,
    B: live.filter((r) => r.sprout_grade === 'B').length,
    C: live.filter((r) => r.sprout_grade === 'C').length,
    noise: noise.length,
    ggsan: live.filter((r) => r.ggsan_available).length,
  }

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold">🌱 신생 신호 콜드스타트 보드</h1>
          <p className="text-sm text-gray-500 mt-1">
            첫 등장 {win.label} 이내 토큰만 — 점수가 익기 전 1~2일 먼저 핀.{' '}
            <span className="text-gray-400">
              떡잎 등급 = 재언급 가속 × 교차소스 폭 × ggsan 즉시 소싱
            </span>
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      {/* KPI */}
      <section className="grid grid-cols-2 md:grid-cols-5 gap-4">
        <KpiCard label="🥇 A 떡잎" value={counts.A} hint="가속+교차소스+소싱" tone="green" />
        <KpiCard label="🥈 B 떡잎" value={counts.B} hint="가속 또는 교차소스" tone="amber" />
        <KpiCard label="🥉 C 떡잎" value={counts.C} hint="관찰 단계" />
        <KpiCard label="ggsan 즉시소싱" value={counts.ggsan} hint="도매 매칭 가능" />
        <KpiCard label="노이즈 강등" value={counts.noise} hint="1회성 단발" tone="gray" />
      </section>

      {/* 윈도우 탭 */}
      <nav className="flex gap-2 border-b border-gray-200">
        {WINDOWS.map((w) => (
          <Link
            key={w.key}
            href={`/admin/trend-radar/newborn?w=${w.key}`}
            className={`px-3 py-2 text-sm ${
              win.key === w.key
                ? 'border-b-2 border-black font-semibold text-black'
                : 'text-gray-500 hover:text-black'
            }`}
          >
            첫 등장 {w.label} 이내
          </Link>
        ))}
      </nav>

      {error ? (
        <div className="rounded border border-red-300 bg-red-50 p-4 text-sm text-red-700">
          RPC 오류: {error}
          <div className="text-xs text-red-500 mt-1">
            supabase/trends_v4_newborn_radar.sql 적용 여부 확인.
          </div>
        </div>
      ) : rows.length === 0 ? (
        <EmptyState />
      ) : (
        <>
          <NewbornTable rows={live} />
          {noise.length > 0 && (
            <section>
              <h2 className="text-sm font-semibold text-gray-500 mt-4 mb-2">
                회색 강등 — 1회성 단발 노이즈 ({noise.length})
              </h2>
              <NewbornTable rows={noise} muted />
            </section>
          )}
        </>
      )}
    </div>
  )
}

function NewbornTable({ rows, muted = false }: { rows: NewbornRow[]; muted?: boolean }) {
  if (rows.length === 0) {
    return <div className="text-sm text-gray-400 px-3 py-4">해당 없음</div>
  }
  return (
    <div className="grid gap-2">
      <div className="grid grid-cols-12 text-xs text-gray-500 px-3 py-1">
        <div className="col-span-1">등급</div>
        <div className="col-span-4">상품명 (신생)</div>
        <div className="col-span-1 text-right">나이</div>
        <div className="col-span-1 text-right">초기6h</div>
        <div className="col-span-1 text-right">후기24h</div>
        <div className="col-span-1 text-right">가속</div>
        <div className="col-span-1 text-right">소스</div>
        <div className="col-span-2 text-right">ggsan</div>
      </div>
      {rows.map((r) => (
        <Link
          key={r.product_id}
          href={`/admin/trend-radar/products/${r.product_id}`}
          className={`grid grid-cols-12 px-3 py-2 rounded border transition-colors ${
            muted
              ? 'border-gray-100 bg-gray-50/60 opacity-60 hover:opacity-100'
              : 'border-gray-200 hover:bg-gray-50'
          }`}
        >
          <div className="col-span-1">
            <GradeBadge grade={r.sprout_grade} />
          </div>
          <div className="col-span-4">
            <div className="font-medium truncate">{r.canonical_name}</div>
            <div className="text-xs text-gray-500">
              {r.category_top} · alias {r.alias_count}
            </div>
          </div>
          <div className="col-span-1 text-right font-mono text-gray-600">
            {Math.round(r.age_hours)}h
          </div>
          <div className="col-span-1 text-right font-mono text-gray-500">{r.mentions_early}</div>
          <div className="col-span-1 text-right font-mono text-gray-700">{r.mentions_late}</div>
          <div
            className={`col-span-1 text-right font-mono font-bold ${
              r.accel_ratio >= 1 ? 'text-green-700' : 'text-gray-400'
            }`}
          >
            ×{r.accel_ratio}
          </div>
          <div className="col-span-1 text-right font-mono text-gray-600">{r.source_breadth}</div>
          <div className="col-span-2 text-right text-xs">
            {r.ggsan_available ? (
              <span className="text-green-700 font-semibold">
                ✓ {r.ggsan_min_price ? `${r.ggsan_min_price.toLocaleString()}원` : '매칭'}
                <span className="text-gray-400 font-normal ml-1">sim {r.ggsan_best_sim}</span>
              </span>
            ) : (
              <span className="text-gray-400">미검출</span>
            )}
          </div>
        </Link>
      ))}
    </div>
  )
}

function GradeBadge({ grade }: { grade: NewbornRow['sprout_grade'] }) {
  const map: Record<NewbornRow['sprout_grade'], { label: string; cls: string }> = {
    A: { label: 'A', cls: 'bg-green-100 text-green-800 border-green-300' },
    B: { label: 'B', cls: 'bg-amber-100 text-amber-800 border-amber-300' },
    C: { label: 'C', cls: 'bg-gray-100 text-gray-600 border-gray-300' },
    noise: { label: '–', cls: 'bg-gray-50 text-gray-400 border-gray-200' },
  }
  const m = map[grade]
  return (
    <span className={`inline-flex h-6 w-6 items-center justify-center rounded-full border text-xs font-bold ${m.cls}`}>
      {m.label}
    </span>
  )
}

function KpiCard({
  label,
  value,
  hint,
  tone,
}: {
  label: string
  value: number
  hint: string
  tone?: 'green' | 'amber' | 'gray'
}) {
  const toneCls =
    tone === 'green'
      ? 'border-green-200 bg-green-50/50'
      : tone === 'amber'
        ? 'border-amber-200 bg-amber-50/50'
        : tone === 'gray'
          ? 'border-gray-200 bg-gray-50'
          : 'border-gray-200'
  return (
    <div className={`rounded border p-4 ${toneCls}`}>
      <div className="text-xs text-gray-500">{label}</div>
      <div className="text-3xl font-bold mt-1">{value.toLocaleString()}</div>
      <div className="text-xs text-gray-400 mt-1">{hint}</div>
    </div>
  )
}

function EmptyState() {
  return (
    <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500">
      <p className="text-base font-medium">신생 토큰이 아직 없습니다</p>
      <p className="text-sm mt-2">
        선택한 윈도우({'<'}72h) 내 first_seen_at 인 canonical product 가 없습니다.
        <br />
        매일 KST 06:00 recompute 가 신규 키워드를 canonical 로 매핑하면 여기 나타납니다.
      </p>
    </div>
  )
}
