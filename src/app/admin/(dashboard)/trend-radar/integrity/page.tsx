import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import { IntegrityActions } from './IntegrityActions'

export const dynamic = 'force-dynamic'

type Kind = 'duplicate_suspect' | 'hetero_merge' | 'orphan_alias'

interface AuditRow {
  kind: Kind
  product_a_id: string
  product_a_name: string
  product_b_id: string | null
  product_b_name: string | null
  category: string | null
  score: number
  detail: Record<string, any>
}

interface IgnoredRow {
  finding_key: string
}

const KIND_META: Record<Kind, { label: string; blurb: string; accent: string }> = {
  duplicate_suspect: {
    label: '중복 의심 (분산 → 신호 과소집계)',
    blurb: '같은 카테고리에서 canonical_name 유사도가 높은 쌍. 같은 상품이면 [병합]해 신호를 합산.',
    accent: 'border-amber-300 bg-amber-50',
  },
  hetero_merge: {
    label: '이질 병합 의심 (오집계 → 점수 과대)',
    blurb: 'alias 평균 신뢰도가 낮은 클러스터. 서로 다른 상품이 섞였다면 alias 를 [분리].',
    accent: 'border-rose-300 bg-rose-50',
  },
  orphan_alias: {
    label: '고아 alias (저신뢰 매핑)',
    blurb: 'confidence < 0.6 인 자동 매핑. 잘못 붙었으면 [분리]해 별도 canonical 로.',
    accent: 'border-slate-300 bg-slate-50',
  },
}

function findingKey(r: AuditRow): string {
  return `${r.kind}:${r.product_a_id}:${r.product_b_id ?? r.product_b_name ?? ''}`
}

async function fetchData() {
  const sb = createAdminClient()

  // 감사 뷰 (마이그레이션 trends_integrity_audit.sql 적용 후 존재)
  const { data: auditRaw, error } = (await sb
    .from('jimscanner_trends_integrity_audit' as never)
    .select('*')
    .order('score', { ascending: true })
    .limit(1000)) as { data: AuditRow[] | null; error: { message: string } | null }

  const { data: ignoredRaw } = (await sb
    .from('jimscanner_trends_integrity_ignored' as never)
    .select('finding_key')
    .limit(5000)) as { data: IgnoredRow[] | null }

  const ignored = new Set((ignoredRaw ?? []).map((r) => r.finding_key))
  const all = (auditRaw ?? []).filter((r) => !ignored.has(findingKey(r)))

  // duplicate_suspect 는 유사도 높은 순(내림차순)이 더 자연스러움
  const dup = all.filter((r) => r.kind === 'duplicate_suspect').sort((a, b) => b.score - a.score)
  const hetero = all.filter((r) => r.kind === 'hetero_merge').sort((a, b) => a.score - b.score)
  const orphan = all.filter((r) => r.kind === 'orphan_alias').sort((a, b) => a.score - b.score)

  return { dup, hetero, orphan, error, applied: !error }
}

