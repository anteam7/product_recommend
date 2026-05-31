// ─────────────────────────────────────────────────────────────
// 파레토 비지배(non-dominated) 집합 계산
// ─────────────────────────────────────────────────────────────
// 후보를 다차원 벡터(trend / commerce / supplier / competition)로 보고
// '지배 관계'를 판정한다. 모든 축은 "클수록 좋음".
//   - A dominates B  ⇔  A 가 모든 축에서 B 이상이고, 최소 한 축에서 B 초과
//   - 비지배(레이어 1) = 자신을 지배하는 후보가 하나도 없는 집합 (= 프론티어)
//   - 레이어 2/3 = 레이어 1 을 제거한 뒤 다시 비지배인 집합 … (NSGA-II 비지배 정렬)
// dominated 후보에는 '지배자(dominator)' 를 명시해 작업 큐에서 제외 근거를 남긴다.

export interface Candidate {
  id: string
  name: string
  category: string
  trend: number
  commerce: number
  supplier: number
  competition: number
  final: number
}

export interface FrontierNode extends Candidate {
  /** 파레토 레이어 (1 = 비지배 프론티어, 2·3 = 후순위) */
  layer: number
  /** 이 후보를 지배하는 후보 수 (0 이면 프론티어) */
  dominatedByCount: number
  /** 대표 지배자 (모든 면에서 이 후보를 누른 가장 강한 후보, 없으면 null) */
  dominator: { id: string; name: string; final: number } | null
}

const AXES: (keyof Candidate)[] = ['trend', 'commerce', 'supplier', 'competition']

/** a 가 b 를 지배하면 true */
function dominates(a: Candidate, b: Candidate): boolean {
  let strictlyBetter = false
  for (const ax of AXES) {
    const av = a[ax] as number
    const bv = b[ax] as number
    if (av < bv) return false
    if (av > bv) strictlyBetter = true
  }
  return strictlyBetter
}

/**
 * 비지배 정렬: 각 후보에 파레토 레이어와 대표 지배자를 부여한다.
 * N(후보 수)이 수백 규모이므로 O(N^2) 단순 구현으로 충분.
 */
export function computeFrontier(cands: Candidate[]): FrontierNode[] {
  const n = cands.length
  // dominatedBy[i] = i 를 지배하는 후보 인덱스 목록
  const dominatedBy: number[][] = Array.from({ length: n }, () => [])
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i === j) continue
      if (dominates(cands[j], cands[i])) dominatedBy[i].push(j)
    }
  }

  // 비지배 정렬로 레이어 산출
  const layer = new Array<number>(n).fill(0)
  const remainingCount = dominatedBy.map((d) => d.length)
  let assigned = 0
  let currentLayer = 1
  const removed = new Array<boolean>(n).fill(false)
  while (assigned < n) {
    const thisLayer: number[] = []
    for (let i = 0; i < n; i++) {
      if (!removed[i] && remainingCount[i] === 0) thisLayer.push(i)
    }
    // 안전장치: 진행 불가 시 남은 전부를 현재 레이어로
    if (thisLayer.length === 0) {
      for (let i = 0; i < n; i++) {
        if (!removed[i]) thisLayer.push(i)
      }
    }
    for (const i of thisLayer) {
      layer[i] = currentLayer
      removed[i] = true
      assigned++
    }
    // 제거된 지배자를 잃은 후보들의 카운트 감소
    for (let i = 0; i < n; i++) {
      if (removed[i]) continue
      remainingCount[i] = dominatedBy[i].filter((j) => !removed[j]).length
    }
    currentLayer++
  }

  return cands.map((c, i) => {
    // 대표 지배자: 지배자 중 final_score 최고
    let best: { id: string; name: string; final: number } | null = null
    for (const j of dominatedBy[i]) {
      const d = cands[j]
      if (!best || d.final > best.final) best = { id: d.id, name: d.name, final: d.final }
    }
    return {
      ...c,
      layer: layer[i],
      dominatedByCount: dominatedBy[i].length,
      dominator: best,
    }
  })
}

/**
 * 2D 투영(competition=x, trend=y) 에서의 프론티어 staircase 점 목록.
 * 화면에 그릴 '프론티어 라인'용. (전체 차원 지배와 별개로, 보여주는 두 축에서의 상단-우측 경계)
 */
export function frontier2D(cands: Candidate[]): { x: number; y: number }[] {
  const pts = cands
    .filter((c) =>
      !cands.some(
        (o) => o !== c && o.competition >= c.competition && o.trend >= c.trend && (o.competition > c.competition || o.trend > c.trend),
      ),
    )
    .map((c) => ({ x: c.competition, y: c.trend }))
  // x 오름차순, 동일 x 면 y 큰 것 우선
  pts.sort((a, b) => a.x - b.x || b.y - a.y)
  return pts
}
