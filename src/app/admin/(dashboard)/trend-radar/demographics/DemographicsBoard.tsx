'use client'

import Link from 'next/link'
import { useMemo, useState } from 'react'

interface FingerprintRow {
  product_id: string
  gender_share: Record<string, number>
  age_share: Record<string, number>
  dominant_segment: string | null
  concentration_hhi: number | null
  source_label: string | null
  computed_at: string
}
interface ProductRow {
  id: string
  canonical_name: string
  category_top: string
  category_mid: string | null
  brand: string | null
  alias_count: number
}
interface ScoreRow {
  product_id: string
  final_score: number
  trend_score: number
  commerce_score: number
  supplier_score: number
  competition_score: number
  computed_at: string
}

const AGE_BUCKETS = ['10', '20', '30', '40', '50', '60']
const GENDERS = ['m', 'f'] as const
const ALL_SEGMENTS = AGE_BUCKETS.flatMap((a) => GENDERS.map((g) => `${a}s_${g}`))

function segmentLabel(seg: string): string {
  const [age, gender] = seg.split('_')
  const g = gender === 'f' ? '여성' : '남성'
  return `${age?.replace('s', '')}대 ${g}`
}

function fmtPct(n: number): string {
  return `${(n * 100).toFixed(1)}%`
}

function fingerprintMatrix(fp: FingerprintRow): Record<string, number> {
  const out: Record<string, number> = {}
  for (const a of AGE_BUCKETS) {
    for (const g of GENDERS) {
      const av = Number(fp.age_share?.[a] ?? 0)
      const gv = Number(fp.gender_share?.[g] ?? 0)
      out[`${a}s_${g}`] = +(av * gv).toFixed(4)
    }
  }
  return out
}

function hhi(matrix: Record<string, number>): number {
  return +Object.values(matrix).reduce((s, v) => s + v * v, 0).toFixed(4)
}

function topSegment(matrix: Record<string, number>): { seg: string; share: number } | null {
  const entries = Object.entries(matrix).sort((a, b) => b[1] - a[1])
  if (entries.length === 0 || !entries[0]) return null
  return { seg: entries[0][0], share: entries[0][1] }
}

// 간단한 SVG radar — 12 축 (6 age × 2 gender)
function RadarChart({
  matrix,
  size = 220,
}: {
  matrix: Record<string, number>
  size?: number
}) {
  const axes = ALL_SEGMENTS
  const cx = size / 2
  const cy = size / 2
  const radius = size / 2 - 30
  const maxVal = Math.max(0.01, ...Object.values(matrix))
  const angleFor = (i: number) => (i / axes.length) * Math.PI * 2 - Math.PI / 2

  const points = axes
    .map((seg, i) => {
      const v = Number(matrix[seg] ?? 0)
      const r = (v / maxVal) * radius
      const x = cx + r * Math.cos(angleFor(i))
      const y = cy + r * Math.sin(angleFor(i))
      return `${x},${y}`
    })
    .join(' ')

  const grid = [0.25, 0.5, 0.75, 1].map((g) => g * radius)

  return (
    <svg width={size} height={size} className="text-gray-300">
      {grid.map((r, gi) => (
        <polygon
          key={gi}
          fill="none"
          stroke="currentColor"
          strokeWidth={0.5}
          points={axes
            .map((_, i) => {
              const x = cx + r * Math.cos(angleFor(i))
              const y = cy + r * Math.sin(angleFor(i))
              return `${x},${y}`
            })
            .join(' ')}
        />
      ))}
      {axes.map((seg, i) => {
        const x = cx + radius * Math.cos(angleFor(i))
        const y = cy + radius * Math.sin(angleFor(i))
        const labelX = cx + (radius + 12) * Math.cos(angleFor(i))
        const labelY = cy + (radius + 12) * Math.sin(angleFor(i))
        const isFemale = seg.endsWith('_f')
        return (
          <g key={seg}>
            <line x1={cx} y1={cy} x2={x} y2={y} stroke="currentColor" strokeWidth={0.3} />
            <text
              x={labelX}
              y={labelY}
              textAnchor="middle"
              dominantBaseline="middle"
              fontSize={9}
              fill={isFemale ? '#db2777' : '#2563eb'}
            >
              {seg.replace('s_m', 'M').replace('s_f', 'F').replace('s', '')}
            </text>
          </g>
        )
      })}
      <polygon
        points={points}
        fill="rgba(59, 130, 246, 0.25)"
        stroke="#2563eb"
        strokeWidth={1.5}
      />
    </svg>
  )
}

