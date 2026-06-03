import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

interface Thumb {
  url: string
  phash: string
  cluster: number
  is_supplier?: boolean
}
interface AuditRow {
  product_id: string
  reuse_ratio: number | null
  cluster_count: number | null
  listing_count: number
  thumbnails: Thumb[]
  collected_at: string
}

// reuse_ratio → 배지 색 + 라벨. 높음 = 무차별 위탁 레드오션(가격경쟁만), 낮음 = 차별화 여지.
function reuseStyle(r: number | null) {
  if (r == null) return { color: '#9ca3af', bg: '#f3f4f6', label: '미측정' }
  if (r >= 0.7) return { color: '#b91c1c', bg: '#fee2e2', label: '레드오션' }
  if (r >= 0.4) return { color: '#b45309', bg: '#fef3c7', label: '경쟁 심화' }
  return { color: '#047857', bg: '#d1fae5', label: '차별화 여지' }
}

const CLUSTER_COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#a78bfa', '#ef4444', '#06b6d4', '#ec4899', '#84cc16']

async function fetchData() {
  const sb = createAdminClient()

  // 신규 테이블은 생성된 타입에 아직 없음 → as any 캐스팅
  const { data: audits } = await (sb as any)
    .from('jimscanner_trends_image_audit')
    .select('product_id, reuse_ratio, cluster_count, listing_count, thumbnails, collected_at')
    .order('collected_at', { ascending: false })
    .limit(1000)

  // product_id 별 최신 1건만
  const seen = new Set<string>()
  const latest: AuditRow[] = []
  for (const a of (audits ?? []) as AuditRow[]) {
    if (seen.has(a.product_id)) continue
    seen.add(a.product_id)
    latest.push(a)
  }

  const ids = latest.map((a) => a.product_id)
  let byId = new Map<string, any>()
  if (ids.length > 0) {
    const { data: prods } = await sb
      .from('jimscanner_trends_products')
      .select('id, canonical_name, category_top')
      .in('id', ids)
    byId = new Map((prods ?? []).map((p: any) => [p.id, p]))
  }

  const rows = latest
    .map((a) => ({ a, p: byId.get(a.product_id) }))
    .filter((x) => x.p)
    .sort((x, y) => (y.a.reuse_ratio ?? -1) - (x.a.reuse_ratio ?? -1))

  return { rows }
}

export default async function ImageAuditPage() {
  const { rows } = await fetchData()

  const redOcean = rows.filter((r) => (r.a.reuse_ratio ?? 0) >= 0.7).length

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold">대표이미지 재사용도 게이트</h1>
          <p className="text-sm text-gray-500 mt-1">
            경쟁 리스팅·도매 원본 사진의 pHash 유사도 · <b>동일사진 도배율 ↑ = 가격경쟁만 남는 레드오션</b> · ↓ = 자체촬영 차별화 구간
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      {rows.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500">
          <p className="text-base font-medium">아직 이미지 감사 데이터가 없습니다</p>
          <p className="text-sm mt-2">
            WSL 안에서 수집 실행:
            <code className="ml-1 px-1 bg-gray-100 rounded">node scripts/trends-image-audit-collect.mjs</code>
          </p>
        </div>
      ) : (
        <>
          <section className="grid grid-cols-2 md:grid-cols-3 gap-4">
            <Kpi label="감사된 상품" value={rows.length} hint="최신 1건 기준" />
            <Kpi label="레드오션 (도배율≥70%)" value={redOcean} hint="가격경쟁만 남음" />
            <Kpi
              label="평균 도배율"
              value={`${Math.round(
                (rows.reduce((s, r) => s + (r.a.reuse_ratio ?? 0), 0) / rows.length) * 100
              )}%`}
              hint="동일·근사 사진 비율"
            />
          </section>

          <section className="space-y-4">
            {rows.map(({ a, p }) => {
              const st = reuseStyle(a.reuse_ratio)
              return (
                <div key={a.product_id} className="rounded border border-gray-200 p-4">
                  <div className="flex items-center justify-between flex-wrap gap-2 mb-3">
                    <Link
                      href={`/admin/trend-radar/products/${a.product_id}`}
                      className="font-medium hover:underline"
                    >
                      {p.canonical_name}
                      <span className="text-xs text-gray-400 ml-2">{p.category_top}</span>
                    </Link>
                    <div className="flex items-center gap-2 text-xs">
                      <span
                        className="px-2 py-0.5 rounded font-semibold"
                        style={{ color: st.color, background: st.bg }}
                      >
                        동일사진 도배율 {a.reuse_ratio == null ? '—' : `${Math.round(a.reuse_ratio * 100)}%`} · {st.label}
                      </span>
                      <span className="text-gray-500">
                        군집 {a.cluster_count ?? '—'}종 / {a.listing_count}장
                      </span>
                    </div>
                  </div>

                  {/* 유사도 군집별 썸네일 그리드 */}
                  <div className="flex flex-wrap gap-2">
                    {(a.thumbnails ?? []).map((t, i) => (
                      <div
                        key={i}
                        className="relative w-16 h-16 rounded overflow-hidden border-2"
                        style={{ borderColor: CLUSTER_COLORS[t.cluster % CLUSTER_COLORS.length] }}
                        title={`cluster ${t.cluster}${t.is_supplier ? ' · 도매 원본' : ''}`}
                      >
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={t.url} alt="" className="w-full h-full object-cover" />
                        {t.is_supplier && (
                          <span className="absolute bottom-0 left-0 right-0 bg-black/70 text-white text-[8px] text-center">
                            원본
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                  <div className="text-[10px] text-gray-400 mt-2 font-mono">
                    수집 {a.collected_at?.slice(0, 19).replace('T', ' ')} · 테두리색 = 시각 군집
                  </div>
                </div>
              )
            })}
          </section>
        </>
      )}
    </div>
  )
}

function Kpi({ label, value, hint }: { label: string; value: number | string; hint: string }) {
  return (
    <div className="rounded border border-gray-200 p-4">
      <div className="text-xs text-gray-500">{label}</div>
      <div className="text-3xl font-bold mt-1">{typeof value === 'number' ? value.toLocaleString() : value}</div>
      <div className="text-xs text-gray-400 mt-1">{hint}</div>
    </div>
  )
}
