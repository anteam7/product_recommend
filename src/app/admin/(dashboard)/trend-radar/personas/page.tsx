import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

// 신규 테이블 — generated types 미반영. as any 캐스팅 사용.
type DemoRow = {
  keyword: string
  cid: string | null
  source: string
  age_bucket: string | null
  gender: string | null
  device: string | null
  share: number
  collected_at: string
}

type AgeKey = '10' | '20' | '30' | '40' | '50' | '60'
const AGE_KEYS: AgeKey[] = ['10', '20', '30', '40', '50', '60']

type PersonaCard = {
  keyword: string
  cid: string | null
  collectedAt: string
  ageShares: Record<AgeKey, number> // 정규화 0~1
  genderShares: { m: number; f: number }
  deviceShares: { pc: number; mo: number }
  ageHHI: number // 0~1 (1 에 가까울수록 집중)
  finalScore: number | null
}

function normalize(values: number[]): number[] {
  const sum = values.reduce((a, b) => a + b, 0)
  if (sum <= 0) return values.map(() => 0)
  return values.map((v) => v / sum)
}

function hhi(shares: number[]): number {
  // 정규화된 share (0~1) 의 제곱합.
  return shares.reduce((a, s) => a + s * s, 0)
}

async function fetchPersonas(): Promise<PersonaCard[]> {
  const sb = createAdminClient()

  // 최근 14일 demographic 행만 — 키워드별 최신 collected_at 그룹만 추출
  const since = new Date(Date.now() - 14 * 86400_000).toISOString()
  const { data } = await (sb as any)
    .from('jimscanner_trends_demographics')
    .select('keyword, cid, source, age_bucket, gender, device, share, collected_at')
    .gte('collected_at', since)
    .order('collected_at', { ascending: false })
    .limit(5000)

  const rows = ((data ?? []) as DemoRow[])

  // 키워드별 가장 최근 collected_at 일자(분 단위)에 해당하는 row 만 수집.
  const latestByKw = new Map<string, string>()
  for (const r of rows) {
    const existing = latestByKw.get(r.keyword)
    if (!existing || r.collected_at > existing) latestByKw.set(r.keyword, r.collected_at)
  }
  // 최신 row 와 같은 "수집 회차" (collected_at 가 ±2 분 이내) 만 남긴다.
  const filtered = rows.filter((r) => {
    const latest = latestByKw.get(r.keyword)
    if (!latest) return false
    const dt = Math.abs(new Date(latest).getTime() - new Date(r.collected_at).getTime())
    return dt <= 2 * 60 * 1000
  })

  // 카드별 집계
  const byKw = new Map<string, DemoRow[]>()
  for (const r of filtered) {
    const arr = byKw.get(r.keyword) ?? []
    arr.push(r)
    byKw.set(r.keyword, arr)
  }

  // final_score 룩업 (trend_radar 와 동일 룩업) — keyword == canonical_name 매칭 best-effort
  const { data: scoreData } = await sb
    .from('jimscanner_trends_scores')
    .select('product_id, final_score, computed_at')
    .order('computed_at', { ascending: false })
    .limit(2000)
  const scoreByProduct = new Map<string, number>()
  for (const s of (scoreData ?? []) as Array<{ product_id: string; final_score: number }>) {
    if (!scoreByProduct.has(s.product_id)) scoreByProduct.set(s.product_id, s.final_score)
  }
  const { data: products } = await sb
    .from('jimscanner_trends_products')
    .select('id, canonical_name')
  const scoreByName = new Map<string, number>()
  for (const p of (products ?? []) as Array<{ id: string; canonical_name: string }>) {
    const sc = scoreByProduct.get(p.id)
    if (sc !== undefined) scoreByName.set(p.canonical_name, sc)
  }

  const cards: PersonaCard[] = []
  for (const [keyword, list] of byKw) {
    const cid = list[0]?.cid ?? null
    const collectedAt = list.reduce((m, r) => (r.collected_at > m ? r.collected_at : m), list[0]!.collected_at)

    const ageRaw = AGE_KEYS.map((k) => {
      const row = list.find((r) => r.age_bucket === k)
      return row ? row.share : 0
    })
    const ageNorm = normalize(ageRaw)
    const ageShares = Object.fromEntries(
      AGE_KEYS.map((k, i) => [k, ageNorm[i] ?? 0]),
    ) as Record<AgeKey, number>

    const mRow = list.find((r) => r.gender === 'm')
    const fRow = list.find((r) => r.gender === 'f')
    const genderRaw = [mRow?.share ?? 0, fRow?.share ?? 0]
    const gN = normalize(genderRaw)
    const genderShares = { m: gN[0] ?? 0, f: gN[1] ?? 0 }

    const pcRow = list.find((r) => r.device === 'pc')
    const moRow = list.find((r) => r.device === 'mo')
    const dvRaw = [pcRow?.share ?? 0, moRow?.share ?? 0]
    const dN = normalize(dvRaw)
    const deviceShares = { pc: dN[0] ?? 0, mo: dN[1] ?? 0 }

    cards.push({
      keyword,
      cid,
      collectedAt,
      ageShares,
      genderShares,
      deviceShares,
      ageHHI: hhi(ageNorm),
      finalScore: scoreByName.get(keyword) ?? null,
    })
  }

  // 정렬: 페르소나 집중도 × final_score (없으면 집중도만)
  cards.sort((a, b) => {
    const sa = a.ageHHI * (a.finalScore ?? 50)
    const sb_ = b.ageHHI * (b.finalScore ?? 50)
    return sb_ - sa
  })
  return cards
}