function channelHint(seg: string | null): string {
  if (!seg) return '—'
  const [age, gender] = seg.split('_')
  const a = Number(age?.replace('s', '') || '0')
  if (gender === 'f' && a <= 30) return '인스타 릴스 · 올리브영 · 무신사 우먼'
  if (gender === 'f' && a >= 40) return '카카오스토리 · 홈쇼핑 · 11번가 라방'
  if (gender === 'm' && a <= 30) return '유튜브 쇼츠 · 무신사 · 쿠팡 라이브'
  if (gender === 'm' && a >= 40) return '네이버 밴드 · 카카오톡 광고 · 쿠팡'
  return '인스타 + 네이버 SA'
}

function copyHint(seg: string | null): string {
  if (!seg) return '—'
  const [age, gender] = seg.split('_')
  const a = Number(age?.replace('s', '') || '0')
  if (gender === 'f' && a <= 20) return '"감성·트렌디" 톤, 영상 위주'
  if (gender === 'f' && a >= 40) return '"꼼꼼한 후기·안심" 톤, 가격강조'
  if (gender === 'm' && a <= 30) return '"스펙·가성비" 톤, 비교표'
  if (gender === 'm' && a >= 40) return '"오래쓰는·신뢰" 톤, 보증강조'
  return '범용 톤'
}

