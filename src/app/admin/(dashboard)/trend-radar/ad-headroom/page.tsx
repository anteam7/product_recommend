import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import AdHeadroomBoard, { type HeadroomRow } from './AdHeadroomBoard'

export const dynamic = 'force-dynamic'

interface AdRow {
  keyword: string
  monthly_pc_qc: number | null
  monthly_mobile_qc: number | null
  avg_cpc: number | null
  competition_idx: string | null
  fetched_at: string
}

interface PinRow {
  keyword: string
  source: string
  notes: string | null
}

const DEFAULT_MARGIN = 8000  // 핀 평균 단가 가정 — Phase 0 셀러 도구는 마진 데이터 부재
const DEFAULT_CVR_PCT = 3    // 가정 CVR (%)

// notes 에 `margin=12000` 같은 운영자 메모가 들어 있으면 그 값을 우선 사용
function marginFromNotes(notes: string | null): number | null {
  if (!notes) return null
  const m = notes.match(/margin\s*=\s*(\d{2,7})/)
  return m ? parseInt(m[1], 10) : null
}

async function fetchData() {
  // jimscanner_trends_keyword_ads 테이블은 PR-AdHeadroom 마이그레이션 후 생성됨.
  // 타입 generated 전이라 from() 에 캐스팅 필요.
  const sb = createAdminClient() as ReturnType<typeof createAdminClient> & {
    from: (t: string) => any
  }

  const [{ data: pinsRaw }, { data: adsRaw }] = await Promise.all([
    sb
      .from('jimscanner_trends_pins')
      .select('keyword, source, notes')
      .order('pinned_at', { ascending: false }),
    sb
      .from('jimscanner_trends_keyword_ads')
      .select('keyword, monthly_pc_qc, monthly_mobile_qc, avg_cpc, competition_idx, fetched_at')
      .order('fetched_at', { ascending: false })
      .limit(5000),
  ])

  const pins = (pinsRaw ?? []) as PinRow[]
  const ads = (adsRaw ?? []) as AdRow[]

  // 키워드별 최신 광고 데이터 1건
  const latestByKw = new Map<string, AdRow>()
  for (const a of ads) {
    if (!latestByKw.has(a.keyword)) latestByKw.set(a.keyword, a)
  }

  // pin (keyword) unique
  const seenKw = new Set<string>()
  const uniquePins: PinRow[] = []
  for (const p of pins) {
    const k = (p.keyword ?? '').trim()
    if (!k || seenKw.has(k)) continue
    seenKw.add(k)
    uniquePins.push(p)
  }

  return { pins: uniquePins, latestByKw }
}

const CVR_MATRIX = [1, 3, 5] as const

