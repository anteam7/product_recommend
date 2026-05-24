import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

type Stage = 'incubating' | 'mass_prod' | 'retail_entry' | 'wholesale' | 'consign_golden'

const STAGES: { key: Stage; label: string; dband: string; color: string }[] = [
  { key: 'incubating',     label: '인큐베이팅',     dband: 'D+0 ~ D+59',  color: 'bg-gray-50 border-gray-200' },
  { key: 'mass_prod',      label: '양산 개시',      dband: 'D+60 ~ D+89', color: 'bg-amber-50 border-amber-200' },
  { key: 'retail_entry',   label: '일반유통 진입',  dband: 'D+90 ~ D+179',color: 'bg-blue-50 border-blue-200' },
  { key: 'wholesale',      label: '도매시장',       dband: 'D+180 ~ D+269',color: 'bg-purple-50 border-purple-200' },
  { key: 'consign_golden', label: '위탁 골든존',    dband: 'D+270 ~',     color: 'bg-emerald-50 border-emerald-300' },
]

interface SignalRow {
  id: string
  source: string
  project_id: string
  title: string
  url: string | null
  funded_krw: number | null
  supporters: number | null
  end_date: string
  category: string | null
  maker: string | null
  status: string
  matched_keyword: string | null
  match_score: number | null
  pinned: boolean
  days_since_end: number
  lifecycle_stage: Stage
}

interface OnsetRow {
  id: string
  signal_id: string
  matched_keyword: string
  ggsan_goods_no: string | null
  ggsan_title: string | null
  days_since_end: number | null
  detected_at: string
  acknowledged: boolean
}

async function fetchData() {
  const sb = createAdminClient()

  const { data: signals } = await (sb as any)
    .from('jimscanner_wadiz_lifecycle')
    .select('*')
    .order('funded_krw', { ascending: false, nullsFirst: false })
    .limit(500)

  const { data: onsets } = await (sb as any)
    .from('jimscanner_wadiz_supply_onset')
    .select('*')
    .order('detected_at', { ascending: false })
    .limit(50)

  return {
    rows: (signals ?? []) as SignalRow[],
    onsets: (onsets ?? []) as OnsetRow[],
  }
}

export default async function WadizPage() {
  const { rows, onsets } = await fetchData()

  const byStage = new Map<Stage, SignalRow[]>()
  for (const s of STAGES) byStage.set(s.key, [])
  for (const r of rows) {
    const bucket = byStage.get(r.lifecycle_stage)
    if (bucket) bucket.push(r)
  }

  const totalFunded = rows.reduce((acc, r) => acc + (r.funded_krw ?? 0), 0)
  const matchedCount = rows.filter((r) => r.matched_keyword).length
  const unackOnsets = onsets.filter((o) => !o.acknowledged).length

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold">와디즈 졸업 트래커</h1>
          <p className="text-sm text-gray-500 mt-1">
            펀딩 종료 프로젝트 라이프사이클 보드 · 검색 트렌드보다 60-180일 선행 채널
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      <section className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <KpiCard label="추적 프로젝트" value={rows.length.toLocaleString()} hint="펀딩 성공 졸업" />
        <KpiCard label="누적 펀딩금" value={`${Math.round(totalFunded / 1e8).toLocaleString()}억원`} hint="전체 합계" />
        <KpiCard label="키워드 매칭" value={matchedCount.toLocaleString()} hint="fuzzy ≥0.3" />
        <KpiCard label="🔴 미확인 supply onset" value={unackOnsets.toLocaleString()} hint="ggsan 첫 검출" />
      </section>

      {unackOnsets > 0 && (
        <section className="rounded border border-red-300 bg-red-50 p-4">
          <div className="text-sm font-semibold text-red-800 mb-2">
            🔴 도매 진입 감지 — supply_onset 이벤트 {unackOnsets}건
          </div>
          <div className="space-y-1 text-xs">
            {onsets.filter((o) => !o.acknowledged).slice(0, 5).map((o) => (
              <div key={o.id} className="flex justify-between gap-3">
                <span className="font-medium truncate">{o.matched_keyword}</span>
                <span className="text-gray-600 truncate flex-1">→ {o.ggsan_title ?? o.ggsan_goods_no}</span>
                <span className="text-gray-500 font-mono">D+{o.days_since_end ?? '?'}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="grid grid-cols-1 md:grid-cols-5 gap-3">
        {STAGES.map((stage) => {
          const items = byStage.get(stage.key) ?? []
          return (
            <div key={stage.key} className={`rounded border ${stage.color} p-3 min-h-[200px]`}>
              <div className="flex items-baseline justify-between mb-2">
                <h3 className="text-sm font-semibold">{stage.label}</h3>
                <span className="text-xs font-mono text-gray-500">{items.length}</span>
              </div>
              <div className="text-[10px] text-gray-500 mb-2">{stage.dband}</div>
              <div className="space-y-2">
                {items.slice(0, 30).map((r) => (
                  <WadizCard key={r.id} row={r} />
                ))}
                {items.length === 0 && (
                  <div className="text-xs text-gray-400 italic">없음</div>
                )}
              </div>
            </div>
          )
        })}
      </section>
    </div>
  )
}

function WadizCard({ row }: { row: SignalRow }) {
  const fundedM = row.funded_krw ? Math.round(row.funded_krw / 1e6) : 0
  return (
    <div className="rounded bg-white border border-gray-200 p-2 text-xs hover:shadow-sm">
      <div className="flex items-start justify-between gap-1">
        <a
          href={row.url ?? '#'}
          target="_blank"
          rel="noopener noreferrer"
          className="font-medium leading-tight line-clamp-2 hover:underline flex-1"
        >
          {row.title}
        </a>
        <form action="/api/admin/trends/wadiz/pin" method="post">
          <input type="hidden" name="signal_id" value={row.id} />
          <input type="hidden" name="pinned" value={row.pinned ? '0' : '1'} />
          <button
            type="submit"
            className={`text-base leading-none shrink-0 ${row.pinned ? 'text-amber-500' : 'text-gray-300 hover:text-amber-500'}`}
            title={row.pinned ? '핀 해제' : '핀 + product_recommend 큐 적재'}
          >
            ★
          </button>
        </form>
      </div>
      <div className="mt-1 flex items-center justify-between text-[10px] text-gray-500">
        <span>{fundedM > 0 ? `${fundedM.toLocaleString()}M` : '—'}</span>
        <span>{row.supporters ? `${row.supporters.toLocaleString()}명` : ''}</span>
        <span className="font-mono">D+{row.days_since_end}</span>
      </div>
      {row.matched_keyword && (
        <div className="mt-1 text-[10px] text-blue-700 truncate">
          → {row.matched_keyword}
          {typeof row.match_score === 'number' && (
            <span className="text-gray-400 ml-1">({row.match_score.toFixed(2)})</span>
          )}
        </div>
      )}
      {row.category && (
        <div className="text-[10px] text-gray-400 truncate">{row.category}</div>
      )}
    </div>
  )
}

function KpiCard({ label, value, hint }: { label: string; value: string | number; hint: string }) {
  return (
    <div className="rounded border border-gray-200 p-4">
      <div className="text-xs text-gray-500">{label}</div>
      <div className="text-2xl font-bold mt-1">{value}</div>
      <div className="text-xs text-gray-400 mt-1">{hint}</div>
    </div>
  )
}