export default function DemographicsBoard({
  fingerprints,
  products,
  scores,
  pinnedIds,
}: {
  fingerprints: FingerprintRow[]
  products: ProductRow[]
  scores: ScoreRow[]
  pinnedIds: string[]
}) {
  const productMap = useMemo(
    () => new Map(products.map((p) => [p.id, p])),
    [products],
  )
  const scoreMap = useMemo(() => new Map(scores.map((s) => [s.product_id, s])), [scores])

  // 본인 카탈로그 정의: alias_count > 0 인 product 전체를 "자기 카탈로그"로 간주
  // (이 프로젝트는 위탁 셀러 단일 운영자 기준)
  const catalog = useMemo(() => {
    return fingerprints.filter((f) => {
      const p = productMap.get(f.product_id)
      return p && p.alias_count > 0
    })
  }, [fingerprints, productMap])

  // 가중치: final_score 가 있으면 그것, 없으면 1.0
  const weighted = useMemo(() => {
    const gender: Record<string, number> = { m: 0, f: 0 }
    const age: Record<string, number> = Object.fromEntries(AGE_BUCKETS.map((a) => [a, 0]))
    let totalW = 0
    for (const fp of catalog) {
      const w = Math.max(1, scoreMap.get(fp.product_id)?.final_score ?? 1)
      totalW += w
      for (const g of GENDERS) gender[g] += w * Number(fp.gender_share?.[g] ?? 0)
      for (const a of AGE_BUCKETS) age[a] += w * Number(fp.age_share?.[a] ?? 0)
    }
    if (totalW > 0) {
      for (const k of Object.keys(gender)) gender[k] = +(gender[k] / totalW).toFixed(4)
      for (const k of Object.keys(age)) age[k] = +(age[k] / totalW).toFixed(4)
    }
    const matrix = fingerprintMatrix({
      product_id: '_avg_',
      gender_share: gender,
      age_share: age,
      dominant_segment: null,
      concentration_hhi: null,
      source_label: null,
      computed_at: '',
    })
    return {
      gender,
      age,
      matrix,
      hhi: hhi(matrix),
      dominant: topSegment(matrix),
      sampleSize: catalog.length,
    }
  }, [catalog, scoreMap])

  // 쏠림 경고: HHI > 0.18 또는 단일 세그먼트 > 25%
  const alerts = useMemo(() => {
    const out: string[] = []
    if (weighted.sampleSize === 0) {
      out.push('자기 카탈로그(alias 매핑된 product) 가 없어 가중평균을 산출할 수 없음.')
      return out
    }
    if (weighted.hhi > 0.18) {
      out.push(
        `HHI ${weighted.hhi.toFixed(3)} — 카탈로그 demographic 집중도 높음 (위험 임계 0.18). 광고 학습이 한 세그먼트에 쏠려 ROAS 한계 가능.`,
      )
    }
    if (weighted.dominant && weighted.dominant.share > 0.25) {
      out.push(
        `${segmentLabel(weighted.dominant.seg)} 편중 (${fmtPct(weighted.dominant.share)}) — 다른 세그먼트 신규 진입 권장.`,
      )
    }
    return out
  }, [weighted])

  // 화이트스페이스: 카탈로그에 비어있는 세그먼트 × 시장 fingerprint 에 있는 후보
  const whitespace = useMemo(() => {
    // 자기 카탈로그의 세그먼트 점유율
    const myMatrix = weighted.matrix
    const weakSegments = Object.entries(myMatrix)
      .filter(([, v]) => v < 0.03)
      .map(([k]) => k)
    if (weakSegments.length === 0) return []
    // 도메 후보 = catalog 아닌 fingerprint, 그리고 weak 세그먼트가 dominant
    const candidates = fingerprints.filter((f) => {
      const p = productMap.get(f.product_id)
      if (!p) return false
      const isMine = p.alias_count > 0
      if (isMine) return false
      return f.dominant_segment && weakSegments.includes(f.dominant_segment)
    })
    return candidates
      .map((f) => ({
        fp: f,
        product: productMap.get(f.product_id)!,
        score: scoreMap.get(f.product_id),
      }))
      .sort((a, b) => (b.score?.final_score ?? 0) - (a.score?.final_score ?? 0))
      .slice(0, 12)
  }, [fingerprints, productMap, scoreMap, weighted])

  // 핀 후보 fingerprint
  const pinnedFingerprints = useMemo(() => {
    if (pinnedIds.length === 0) return fingerprints.slice(0, 6)
    const idSet = new Set(pinnedIds)
    return fingerprints.filter((f) => idSet.has(f.product_id)).slice(0, 12)
  }, [fingerprints, pinnedIds])

  const [activeIdx, setActiveIdx] = useState(0)

  return (
    <div className="space-y-8">
      {/* ② 본인 카탈로그 가중평균 + HHI + 경고 */}
      <section className="grid md:grid-cols-3 gap-4">
        <div className="rounded border border-gray-200 p-4">
          <h3 className="text-sm font-semibold mb-2">카탈로그 가중평균 Fingerprint</h3>
          <div className="text-xs text-gray-500 mb-2">
            본인 카탈로그({weighted.sampleSize}개 SKU) · final_score 가중
          </div>
          <div className="flex justify-center">
            <RadarChart matrix={weighted.matrix} />
          </div>
        </div>

        <div className="rounded border border-gray-200 p-4 space-y-3">
          <div>
            <div className="text-xs text-gray-500">HHI (집중도)</div>
            <div className="text-3xl font-bold">{weighted.hhi.toFixed(3)}</div>
            <div className="text-xs text-gray-400">
              0.0 = 균등 · 1.0 = 한 세그먼트 100%
              {weighted.hhi > 0.18 ? (
                <span className="text-red-600 font-semibold"> · 쏠림 위험</span>
              ) : (
                <span className="text-emerald-600 font-semibold"> · 양호</span>
              )}
            </div>
          </div>
          <div>
            <div className="text-xs text-gray-500">우세 세그먼트</div>
            <div className="text-lg font-semibold">
              {weighted.dominant ? segmentLabel(weighted.dominant.seg) : '—'}{' '}
              {weighted.dominant ? (
                <span className="text-gray-400 text-sm">
                  ({fmtPct(weighted.dominant.share)})
                </span>
              ) : null}
            </div>
          </div>
          <div>
            <div className="text-xs text-gray-500">추천 채널</div>
            <div className="text-sm">{channelHint(weighted.dominant?.seg ?? null)}</div>
          </div>
          <div>
            <div className="text-xs text-gray-500">추천 카피 톤</div>
            <div className="text-sm">{copyHint(weighted.dominant?.seg ?? null)}</div>
          </div>
        </div>

        <div className="rounded border border-gray-200 p-4">
          <h3 className="text-sm font-semibold mb-2">⚠ 쏠림 경고</h3>
          {alerts.length === 0 ? (
            <div className="text-sm text-emerald-600">
              현재 카탈로그는 demographic 다양성이 균형적입니다.
            </div>
          ) : (
            <ul className="space-y-2 text-sm text-amber-700">
              {alerts.map((a, i) => (
                <li key={i} className="border-l-2 border-amber-400 pl-2">
                  {a}
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      {/* ① 각 후보 핀의 demographic radar */}
      <section>
        <h2 className="text-sm font-semibold mb-3">
          ① 후보 핀 Demographic Radar ({pinnedFingerprints.length})
        </h2>
        {pinnedFingerprints.length === 0 ? (
          <div className="text-sm text-gray-500">핀 등록된 product 가 없음.</div>
        ) : (
          <div className="grid md:grid-cols-2 gap-4">
            <div className="rounded border border-gray-200 p-4 flex flex-col items-center">
              {(() => {
                const fp = pinnedFingerprints[activeIdx] ?? pinnedFingerprints[0]
                if (!fp) return null
                const p = productMap.get(fp.product_id)
                const m = fingerprintMatrix(fp)
                const top = topSegment(m)
                return (
                  <>
                    <div className="text-sm font-semibold mb-1">
                      {p?.canonical_name ?? fp.product_id.slice(0, 8)}
                    </div>
                    <div className="text-xs text-gray-500 mb-2">
                      {p?.category_top}
                      {p?.category_mid ? ` / ${p.category_mid}` : ''} · HHI{' '}
                      {(fp.concentration_hhi ?? hhi(m)).toFixed(3)} · top{' '}
                      {top ? segmentLabel(top.seg) : '—'}{' '}
                      {top ? `(${fmtPct(top.share)})` : ''}
                    </div>
                    <RadarChart matrix={m} size={260} />
                    <Link
                      href={`/admin/trend-radar/products/${fp.product_id}`}
                      className="mt-3 text-xs text-blue-600 hover:underline"
                    >
                      product 상세 →
                    </Link>
                  </>
                )
              })()}
            </div>
            <div className="rounded border border-gray-200 divide-y divide-gray-100 max-h-[480px] overflow-y-auto">
              {pinnedFingerprints.map((fp, i) => {
                const p = productMap.get(fp.product_id)
                const m = fingerprintMatrix(fp)
                const top = topSegment(m)
                return (
                  <button
                    key={fp.product_id}
                    onClick={() => setActiveIdx(i)}
                    className={`w-full text-left px-3 py-2 hover:bg-gray-50 ${
                      i === activeIdx ? 'bg-blue-50' : ''
                    }`}
                  >
                    <div className="text-sm font-medium truncate">
                      {p?.canonical_name ?? fp.product_id.slice(0, 8)}
                    </div>
                    <div className="text-xs text-gray-500 mt-0.5">
                      {top ? segmentLabel(top.seg) : '—'}{' '}
                      {top ? `(${fmtPct(top.share)})` : ''} · HHI{' '}
                      {(fp.concentration_hhi ?? hhi(m)).toFixed(3)}
                    </div>
                  </button>
                )
              })}
            </div>
          </div>
        )}
      </section>

      {/* ④ 화이트스페이스 추천 */}
      <section>
        <h2 className="text-sm font-semibold mb-3">
          ④ 화이트스페이스 추천 — 카탈로그 비어있는 demo 세그먼트의 도매 후보 ({whitespace.length})
        </h2>
        {whitespace.length === 0 ? (
          <div className="text-sm text-gray-500">
            현재 비어있는 세그먼트 (점유율 &lt; 3%) 에 대응하는 도매 후보를 찾지 못함.
          </div>
        ) : (
          <div className="rounded border border-gray-200 overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-xs text-gray-500">
                <tr>
                  <th className="px-3 py-2 text-left">product</th>
                  <th className="px-3 py-2 text-left">카테고리</th>
                  <th className="px-3 py-2 text-left">우세 세그먼트</th>
                  <th className="px-3 py-2 text-right">HHI</th>
                  <th className="px-3 py-2 text-right">final</th>
                  <th className="px-3 py-2 text-left">추천 채널</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {whitespace.map(({ fp, product, score }) => (
                  <tr key={fp.product_id} className="hover:bg-gray-50">
                    <td className="px-3 py-2">
                      <Link
                        href={`/admin/trend-radar/products/${fp.product_id}`}
                        className="text-blue-600 hover:underline"
                      >
                        {product.canonical_name}
                      </Link>
                    </td>
                    <td className="px-3 py-2 text-xs text-gray-500">
                      {product.category_top}
                      {product.category_mid ? ` / ${product.category_mid}` : ''}
                    </td>
                    <td className="px-3 py-2 text-xs">
                      {fp.dominant_segment ? segmentLabel(fp.dominant_segment) : '—'}
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-xs">
                      {(fp.concentration_hhi ?? 0).toFixed(3)}
                    </td>
                    <td className="px-3 py-2 text-right font-bold">
                      {score?.final_score ?? '—'}
                    </td>
                    <td className="px-3 py-2 text-xs text-gray-600">
                      {channelHint(fp.dominant_segment)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  )
}