export default async function IntegrityPage() {
  const { dup, hetero, orphan, error, applied } = await fetchData()

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold">엔티티 정합성 감사</h1>
          <p className="text-sm text-gray-500 mt-1">
            alias→canonical 병합 품질을 검증해 모든 다운스트림 점수(삼각검증·합산·final_score)의 입력을 보증한다 · GIGO 차단
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      <section className="grid grid-cols-3 gap-4">
        <Kpi label="중복 의심 쌍" value={dup.length} hint="병합 후보 (신호 분산)" />
        <Kpi label="이질 병합 의심" value={hetero.length} hint="저신뢰 클러스터 (점수 과대)" />
        <Kpi label="고아 alias" value={orphan.length} hint="conf < 0.6" />
      </section>

      {!applied && (
        <div className="rounded border border-dashed border-amber-400 bg-amber-50 p-4 text-sm text-amber-800">
          <p className="font-medium">감사 뷰가 아직 적용되지 않았습니다.</p>
          <p className="mt-1 text-xs">
            <code className="px-1 bg-white rounded">supabase/trends_integrity_audit.sql</code> 를 DB 에 적용하세요.
            {error?.message ? ` (${error.message})` : ''}
          </p>
        </div>
      )}

      {applied && dup.length + hetero.length + orphan.length === 0 && (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500">
          <p className="text-base font-medium">의심 항목 없음 ✓</p>
          <p className="text-sm mt-2">현재 엔티티 해상도가 모든 임계값을 통과했습니다.</p>
        </div>
      )}

      {/* (a) 중복 의심 — 병합 카드 */}
      {dup.length > 0 && (
        <Group kind="duplicate_suspect">
          <div className="space-y-3">
            {dup.map((r) => (
              <div
                key={findingKey(r)}
                className={`rounded border ${KIND_META.duplicate_suspect.accent} p-4`}
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="grid grid-cols-2 gap-4 flex-1 min-w-0">
                    <SideCard
                      id={r.product_a_id}
                      name={r.product_a_name}
                      sub={`alias ${r.detail.a_alias_count ?? '?'} · ${r.detail.a_brand ?? '브랜드 없음'}`}
                    />
                    <SideCard
                      id={r.product_b_id ?? ''}
                      name={r.product_b_name ?? '?'}
                      sub={`alias ${r.detail.b_alias_count ?? '?'} · ${r.detail.b_brand ?? '브랜드 없음'}`}
                    />
                  </div>
                  <div className="shrink-0 text-right">
                    <div className="text-xs text-gray-500">유사도</div>
                    <div className="text-lg font-bold font-mono">{r.score}</div>
                    <div className="text-[10px] text-gray-400">{r.category}</div>
                  </div>
                </div>
                <div className="mt-3 flex justify-end">
                  <IntegrityActions
                    buttons={[
                      {
                        label: 'B→A 병합',
                        tone: 'primary',
                        confirm: `"${r.product_b_name}" 의 alias 를 "${r.product_a_name}" 로 합치고 B 를 삭제합니다. 계속?`,
                        body: { action: 'merge', fromProductId: r.product_b_id!, toProductId: r.product_a_id },
                      },
                      {
                        label: 'A→B 병합',
                        confirm: `"${r.product_a_name}" 의 alias 를 "${r.product_b_name}" 로 합치고 A 를 삭제합니다. 계속?`,
                        body: { action: 'merge', fromProductId: r.product_a_id, toProductId: r.product_b_id! },
                      },
                      { label: '무시', tone: 'muted', body: { action: 'ignore', findingKey: findingKey(r), kind: r.kind } },
                    ]}
                  />
                </div>
              </div>
            ))}
          </div>
        </Group>
      )}

      {/* (b) 이질 병합 의심 */}
      {hetero.length > 0 && (
        <Group kind="hetero_merge">
          <div className="space-y-3">
            {hetero.map((r) => {
              const aliases = (r.detail.aliases ?? []) as { alias: string; confidence: number; source: string | null }[]
              return (
                <div key={findingKey(r)} className={`rounded border ${KIND_META.hetero_merge.accent} p-4`}>
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0">
                      <Link
                        href={`/admin/trend-radar/products/${r.product_a_id}`}
                        className="font-medium hover:underline"
                      >
                        {r.product_a_name}
                      </Link>
                      <div className="text-xs text-gray-500 mt-0.5">
                        {r.category} · alias {r.detail.alias_count} · 소스 {r.detail.distinct_sources}종
                      </div>
                    </div>
                    <div className="shrink-0 text-right">
                      <div className="text-xs text-gray-500">평균 conf</div>
                      <div className="text-lg font-bold font-mono">{r.score}</div>
                      <div className="text-[10px] text-gray-400">min {r.detail.min_confidence}</div>
                    </div>
                  </div>
                  <div className="mt-3 space-y-1">
                    {aliases.map((a, i) => (
                      <div key={i} className="flex items-center justify-between gap-3 text-sm bg-white/60 rounded px-2 py-1">
                        <span className="truncate">
                          {a.alias}
                          <span className="text-[10px] text-gray-400 ml-2">{a.source ?? '—'}</span>
                        </span>
                        <div className="flex items-center gap-2 shrink-0">
                          <span className="text-xs font-mono text-gray-500">{a.confidence?.toFixed?.(2) ?? a.confidence}</span>
                          <IntegrityActions
                            buttons={[
                              {
                                label: '분리',
                                tone: 'danger',
                                confirm: `"${a.alias}" 를 별도 canonical 로 분리합니다. 계속?`,
                                body: { action: 'split', productId: r.product_a_id, alias: a.alias },
                              },
                            ]}
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                  <div className="mt-2 flex justify-end">
                    <IntegrityActions
                      buttons={[{ label: '클러스터 무시', tone: 'muted', body: { action: 'ignore', findingKey: findingKey(r), kind: r.kind } }]}
                    />
                  </div>
                </div>
              )
            })}
          </div>
        </Group>
      )}

      {/* (c) 고아 alias */}
      {orphan.length > 0 && (
        <Group kind="orphan_alias">
          <div className="rounded border border-gray-200 divide-y divide-gray-100">
            {orphan.map((r) => (
              <div key={findingKey(r)} className="grid grid-cols-12 items-center px-3 py-2 text-sm gap-2">
                <div className="col-span-5 truncate" title={r.product_b_name ?? ''}>
                  {r.product_b_name}
                  <span className="text-[10px] text-gray-400 ml-2">{r.detail.alias_type}</span>
                </div>
                <div className="col-span-3 text-xs text-gray-500 truncate">
                  →{' '}
                  <Link href={`/admin/trend-radar/products/${r.product_a_id}`} className="hover:underline">
                    {r.product_a_name}
                  </Link>
                </div>
                <div className="col-span-1 text-xs text-gray-400">{r.detail.source ?? '—'}</div>
                <div className="col-span-1 text-right font-mono text-xs text-gray-600">{r.score}</div>
                <div className="col-span-2 flex justify-end">
                  <IntegrityActions
                    buttons={[
                      {
                        label: '분리',
                        tone: 'danger',
                        confirm: `"${r.product_b_name}" 를 별도 canonical 로 분리합니다. 계속?`,
                        body: { action: 'split', productId: r.product_a_id, alias: r.product_b_name ?? '' },
                      },
                      { label: '무시', tone: 'muted', body: { action: 'ignore', findingKey: findingKey(r), kind: r.kind } },
                    ]}
                  />
                </div>
              </div>
            ))}
          </div>
        </Group>
      )}
    </div>
  )
}

function Group({ kind, children }: { kind: Kind; children: React.ReactNode }) {
  const m = KIND_META[kind]
  return (
    <section>
      <h2 className="text-sm font-semibold">{m.label}</h2>
      <p className="text-xs text-gray-500 mt-0.5 mb-2">{m.blurb}</p>
      {children}
    </section>
  )
}

function SideCard({ id, name, sub }: { id: string; name: string; sub: string }) {
  return (
    <div className="rounded border border-gray-200 bg-white p-2 min-w-0">
      <Link href={`/admin/trend-radar/products/${id}`} className="font-medium text-sm hover:underline block truncate" title={name}>
        {name}
      </Link>
      <div className="text-[11px] text-gray-500 truncate">{sub}</div>
    </div>
  )
}

function Kpi({ label, value, hint }: { label: string; value: number; hint: string }) {
  return (
    <div className="rounded border border-gray-200 p-4">
      <div className="text-xs text-gray-500">{label}</div>
      <div className="text-3xl font-bold mt-1">{value.toLocaleString()}</div>
      <div className="text-xs text-gray-400 mt-1">{hint}</div>
    </div>
  )
}
