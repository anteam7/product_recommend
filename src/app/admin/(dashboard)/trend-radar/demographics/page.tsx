import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import {
  DEMO_SOURCE,
  computeDemoProfile,
  dominantSegmentLabel,
  type DemoAgeVector,
  type DemoGenderVector,
} from '@/lib/trends/demographics'
import DemographicsBoard, { type DemoRow } from './DemographicsBoard'

export const dynamic = 'force-dynamic'

type RawRow = {
  keyword: string
  source: string
  collected_at: string
  demo_age: DemoAgeVector | null
  demo_gender: DemoGenderVector | null
}

async function fetchRows(): Promise<DemoRow[]> {
  const sb = createAdminClient()

  // demo 벡터가 있는 최신 row (마이그레이션 후 demo_age 컬럼 존재 가정 → as any)
  const { data } = await sb
    .from('jimscanner_trends_keywords')
    .select('keyword, source, collected_at, demo_age, demo_gender')
    .eq('source', DEMO_SOURCE)
    .order('collected_at', { ascending: false })
    .limit(2000)

  const rows = (data ?? []) as unknown as RawRow[]

  // keyword 별 최신 1건만
  const seen = new Set<string>()
  const out: DemoRow[] = []
  for (const r of rows) {
    if (!r.demo_age) continue
    if (seen.has(r.keyword)) continue
    seen.add(r.keyword)
    const profile = computeDemoProfile(r.demo_age, r.demo_gender)
    out.push({
      keyword: r.keyword,
      source: r.source,
      collectedAt: r.collected_at,
      concentration: profile.concentration,
      dominantAge: profile.dominantAge,
      dominantGender: profile.dominantGender,
      dominantLabel: dominantSegmentLabel(profile),
      ageShares: profile.ageShares,
      genderShares: {
        m: Number(r.demo_gender?.m ?? 0),
        f: Number(r.demo_gender?.f ?? 0),
      },
    })
  }

  // genderShares 정규화
  for (const r of out) {
    const sum = r.genderShares.m + r.genderShares.f
    if (sum > 0) {
      r.genderShares = { m: r.genderShares.m / sum, f: r.genderShares.f / sum }
    }
  }

  return out
}

export default async function DemographicsPage() {
  const rows = await fetchRows()

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold">인구통계 수요 프로파일</h1>
          <p className="mt-1 text-sm text-gray-500">
            Naver DataLab 연령·성별 분해 — '누가 사는가'로 1인 셀러가 경쟁을 피할 세그먼트를 발굴.
          </p>
        </div>
        <Link
          href="/admin/trend-radar"
          className="text-sm text-gray-700 underline hover:text-black"
        >
          ← 대시보드
        </Link>
      </header>

      {rows.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500">
          아직 데모그래픽 데이터 없음. <code>collect-naver-demographics</code> cron 누적 후 다시 방문.
          <br />
          (마이그레이션 <code>supabase/trends_demographics.sql</code> 적용 필요)
        </div>
      ) : (
        <DemographicsBoard rows={rows} />
      )}
    </div>
  )
}
