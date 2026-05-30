import { createAdminClient } from '@/lib/auth/admin-supabase'
import PersonaBoard, {
  AGE_ORDER,
  GENDER_ORDER,
  type PersonaProfile,
  type PersonaCell,
} from './PersonaBoard'

export const dynamic = 'force-dynamic'

export const metadata = { title: '페르소나 핏 보드 · 트렌드 레이더' }

type Row = {
  keyword: string
  source: string
  category: string | null
  gender: string
  age_bucket: string
  ratio: number | null
  collected_at: string
}

/** 정규화 엔트로피 기반 집중도(0~100). 단일 세그먼트에 쏠릴수록 높음 */
function concentration(cells: PersonaCell[]): number {
  const vals = cells.map((c) => Math.max(0, c.ratio))
  const sum = vals.reduce((a, b) => a + b, 0)
  if (sum <= 0) return 0
  const n = vals.length
  let h = 0
  for (const v of vals) {
    const p = v / sum
    if (p > 0) h += -p * Math.log(p)
  }
  const norm = n > 1 ? h / Math.log(n) : 0 // 0~1 (1=완전 균등)
  return Math.round((1 - norm) * 100)
}

function topPersona(cells: PersonaCell[]): string {
  let best: PersonaCell | null = null
  for (const c of cells) if (!best || c.ratio > best.ratio) best = c
  if (!best) return '-'
  return `${best.gender === 'f' ? '여' : '남'}·${best.age_bucket}`
}

export default async function PersonaPage() {
  const supabase = createAdminClient()

  // 신규 테이블 — 생성된 DB 타입에 아직 없어 as any 캐스팅
  const { data } = await (supabase as any)
    .from('jimscanner_trends_demographics')
    .select('keyword, source, category, gender, age_bucket, ratio, collected_at')
    .order('collected_at', { ascending: false })
    .limit(4000)

  const rows = (data ?? []) as Row[]

  // 키워드별 그룹 → 날짜별 세그먼트 맵
  const byKeyword = new Map<string, Row[]>()
  for (const r of rows) {
    const k = `${r.source}::${r.keyword}`
    if (!byKeyword.has(k)) byKeyword.set(k, [])
    byKeyword.get(k)!.push(r)
  }

  const segKey = (g: string, a: string) => `${g}|${a}`

  const profiles: PersonaProfile[] = []
  for (const [, list] of byKeyword) {
    if (list.length === 0) continue
    const dates = [...new Set(list.map((r) => r.collected_at))].sort().reverse()
    const latestDate = dates[0]
    const prevDate = dates[1]

    const latestRows = list.filter((r) => r.collected_at === latestDate)
    const cells: PersonaCell[] = []
    for (const g of GENDER_ORDER) {
      for (const a of AGE_ORDER) {
        const r = latestRows.find((x) => x.gender === g && x.age_bucket === a)
        cells.push({ gender: g, age_bucket: a, ratio: r?.ratio ?? 0 })
      }
    }

    const latestTotal = cells.reduce((s, c) => s + c.ratio, 0)
    let demandRise = 50 // 보합 기본값
    if (prevDate) {
      const prevRows = list.filter((r) => r.collected_at === prevDate)
      const prevTotal = prevRows.reduce((s, r) => s + (r.ratio ?? 0), 0)
      if (prevTotal > 0) {
        const change = (latestTotal - prevTotal) / prevTotal
        demandRise = Math.max(0, Math.min(100, 50 + change * 50))
      }
    }

    const first = list[0]
    profiles.push({
      keyword: first.keyword,
      source: first.source,
      category: first.category,
      cells,
      // 절대 수요는 세그먼트 평균(0~100 척도 유지)
      demand: cells.length ? latestTotal / cells.length : 0,
      concentration: concentration(cells),
      demandRise,
      topPersona: topPersona(cells),
    })
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">페르소나 핏 보드 · 트렌드 레이더</h1>
        <p className="mt-1 text-sm text-neutral-600">
          성별×연령으로 쪼갠 수요 프로파일. <b>타겟이 또렷할수록</b>(집중도↑) 광고·썸네일·묶음
          적중률이 높아 위탁 후보로 유리합니다. 우상단(집중도↑·수요상승↑)이 우선 큐.
        </p>
      </div>
      <PersonaBoard profiles={profiles} />
    </div>
  )
}