function fmtPct(x: number): string {
  return `${Math.round(x * 100)}%`
}

function PersonaBadge({ hhi }: { hhi: number }) {
  if (hhi >= 0.6) {
    return (
      <span className="inline-flex items-center gap-1 rounded bg-purple-100 text-purple-800 px-2 py-0.5 text-xs font-semibold">
        🎯 니치 페르소나
      </span>
    )
  }
  if (hhi <= 0.3) {
    return (
      <span className="inline-flex items-center gap-1 rounded bg-emerald-100 text-emerald-800 px-2 py-0.5 text-xs font-semibold">
        🌐 대중성
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1 rounded bg-gray-100 text-gray-700 px-2 py-0.5 text-xs">
      혼합
    </span>
  )
}

function AgeBars({ shares }: { shares: Record<AgeKey, number> }) {
  const max = Math.max(...AGE_KEYS.map((k) => shares[k]), 0.0001)
  return (
    <div className="flex items-end gap-1 h-16">
      {AGE_KEYS.map((k) => {
        const v = shares[k]
        const h = Math.max(4, Math.round((v / max) * 56))
        return (
          <div key={k} className="flex flex-col items-center gap-0.5 flex-1">
            <div
              className="w-full rounded-t bg-indigo-500/70"
              style={{ height: `${h}px` }}
              title={`${k}대 ${fmtPct(v)}`}
            />
            <div className="text-[10px] text-gray-500">{k}</div>
          </div>
        )
      })}
    </div>
  )
}

function GenderDonut({ m, f }: { m: number; f: number }) {
  // 단순 막대 2개로 도넛 대체 (SVG 없이 light-weight)
  const mPct = Math.round(m * 100)
  const fPct = Math.round(f * 100)
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2 text-xs">
        <span className="w-6 text-gray-500">남</span>
        <div className="flex-1 h-2 rounded bg-gray-100 overflow-hidden">
          <div className="h-full bg-blue-500" style={{ width: `${mPct}%` }} />
        </div>
        <span className="w-8 text-right font-mono">{mPct}%</span>
      </div>
      <div className="flex items-center gap-2 text-xs">
        <span className="w-6 text-gray-500">여</span>
        <div className="flex-1 h-2 rounded bg-gray-100 overflow-hidden">
          <div className="h-full bg-pink-500" style={{ width: `${fPct}%` }} />
        </div>
        <span className="w-8 text-right font-mono">{fPct}%</span>
      </div>
    </div>
  )
}

function DeviceSplit({ pc, mo }: { pc: number; mo: number }) {
  const pcPct = Math.round(pc * 100)
  const moPct = Math.round(mo * 100)
  return (
    <div className="flex items-center gap-2 text-xs">
      <div className="flex-1 h-2 rounded overflow-hidden flex bg-gray-100">
        <div className="h-full bg-slate-600" style={{ width: `${pcPct}%` }} />
        <div className="h-full bg-amber-500" style={{ width: `${moPct}%` }} />
      </div>
      <span className="font-mono text-gray-600">
        PC {pcPct}% · MO {moPct}%
      </span>
    </div>
  )
}

export default async function PersonasPage() {
  const cards = await fetchPersonas()

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold">키워드 인구통계 페르소나 락온</h1>
          <p className="text-sm text-gray-500 mt-1">
            Naver DataLab Shopping Insight 의 age/gender/device fan-out → 카테고리별 페르소나 핑거프린트.
            <br />
            집중도(HHI) × final_score 순. 0.6+ 는 광고 타겟팅·콘텐츠 카피 정확도가 가장 높은 후보.
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      {cards.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500">
          <p className="text-base font-medium">아직 인구통계 수집 결과가 없습니다</p>
          <p className="text-sm mt-2">
            cron <code className="px-1 bg-gray-100 rounded">/api/cron/collect-demographics</code>
            가 매일 1회 (KST 21:30) 핀+상위 8개 카테고리 시드를 fan-out 수집합니다.
            <br />
            DDL: <code className="px-1 bg-gray-100 rounded">supabase/trends_demographics.sql</code>
          </p>
        </div>
      ) : (
        <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {cards.map((c) => (
            <div
              key={c.keyword}
              className="rounded border border-gray-200 p-4 space-y-3 hover:border-gray-300 transition-colors"
            >
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="font-semibold">{c.keyword}</div>
                  <div className="text-xs text-gray-500 mt-0.5">
                    {c.cid ? `cid ${c.cid}` : '—'} · {c.collectedAt.slice(0, 10)}
                  </div>
                </div>
                <PersonaBadge hhi={c.ageHHI} />
              </div>

              <div>
                <div className="text-xs text-gray-500 mb-1">연령 분포</div>
                <AgeBars shares={c.ageShares} />
              </div>

              <div>
                <div className="text-xs text-gray-500 mb-1">성별</div>
                <GenderDonut m={c.genderShares.m} f={c.genderShares.f} />
              </div>

              <div>
                <div className="text-xs text-gray-500 mb-1">디바이스</div>
                <DeviceSplit pc={c.deviceShares.pc} mo={c.deviceShares.mo} />
              </div>

              <div className="flex items-center justify-between text-xs text-gray-500 pt-2 border-t border-gray-100">
                <span>
                  HHI(연령) <span className="font-mono font-semibold text-gray-900">{c.ageHHI.toFixed(2)}</span>
                </span>
                <span>
                  final_score{' '}
                  <span className="font-mono font-semibold text-gray-900">
                    {c.finalScore !== null ? c.finalScore : '—'}
                  </span>
                </span>
              </div>
            </div>
          ))}
        </section>
      )}
    </div>
  )
}
