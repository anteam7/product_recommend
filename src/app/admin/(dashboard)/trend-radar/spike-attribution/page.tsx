import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

interface AttrRow {
  id: string
  product_id: string
  spike_at: string
  score_before: number | null
  score_after: number | null
  delta: number | null
  delta_pct: number | null
  trigger_type: string
  trigger_confidence: number
  evidence_refs: Record<string, unknown>
}

const BUCKETS: {
  key: string
  label: string
  icon: string
  blurb: string
  tone: string
}[] = [
  {
    key: 'organic',
    label: '자생적 급등',
    icon: '🌱',
    blurb: '외부 트리거 없이 스스로 오른 수요 — 가장 내구성 높은 진짜 신규수요. 위탁 1순위 후보.',
    tone: 'border-emerald-300 bg-emerald-50',
  },
  {
    key: 'tv',
    label: 'TV 유발',
    icon: '📺',
    blurb: '홈쇼핑 편성과 동시 발생 — 단발성·소멸형. 편성 종료 후 수요 지속 여부 확인 필요.',
    tone: 'border-blue-200 bg-blue-50',
  },
  {
    key: 'hotdeal',
    label: '핫딜 유발',
    icon: '🔥',
    blurb: '퀘이사존 핫딜과 동시 등장 — 가격 이벤트성 스파이크. 정상가 복귀 시 소멸 가능.',
    tone: 'border-amber-200 bg-amber-50',
  },
  {
    key: 'ad',
    label: '광고 유발',
    icon: '📣',
    blurb: '네이버 블로그 협찬 버스트와 동시 — 광고비 소진 후 꺾일 위험.',
    tone: 'border-rose-200 bg-rose-50',
  },
]

async function fetchData() {
  const sb = createAdminClient()

  // 신규 테이블 — 타입 생성 전이므로 as any 캐스팅
  const { data: rows } = await (sb as any)
    .from('jimscanner_trends_spike_attribution')
    .select(
      'id, product_id, spike_at, score_before, score_after, delta, delta_pct, trigger_type, trigger_confidence, evidence_refs',
    )
    .order('spike_at', { ascending: false })
    .limit(1000)

  const attr = (rows ?? []) as AttrRow[]
  const ids = [...new Set(attr.map((r) => r.product_id))]

  const nameById = new Map<string, string>()
  if (ids.length > 0) {
    const { data: prods } = await sb
      .from('jimscanner_trends_products')
      .select('id, canonical_name')
      .in('id', ids)
    for (const p of (prods ?? []) as { id: string; canonical_name: string }[])
      nameById.set(p.id, p.canonical_name)
  }

  return { attr, nameById }
}

function fmtDate(iso: string) {
  return iso.slice(0, 10)
}

export default async function SpikeAttributionPage() {
  const { attr, nameById } = await fetchData()

  const grouped = new Map<string, AttrRow[]>()
  for (const b of BUCKETS) grouped.set(b.key, [])
  for (const r of attr) {
    if (!grouped.has(r.trigger_type)) grouped.set(r.trigger_type, [])
    grouped.get(r.trigger_type)!.push(r)
  }

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold">스파이크 원인 귀인</h1>
          <p className="text-sm text-gray-500 mt-1">
            점수 급등의 원인을 자동 판별 — <span className="font-medium text-emerald-700">자생적 급등</span>이
            외부유발 스파이크보다 내구성이 높아 위탁 후보로 우선 노출됩니다.
          </p>
        </div>
        <Link
          href="/admin/trend-radar"
          className="text-sm text-gray-700 hover:text-black underline"
        >
          ← 대시보드
        </Link>
      </header>

      {attr.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500">
          아직 귀인 데이터 없음. <code>node scripts/attribute-spikes.mjs --apply</code> 실행 후 다시 방문.
        </div>
      ) : (
        <div className="space-y-8">
          {BUCKETS.map((b) => {
            const list = grouped.get(b.key) ?? []
            return (
              <section key={b.key} className={`rounded-lg border p-4 ${b.tone}`}>
                <div className="flex items-baseline justify-between mb-3">
                  <h2 className="text-lg font-semibold">
                    {b.icon} {b.label}{' '}
                    <span className="text-sm font-normal text-gray-500">({list.length})</span>
                  </h2>
                </div>
                <p className="text-xs text-gray-600 mb-3">{b.blurb}</p>
                {list.length === 0 ? (
                  <p className="text-sm text-gray-400">해당 없음</p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="text-left text-gray-500 border-b border-gray-300">
                          <th className="py-1.5 pr-3">상품</th>
                          <th className="py-1.5 pr-3">급등일</th>
                          <th className="py-1.5 pr-3 text-right">점수</th>
                          <th className="py-1.5 pr-3 text-right">증가</th>
                          <th className="py-1.5 pr-3 text-right">확신</th>
                          <th className="py-1.5">근거</th>
                        </tr>
                      </thead>
                      <tbody>
                        {list.map((r) => {
                          const ev = r.evidence_refs as {
                            tv?: { keyword?: string }[]
                            hotdeal?: { title?: string }[]
                            ad?: { burst_count?: number }[]
                          }
                          const evText =
                            b.key === 'tv'
                              ? (ev.tv ?? [])
                                  .map((e) => e.keyword)
                                  .filter(Boolean)
                                  .slice(0, 2)
                                  .join(', ')
                              : b.key === 'hotdeal'
                                ? (ev.hotdeal ?? [])
                                    .map((e) => e.title)
                                    .filter(Boolean)
                                    .slice(0, 2)
                                    .join(', ')
                                : b.key === 'ad'
                                  ? `블로그 ${ev.ad?.[0]?.burst_count ?? 0}건 버스트`
                                  : '외부 트리거 없음'
                          return (
                            <tr key={r.id} className="border-b border-gray-200/60">
                              <td className="py-1.5 pr-3 font-medium">
                                <Link
                                  href={`/admin/trend-radar/products/${r.product_id}`}
                                  className="hover:underline"
                                >
                                  {nameById.get(r.product_id) ?? r.product_id.slice(0, 8)}
                                </Link>
                              </td>
                              <td className="py-1.5 pr-3 text-gray-600">{fmtDate(r.spike_at)}</td>
                              <td className="py-1.5 pr-3 text-right tabular-nums text-gray-600">
                                {r.score_before ?? '?'}→{r.score_after ?? '?'}
                              </td>
                              <td className="py-1.5 pr-3 text-right tabular-nums font-medium text-emerald-700">
                                +{r.delta_pct ?? 0}%
                              </td>
                              <td className="py-1.5 pr-3 text-right tabular-nums text-gray-600">
                                {Math.round(r.trigger_confidence * 100)}%
                              </td>
                              <td className="py-1.5 text-gray-500 truncate max-w-[16rem]">{evText}</td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>
            )
          })}
        </div>
      )}
    </div>
  )
}
