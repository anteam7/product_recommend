import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import { SplitButton, ConfirmButton, MergeButton } from './ActionButtons'

export const dynamic = 'force-dynamic'

// ── 타입 ─────────────────────────────────────────────
interface ProductRow {
  id: string
  canonical_name: string
  category_top: string | null
  category_mid: string | null
}
interface AliasRow {
  id: string
  product_id: string
  alias: string
  alias_type: string
  source: string | null
  confidence: number
  classified_by: string | null
}

const TABS = ['over', 'under', 'llm'] as const
type Tab = (typeof TABS)[number]
const TAB_LABEL: Record<Tab, string> = {
  over: '오병합 후보',
  under: '과소병합 후보',
  llm: '고LLM비중',
}

// ── 토큰화 / 유사도 ──────────────────────────────────
// 한글 합성어 대응: 공백/기호 분리 토큰 + 글자 bigram 을 함께 set 에 담아 Jaccard 계산.
function tokenSet(s: string): Set<string> {
  const norm = (s || '').toLowerCase().replace(/[^0-9a-z가-힣]+/g, ' ').trim()
  const set = new Set<string>()
  for (const w of norm.split(/\s+/)) {
    if (!w) continue
    set.add(w)
  }
  const compact = norm.replace(/\s+/g, '')
  for (let i = 0; i < compact.length - 1; i++) set.add('§' + compact.slice(i, i + 2))
  return set
}
function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let inter = 0
  for (const t of a) if (b.has(t)) inter++
  return inter / (a.size + b.size - inter)
}

const isLlm = (a: AliasRow) =>
  (a.classified_by ?? '').toLowerCase().startsWith('llm') || a.confidence < 0.7

// ── 데이터 + 분석 ────────────────────────────────────
async function analyze() {
  const sb = createAdminClient()
  const [prodRes, aliasRes] = await Promise.all([
    sb.from('jimscanner_trends_products').select('id, canonical_name, category_top, category_mid').limit(2000),
    sb
      .from('jimscanner_trends_aliases')
      .select('id, product_id, alias, alias_type, source, confidence, classified_by')
      .limit(20000),
  ])
  const products = (prodRes.data ?? []) as ProductRow[]
  const aliases = (aliasRes.data ?? []) as AliasRow[]

  const prodById = new Map(products.map((p) => [p.id, p]))
  const aliasByProduct = new Map<string, AliasRow[]>()
  for (const a of aliases) {
    const arr = aliasByProduct.get(a.product_id) ?? []
    arr.push(a)
    aliasByProduct.set(a.product_id, arr)
  }

  // alias 토큰 캐시
  const tok = new Map<string, Set<string>>()
  const tokenOf = (s: string) => {
    let t = tok.get(s)
    if (!t) {
      t = tokenSet(s)
      tok.set(s, t)
    }
    return t
  }

  // ① 오병합: product 내 alias pairwise coherence (평균 Jaccard). 낮으면 이질 alias 혼입.
  const over: {
    product: ProductRow
    coherence: number
    score: number
    llmRatio: number
    aliases: AliasRow[]
    outlierId: string | null
  }[] = []
  for (const [pid, list] of aliasByProduct) {
    const product = prodById.get(pid)
    if (!product || list.length < 2) continue
    const sets = list.map((a) => tokenOf(a.alias))
    // 각 alias 의 '나머지에 대한 평균 유사도' → 전체 coherence + outlier 식별
    const avgSim: number[] = []
    let pairSum = 0
    let pairN = 0
    for (let i = 0; i < list.length; i++) {
      let s = 0
      for (let j = 0; j < list.length; j++) {
        if (i === j) continue
        const v = jaccard(sets[i], sets[j])
        s += v
        if (j > i) {
          pairSum += v
          pairN++
        }
      }
      avgSim.push(s / (list.length - 1))
    }
    const coherence = pairN ? pairSum / pairN : 1
    if (coherence >= 0.34) continue // 충분히 응집 → 통과
    const llmCnt = list.filter(isLlm).length
    const llmRatio = llmCnt / list.length
    // 점수: 비응집(1-coherence) × 규모 가중 × LLM 의존 가중
    const score = (1 - coherence) * (1 + Math.log2(list.length)) * (0.6 + 0.4 * llmRatio)
    // outlier = 나머지와 가장 안 맞는 alias (분할 후보)
    let outlierId: string | null = null
    let worst = Infinity
    for (let i = 0; i < list.length; i++) {
      if (avgSim[i] < worst) {
        worst = avgSim[i]
        outlierId = list[i].id
      }
    }
    over.push({ product, coherence, score, llmRatio, aliases: list, outlierId })
  }
  over.sort((a, b) => b.score - a.score)

  // ② 과소병합: 서로 다른 product 인데 대표 토큰셋이 가까움(중복 캐노니컬).
  //    대표 토큰셋 = canonical_name + 모든 alias 토큰 합집합. 같은 category_top 만 비교.
  const repr = products.map((p) => {
    const set = new Set<string>(tokenOf(p.canonical_name))
    for (const a of aliasByProduct.get(p.id) ?? []) for (const t of tokenOf(a.alias)) set.add(t)
    return { p, set }
  })
  const under: { a: ProductRow; b: ProductRow; sim: number }[] = []
  for (let i = 0; i < repr.length; i++) {
    for (let j = i + 1; j < repr.length; j++) {
      if ((repr[i].p.category_top ?? '') !== (repr[j].p.category_top ?? '')) continue
      const sim = jaccard(repr[i].set, repr[j].set)
      if (sim >= 0.5) under.push({ a: repr[i].p, b: repr[j].p, sim })
    }
  }
  under.sort((x, y) => y.sim - x.sim)

  // ③ 고LLM비중: product별 LLM/저신뢰 alias 비중.
  const llm = [...aliasByProduct.entries()]
    .map(([pid, list]) => {
      const product = prodById.get(pid)
      const llmCnt = list.filter(isLlm).length
      return product ? { product, total: list.length, llmCnt, ratio: llmCnt / list.length, aliases: list } : null
    })
    .filter((x): x is NonNullable<typeof x> => !!x && x.llmCnt > 0)
    .sort((a, b) => b.ratio - a.ratio || b.llmCnt - a.llmCnt)

  return {
    over,
    under: under.slice(0, 100),
    llm,
    kpis: {
      products: products.length,
      aliases: aliases.length,
      over: over.length,
      under: under.length,
      llmAliases: aliases.filter(isLlm).length,
    },
  }
}

