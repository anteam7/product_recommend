import { createAdminClient } from '@/lib/auth/admin-supabase'
import EntityQaClient, {
  type UnderMergePair,
  type OverMergeRow,
  type LowConfRow,
  type AbsorbRow,
} from './EntityQaClient'

export const dynamic = 'force-dynamic'

interface HistRow {
  bucket: number
  classified_by: string
  cnt: number
}

async function fetchData() {
  const sb = createAdminClient()
  // 신규 RPC (supabase/trends_v4_entity_qa.sql) — generated 타입 미반영, `as never` 캐스팅.
  const [under, over, low, absorb, hist] = await Promise.all([
    sb.rpc('jimscanner_trends_entity_undermerge' as never, { p_min_sim: 0.45, p_limit: 120 } as never),
    sb.rpc('jimscanner_trends_entity_overmerge' as never, { p_max_sim: 0.15, p_limit: 120 } as never),
    sb.rpc('jimscanner_trends_entity_lowconf_anchor' as never, { p_max_conf: 0.6, p_limit: 120 } as never),
    sb.rpc('jimscanner_trends_entity_absorb' as never, { p_min_sim: 0.4, p_limit: 120 } as never),
    sb.rpc('jimscanner_trends_entity_conf_histogram' as never, {} as never),
  ])

  const firstErr = under.error || over.error || low.error || absorb.error || hist.error
  return {
    underMerge: (under.data ?? []) as unknown as UnderMergePair[],
    overMerge: (over.data ?? []) as unknown as OverMergeRow[],
    lowConf: (low.data ?? []) as unknown as LowConfRow[],
    absorb: (absorb.data ?? []) as unknown as AbsorbRow[],
    hist: (hist.data ?? []) as unknown as HistRow[],
    error: firstErr?.message as string | undefined,
  }
}

export default async function EntityQaPage() {
  const { underMerge, overMerge, lowConf, absorb, hist, error } = await fetchData()

  // confidence 히스토그램 (출처별 스택). bucket 0.0~0.9.
  const buckets = Array.from({ length: 10 }, (_, i) => i / 10)
  const sources = Array.from(new Set(hist.map((h) => h.classified_by))).sort()
  const srcColor: Record<string, string> = {
    manual: 'bg-emerald-500',
    llm_haiku: 'bg-amber-500',
    rule_engine: 'bg-sky-500',
    unknown: 'bg-gray-400',
  }
  const byBucket = new Map<number, HistRow[]>()
  for (const h of hist) {
    const k = Math.round(h.bucket * 10) / 10
    if (!byBucket.has(k)) byBucket.set(k, [])
    byBucket.get(k)!.push(h)
  }
  const maxBucketTotal = Math.max(
    1,
    ...buckets.map((b) => (byBucket.get(b) ?? []).reduce((s, r) => s + r.cnt, 0)),
  )
  const total = hist.reduce((s, r) => s + r.cnt, 0)

  return (
    <div className="space-y-6 p-6">
      <header>
        <h1 className="text-2xl font-bold">엔티티 해상도 QA</h1>
        <p className="text-sm text-gray-500 mt-1">
          alias→canonical 매핑 품질 점검. 분열은 final_score 를 과소평가하고, 과병합은 alias_count·점수를 왜곡합니다.
          모든 점수 보드의 기반 데이터 품질 축입니다.
        </p>
      </header>

      {error && (
        <div className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          RPC 오류: {error}
          <div className="text-xs text-red-500 mt-1">
            <code>supabase/trends_v4_entity_qa.sql</code> 적용이 필요할 수 있습니다.
          </div>
        </div>
      )}

      {/* confidence 히스토그램 */}
      <section>
        <h2 className="text-base font-bold mb-2">
          별칭 confidence 분포 · 총 {total}건
        </h2>
        <div className="rounded border border-gray-200 p-4">
          <div className="flex items-end gap-2 h-40">
            {buckets.map((b) => {
              const rows = byBucket.get(b) ?? []
              const t = rows.reduce((s, r) => s + r.cnt, 0)
              return (
                <div key={b} className="flex-1 flex flex-col items-center justify-end h-full">
                  <div className="text-[10px] text-gray-500 mb-1">{t || ''}</div>
                  <div
                    className="w-full flex flex-col-reverse"
                    style={{ height: `${(t / maxBucketTotal) * 100}%` }}
                  >
                    {sources.map((s) => {
                      const c = rows.find((r) => r.classified_by === s)?.cnt ?? 0
                      if (!c) return null
                      return (
                        <div
                          key={s}
                          className={srcColor[s] ?? 'bg-gray-400'}
                          style={{ height: `${(c / Math.max(t, 1)) * 100}%` }}
                          title={`${s}: ${c} @ ${b.toFixed(1)}`}
                        />
                      )
                    })}
                  </div>
                  <div className="text-[10px] text-gray-400 mt-1 font-mono">{b.toFixed(1)}</div>
                </div>
              )
            })}
          </div>
          <div className="flex gap-3 mt-3 text-[11px]">
            {sources.map((s) => (
              <span key={s} className="flex items-center gap-1">
                <span className={`inline-block w-2.5 h-2.5 rounded-sm ${srcColor[s] ?? 'bg-gray-400'}`} />
                {s}
              </span>
            ))}
          </div>
          <p className="text-[11px] text-gray-400 mt-2">
            0.6 미만 amber(llm_haiku) 구간이 두꺼우면 저신뢰 앵커가 많다는 신호입니다.
          </p>
        </div>
      </section>

      <EntityQaClient
        underMerge={underMerge}
        overMerge={overMerge}
        lowConf={lowConf}
        absorb={absorb}
      />
    </div>
  )
}
