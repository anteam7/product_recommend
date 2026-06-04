import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import {
  classifyIntent,
  extractSuffix,
  INTENT_META,
  type AutocompleteIntent,
} from '@/lib/autocomplete-intent'

export const dynamic = 'force-dynamic'

interface RawRow {
  query: string | null
  title: string | null
  captured_at: string
}

interface LeafNode {
  suggestion: string
  suffix: string
  intent: AutocompleteIntent
  uncovered: boolean
}

interface SeedTree {
  seed: string
  leaves: LeafNode[]
  intentCounts: Record<AutocompleteIntent, number>
  uncoveredCount: number
}

const INTENT_ORDER: AutocompleteIntent[] = [
  'spec',
  'compare',
  'problem',
  'price',
  'accessory',
  'generic',
]

async function fetchData() {
  const sb = createAdminClient()
  const since14d = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString()

  // google_suggest raw 적재분 + 커버리지 판정용 alias 사전을 병렬 로드
  const [rawRes, aliasRes] = await Promise.all([
    sb
      .from('jimscanner_market_raw')
      .select('query, title, captured_at')
      .eq('source', 'google_suggest')
      .gte('captured_at', since14d)
      .order('captured_at', { ascending: false })
      .limit(4000),
    // alias 사전 — 미커버 롱테일 강조용. 타입 미반영 컬럼은 page 내 좁히기로 처리.
    sb.from('jimscanner_trends_aliases').select('alias').limit(5000),
  ])

  const aliasSet = new Set<string>()
  for (const a of (aliasRes.data ?? []) as { alias: string | null }[]) {
    if (a.alias) aliasSet.add(a.alias.toLowerCase())
  }

  const rows = (rawRes.data ?? []) as RawRow[]
  const bySeed = new Map<string, SeedTree>()

  for (const r of rows) {
    const seed = (r.query ?? '').trim()
    const suggestion = (r.title ?? '').trim()
    if (!seed || !suggestion) continue

    let tree = bySeed.get(seed)
    if (!tree) {
      tree = {
        seed,
        leaves: [],
        intentCounts: {
          spec: 0,
          compare: 0,
          problem: 0,
          price: 0,
          accessory: 0,
          generic: 0,
        },
        uncoveredCount: 0,
      }
      bySeed.set(seed, tree)
    }

    // seed 와 동일한 항목은 트리 잎으로 의미 없음
    if (suggestion.toLowerCase() === seed.toLowerCase()) continue
    if (tree.leaves.some((l) => l.suggestion === suggestion)) continue

    const intent = classifyIntent(suggestion, seed)
    const suffix = extractSuffix(suggestion, seed)
    // 자동완성 전체 문구가 어떤 alias 에도 안 잡히면 '미커버 롱테일'
    const covered =
      aliasSet.has(suggestion.toLowerCase()) ||
      [...aliasSet].some((a) => a.length >= 3 && suggestion.toLowerCase().includes(a))
    const uncovered = !covered

    tree.leaves.push({ suggestion, suffix, intent, uncovered })
    tree.intentCounts[intent]++
    if (uncovered) tree.uncoveredCount++
  }

  const trees = [...bySeed.values()].sort((a, b) => b.leaves.length - a.leaves.length)

  // 전체 의도 집계
  const totalIntents: Record<AutocompleteIntent, number> = {
    spec: 0,
    compare: 0,
    problem: 0,
    price: 0,
    accessory: 0,
    generic: 0,
  }
  let totalLeaves = 0
  let totalUncovered = 0
  for (const t of trees) {
    totalLeaves += t.leaves.length
    totalUncovered += t.uncoveredCount
    for (const k of INTENT_ORDER) totalIntents[k] += t.intentCounts[k]
  }

  const lastCaptured = rows[0]?.captured_at ?? null

  return { trees, totalIntents, totalLeaves, totalUncovered, lastCaptured }
}