export default async function AdHeadroomPage({
  searchParams,
}: {
  searchParams: Promise<{ margin?: string; cvr?: string }>
}) {
  const sp = await searchParams
  const marginParam = parseInt(sp.margin ?? '', 10)
  const cvrParam = parseFloat(sp.cvr ?? '')
  const defaultMargin = Number.isFinite(marginParam) && marginParam > 0 ? marginParam : DEFAULT_MARGIN
  const defaultCvr = Number.isFinite(cvrParam) && cvrParam > 0 ? cvrParam : DEFAULT_CVR_PCT

  const { pins, latestByKw } = await fetchData()

  const rows: HeadroomRow[] = pins.map((p) => {
    const ad = latestByKw.get(p.keyword)
    const margin = marginFromNotes(p.notes) ?? defaultMargin
    const matrix = CVR_MATRIX.map((cvr) => ({
      cvr,
      beCpc: Math.round((margin * cvr) / 100),
    }))
    const beCpc = Math.round((margin * defaultCvr) / 100)
    const marketCpc = ad?.avg_cpc ?? null
    const headroomPct =
      marketCpc && marketCpc > 0 ? Math.round(((beCpc - marketCpc) / marketCpc) * 100) : null
    const qc = (ad?.monthly_pc_qc ?? 0) + (ad?.monthly_mobile_qc ?? 0)
    let grade: HeadroomRow['grade'] = 'no_data'
    if (marketCpc != null) {
      const ratio = beCpc / Math.max(1, marketCpc)
      if (ratio >= 1.3) grade = 'paid_ok'
      else if (ratio >= 0.7) grade = 'organic_only'
      else grade = 'no_go'
    }
    return {
      keyword: p.keyword,
      source: p.source,
      notes: p.notes,
      margin,
      defaultCvr,
      matrix,
      beCpc,
      marketCpc,
      headroomPct,
      monthlyQc: qc,
      competitionIdx: ad?.competition_idx ?? null,
      fetchedAt: ad?.fetched_at ?? null,
      grade,
      recommendedBid: marketCpc != null ? Math.min(beCpc, Math.round(marketCpc * 1.15)) : null,
    }
  })

  rows.sort((a, b) => (b.headroomPct ?? -9999) - (a.headroomPct ?? -9999))

  const adsCovered = rows.filter((r) => r.marketCpc != null).length
  const paidOk = rows.filter((r) => r.grade === 'paid_ok').length
  const organicOnly = rows.filter((r) => r.grade === 'organic_only').length
  const noGo = rows.filter((r) => r.grade === 'no_go').length

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold">📈 BE-CPC Ad Headroom</h1>
          <p className="text-sm text-gray-500 mt-1">
            핀 후보의 손익분기 CPC × 네이버 검색광고 추정 시장 단가 비교 — 광고로 진입 가능한 키워드만 채택
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      <div className="rounded border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-900">
        <strong>가정</strong> · 기본 마진 <code>{defaultMargin.toLocaleString()}원</code> · 기본 CVR <code>{defaultCvr}%</code>.
        핀 메모에 <code>margin=12000</code> 형태로 적으면 그 값을 우선 적용. URL 에 <code>?margin=10000&amp;cvr=3</code> 으로 일괄 조정.
        <br />
        <strong>BE-CPC = margin × CVR</strong> 보다 시장 CPC 가 낮으면 광고 ROAS &gt; 1 — 채택 가능.
      </div>

      <section className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <Kpi label="핀 후보" value={rows.length} />
        <Kpi label="광고 데이터 적재" value={`${adsCovered}/${rows.length}`} />
        <Kpi label="🟢 광고 진입 가능" value={paidOk} highlight={paidOk > 0} tone="green" />
        <Kpi label="🟡 자연유입만" value={organicOnly} tone="amber" />
        <Kpi label="🔴 진입 불가" value={noGo} tone="red" />
      </section>

      {rows.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500 space-y-2">
          <div className="text-base font-medium">핀 후보 없음</div>
          <div className="text-xs text-gray-400">
            <code>/admin/trend-radar/pins</code> 에서 핀 등록 후 cron 1회 회전 시 자동 채워짐.
          </div>
        </div>
      ) : (
        <AdHeadroomBoard rows={rows} defaultMargin={defaultMargin} defaultCvr={defaultCvr} />
      )}

      <section className="text-xs text-gray-500 border-t border-gray-200 pt-4 space-y-1">
        <div className="font-semibold text-gray-700">📐 등급 규칙</div>
        <code className="block bg-gray-50 px-3 py-2 rounded font-mono text-[11px] leading-relaxed">
          ratio = BE-CPC / market_cpc
          <br />
          ratio ≥ 1.3 → 🟢 광고 진입 가능 (헤드룸 30%+)
          <br />
          0.7 ≤ ratio &lt; 1.3 → 🟡 자연유입만 (광고 ROAS 위험)
          <br />
          ratio &lt; 0.7 → 🔴 광고 진입 불가 (마진 잠식)
          <br />
          권장 입찰가 = min(BE-CPC, market_cpc × 1.15)
        </code>
      </section>
    </div>
  )
}

function Kpi({
  label,
  value,
  highlight = false,
  tone = 'default',
}: {
  label: string
  value: number | string
  highlight?: boolean
  tone?: 'default' | 'green' | 'amber' | 'red'
}) {
  const toneCls =
    tone === 'green'
      ? 'border-emerald-300 bg-emerald-50 text-emerald-700'
      : tone === 'amber'
      ? 'border-amber-300 bg-amber-50 text-amber-700'
      : tone === 'red'
      ? 'border-red-300 bg-red-50 text-red-700'
      : 'border-gray-200'
  return (
    <div className={`rounded border p-3 ${highlight ? toneCls : 'border-gray-200'}`}>
      <div className="text-xs text-gray-500">{label}</div>
      <div className={`text-2xl font-bold mt-1 ${highlight ? '' : ''}`}>
        {typeof value === 'number' ? value.toLocaleString() : value}
      </div>
    </div>
  )
}