// ── 페이지 ───────────────────────────────────────────
export default async function IntegrityPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>
}) {
  const sp = await searchParams
  const tab = (TABS.includes(sp.tab as Tab) ? sp.tab : 'over') as Tab
  const { over, under, llm, kpis } = await analyze()

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold">병합 무결성 감사</h1>
          <p className="text-sm text-gray-500 mt-1">
            alias→캐노니컬 병합 정합성을 사후 검증한다. 집계 단위가 틀리면 수요·경쟁·점수가 조용히 오염된다.
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      <section className="grid grid-cols-3 md:grid-cols-5 gap-3">
        <Kpi label="캐노니컬" value={kpis.products} />
        <Kpi label="alias 총계" value={kpis.aliases} />
        <Kpi label="오병합 후보" value={kpis.over} tone="rose" />
        <Kpi label="과소병합 후보" value={kpis.under} tone="indigo" />
        <Kpi label="LLM/저신뢰 alias" value={kpis.llmAliases} tone="amber" />
      </section>

      <nav className="flex gap-2 border-b border-gray-200">
        {TABS.map((t) => (
          <Link
            key={t}
            href={`/admin/trend-radar/integrity?tab=${t}`}
            className={`px-3 py-2 text-sm ${
              tab === t
                ? 'border-b-2 border-black font-semibold text-black'
                : 'text-gray-500 hover:text-black'
            }`}
          >
            {TAB_LABEL[t]}
          </Link>
        ))}
      </nav>

      {tab === 'over' && <OverTab rows={over} />}
      {tab === 'under' && <UnderTab rows={under} />}
      {tab === 'llm' && <LlmTab rows={llm} />}
    </div>
  )
}