function IntentBadge({ intent }: { intent: AutocompleteIntent }) {
  const m = INTENT_META[intent]
  return (
    <span className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-medium ${m.badge}`}>
      {m.label}
    </span>
  )
}

export default async function AutocompletePage() {
  const { trees, totalIntents, totalLeaves, totalUncovered, lastCaptured } = await fetchData()

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold">자동완성 수요 트리</h1>
          <p className="mt-1 text-sm text-gray-500">
            검색엔진 자동완성 = 무료 수요 검증 신호. 시드별 롱테일 suffix 를 5종 구매의도로
            라벨링해 소싱 변형·리스팅 카피 소재를 발굴한다.
          </p>
        </div>
        <Link
          href="/admin/trend-radar"
          className="text-sm text-gray-700 underline hover:text-black"
        >
          ← 대시보드
        </Link>
      </header>

      {/* 요약 통계 */}
      <section className="flex flex-wrap items-center gap-3 text-sm">
        <div className="rounded border border-gray-200 px-3 py-2">
          <span className="text-gray-500">시드</span>{' '}
          <span className="font-semibold">{trees.length}</span>
        </div>
        <div className="rounded border border-gray-200 px-3 py-2">
          <span className="text-gray-500">롱테일 suffix</span>{' '}
          <span className="font-semibold">{totalLeaves}</span>
        </div>
        <div className="rounded border border-amber-200 bg-amber-50 px-3 py-2">
          <span className="text-amber-700">미커버 롱테일</span>{' '}
          <span className="font-semibold text-amber-800">{totalUncovered}</span>
        </div>
        {INTENT_ORDER.filter((k) => k !== 'generic').map((k) => (
          <div key={k} className="rounded border border-gray-200 px-3 py-2">
            <IntentBadge intent={k} />{' '}
            <span className="font-semibold">{totalIntents[k]}</span>
          </div>
        ))}
      </section>

      {trees.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-8 text-center text-sm text-gray-500">
          <p className="mb-2 font-medium text-gray-700">
            아직 자동완성 수요 데이터가 없습니다.
          </p>
          <p>
            수집 실행:{' '}
            <code className="rounded bg-gray-100 px-1.5 py-0.5 font-mono text-xs">
              node --env-file=.env.local scripts/collect-autocomplete.mjs
            </code>
          </p>
        </div>
      ) : (
        <section className="space-y-3">
          {trees.map((t) => (
            <details
              key={t.seed}
              className="group rounded border border-gray-200"
              open={t.uncoveredCount > 0}
            >
              <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-3 hover:bg-gray-50">
                <div className="flex items-center gap-3">
                  <span className="text-gray-400 group-open:rotate-90">▶</span>
                  <span className="font-semibold">{t.seed}</span>
                  <span className="text-xs text-gray-400">{t.leaves.length}개</span>
                </div>
                <div className="flex items-center gap-1.5">
                  {INTENT_ORDER.filter((k) => t.intentCounts[k] > 0).map((k) => (
                    <span key={k} className="flex items-center gap-0.5">
                      <IntentBadge intent={k} />
                      <span className="text-[10px] text-gray-500">{t.intentCounts[k]}</span>
                    </span>
                  ))}
                  {t.uncoveredCount > 0 && (
                    <span className="ml-1 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-800">
                      미커버 {t.uncoveredCount}
                    </span>
                  )}
                </div>
              </summary>
              <div className="divide-y divide-gray-100 border-t border-gray-100">
                {t.leaves.map((l) => (
                  <div
                    key={l.suggestion}
                    className={`flex items-center justify-between px-4 py-2 text-sm ${
                      l.uncovered ? 'bg-amber-50/40' : ''
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <span className="text-gray-300">└</span>
                      <span className="text-gray-400">{t.seed}</span>
                      <span className="font-medium text-gray-900">{l.suffix}</span>
                      {l.uncovered && (
                        <span className="rounded bg-amber-100 px-1 py-0.5 text-[9px] font-medium text-amber-700">
                          미커버
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      <IntentBadge intent={l.intent} />
                      <span className="hidden text-[10px] text-gray-400 sm:inline">
                        {INTENT_META[l.intent].route}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </details>
          ))}
        </section>
      )}

      <section className="rounded border border-dashed border-gray-300 p-4 text-xs text-gray-500">
        <strong className="text-gray-700">파이프라인:</strong>{' '}
        ① <code className="font-mono">collect-autocomplete.mjs</code> 가 추천·핀·미커버 시드를
        google/naver 자동완성에 2단 재귀 질의 → market_raw(source=google_suggest) 적재 · ②
        suffix 를 5종 의도로 규칙 라벨링 · ③ 스펙변형=소싱 변형 후보, 문제·비교=상세 카피 소재로
        라우팅. 마지막 수집:{' '}
        {lastCaptured ? lastCaptured.slice(0, 16).replace('T', ' ') : '—'}
      </section>
    </div>
  )
}