// ── 오병합 탭 ────────────────────────────────────────
function OverTab({
  rows,
}: {
  rows: {
    product: ProductRow
    coherence: number
    score: number
    llmRatio: number
    aliases: AliasRow[]
    outlierId: string | null
  }[]
}) {
  if (rows.length === 0) return <Empty msg="이질 alias 가 섞인 캐노니컬 후보가 없습니다. (coherence ≥ 0.34)" />
  return (
    <div className="space-y-3">
      <p className="text-xs text-gray-500">
        한 캐노니컬 안의 alias 들이 토큰 Jaccard 상 서로 멀면(coherence↓) 본체+액세서리처럼 이질 상품이 섞였을 가능성.
        의심 alias(✂)를 새 캐노니컬로 분할하세요.
      </p>
      {rows.map((r) => (
        <div key={r.product.id} className="rounded border border-rose-200 bg-rose-50/30 p-3">
          <div className="flex items-center justify-between">
            <Link
              href={`/admin/trend-radar/products/${r.product.id}`}
              className="font-medium hover:underline"
            >
              {r.product.canonical_name}
            </Link>
            <div className="text-xs font-mono text-gray-600">
              coherence {r.coherence.toFixed(2)} · LLM {(r.llmRatio * 100).toFixed(0)}% ·{' '}
              <span className="font-bold text-rose-700">score {r.score.toFixed(2)}</span>
            </div>
          </div>
          <div className="mt-2 divide-y divide-rose-100">
            {r.aliases.map((a) => (
              <div key={a.id} className="grid grid-cols-12 items-center py-1.5 text-sm">
                <div className="col-span-5 flex items-center gap-1">
                  {a.id === r.outlierId && <span title="가장 이질적">⚠️</span>}
                  <span className={a.id === r.outlierId ? 'font-semibold text-rose-700' : ''}>{a.alias}</span>
                </div>
                <div className="col-span-2 text-xs text-gray-500">{a.alias_type}</div>
                <div className="col-span-2 text-xs text-gray-500">{a.classified_by ?? '—'}</div>
                <div className="col-span-1 text-right text-xs font-mono text-gray-600">
                  {a.confidence?.toFixed(2)}
                </div>
                <div className="col-span-2 text-right">
                  <SplitButton aliasId={a.id} productId={r.product.id} />
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

// ── 과소병합 탭 ──────────────────────────────────────
function UnderTab({ rows }: { rows: { a: ProductRow; b: ProductRow; sim: number }[] }) {
  if (rows.length === 0) return <Empty msg="중복 의심 캐노니컬 쌍이 없습니다. (대표 토큰 유사도 < 0.5)" />
  return (
    <div className="space-y-2">
      <p className="text-xs text-gray-500">
        서로 다른 캐노니컬인데 대표 토큰이 가까운 쌍 — 같은 상품이 둘로 흩어진 '중복 캐노니컬' 후보. 병합(⇉)하면 왼쪽이 오른쪽으로 흡수됩니다.
      </p>
      {rows.map((r, i) => (
        <div
          key={i}
          className="grid grid-cols-12 items-center rounded border border-indigo-200 bg-indigo-50/30 px-3 py-2 text-sm"
        >
          <Link
            href={`/admin/trend-radar/products/${r.a.id}`}
            className="col-span-5 hover:underline"
          >
            {r.a.canonical_name}
            <span className="text-xs text-gray-400"> · {r.a.category_top ?? '—'}</span>
          </Link>
          <Link
            href={`/admin/trend-radar/products/${r.b.id}`}
            className="col-span-4 hover:underline"
          >
            {r.b.canonical_name}
          </Link>
          <div className="col-span-1 text-right text-xs font-mono font-bold text-indigo-700">
            {r.sim.toFixed(2)}
          </div>
          <div className="col-span-2 text-right">
            <MergeButton sourceId={r.a.id} targetId={r.b.id} />
          </div>
        </div>
      ))}
    </div>
  )
}

// ── 고LLM비중 탭 ─────────────────────────────────────
function LlmTab({
  rows,
}: {
  rows: { product: ProductRow; total: number; llmCnt: number; ratio: number; aliases: AliasRow[] }[]
}) {
  if (rows.length === 0) return <Empty msg="LLM/저신뢰 매핑이 없습니다." />
  return (
    <div className="space-y-2">
      <p className="text-xs text-gray-500">
        LLM(confidence&lt;0.7 / classified_by=llm*) 매핑 비중이 높은 캐노니컬 — 검증 우선순위. 옳은 매핑은 ✓확정(confidence=1.0)으로 재분류에서 제외.
      </p>
      {rows.map((r) => (
        <details key={r.product.id} className="rounded border border-amber-200 bg-amber-50/30 px-3 py-2">
          <summary className="flex cursor-pointer items-center justify-between text-sm">
            <Link href={`/admin/trend-radar/products/${r.product.id}`} className="font-medium hover:underline">
              {r.product.canonical_name}
            </Link>
            <span className="text-xs font-mono text-gray-600">
              LLM {r.llmCnt}/{r.total} ·{' '}
              <span className="font-bold text-amber-700">{(r.ratio * 100).toFixed(0)}%</span>
            </span>
          </summary>
          <div className="mt-2 divide-y divide-amber-100">
            {r.aliases.filter(isLlm).map((a) => (
              <div key={a.id} className="grid grid-cols-12 items-center py-1.5 text-sm">
                <div className="col-span-6">{a.alias}</div>
                <div className="col-span-2 text-xs text-gray-500">{a.classified_by ?? '—'}</div>
                <div className="col-span-2 text-right text-xs font-mono text-gray-600">
                  {a.confidence?.toFixed(2)}
                </div>
                <div className="col-span-2 text-right">
                  <ConfirmButton aliasId={a.id} productId={r.product.id} />
                </div>
              </div>
            ))}
          </div>
        </details>
      ))}
    </div>
  )
}

// ── 공통 ─────────────────────────────────────────────
function Kpi({
  label,
  value,
  tone,
}: {
  label: string
  value: number
  tone?: 'rose' | 'indigo' | 'amber'
}) {
  const c =
    tone === 'rose'
      ? 'text-rose-700'
      : tone === 'indigo'
        ? 'text-indigo-700'
        : tone === 'amber'
          ? 'text-amber-700'
          : 'text-black'
  return (
    <div className="rounded border border-gray-200 p-4">
      <div className="text-xs text-gray-500">{label}</div>
      <div className={`text-3xl font-bold mt-1 ${c}`}>{value.toLocaleString()}</div>
    </div>
  )
}

function Empty({ msg }: { msg: string }) {
  return (
    <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500">
      <p className="text-base font-medium">✓ 깨끗합니다</p>
      <p className="text-sm mt-2">{msg}</p>
    </div>
  )
}
