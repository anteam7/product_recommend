'use client'

import Link from 'next/link'
import { useState, useTransition } from 'react'
import { mergeProducts, splitWorstAlias } from './actions'

export interface UnderMergePair {
  product_a: string
  name_a: string
  product_b: string
  name_b: string
  brand_a: string | null
  brand_b: string | null
  cat_a: string | null
  cat_b: string | null
  similarity: number
  same_brand_cat: boolean
  alias_count_a: number
  alias_count_b: number
  final_a: number | null
  final_b: number | null
}
export interface OverMergeRow {
  product_id: string
  canonical_name: string
  brand: string | null
  category_mid: string | null
  alias_count: number
  min_pair_sim: number
  avg_pair_sim: number
  worst_a: string | null
  worst_b: string | null
  final_score: number | null
}
export interface LowConfRow {
  product_id: string
  canonical_name: string
  brand: string | null
  alias_count: number
  max_conf: number
  llm_alias_count: number
  total_alias: number
  manual_alias_count: number
  final_score: number | null
}
export interface AbsorbRow {
  unclassified_id: string
  unclassified_name: string
  target_id: string
  target_name: string
  target_brand: string | null
  similarity: number
  target_alias_count: number
}

function pLink(id: string, label: string) {
  return (
    <Link
      href={`/admin/trend-radar/products/${id}`}
      className="text-blue-600 hover:underline"
      target="_blank"
    >
      {label}
    </Link>
  )
}

function simBadge(v: number) {
  const c = v >= 0.6 ? 'bg-red-100 text-red-700' : v >= 0.4 ? 'bg-amber-100 text-amber-700' : 'bg-gray-100 text-gray-600'
  return <span className={`px-1.5 py-0.5 rounded text-xs font-mono ${c}`}>{v?.toFixed(3)}</span>
}

function ActionButton({
  label,
  confirmMsg,
  run,
  tone = 'primary',
}: {
  label: string
  confirmMsg: string
  run: () => Promise<{ ok: boolean; error?: string }>
  tone?: 'primary' | 'danger'
}) {
  const [pending, start] = useTransition()
  const [done, setDone] = useState<null | string>(null)
  const cls =
    tone === 'danger'
      ? 'bg-red-600 hover:bg-red-700'
      : 'bg-black hover:bg-gray-800'
  if (done) return <span className="text-xs text-gray-400">{done}</span>
  return (
    <button
      disabled={pending}
      onClick={() => {
        if (!confirm(confirmMsg)) return
        start(async () => {
          const r = await run()
          setDone(r.ok ? '✓ 완료 (새로고침 반영)' : `✗ ${r.error ?? '실패'}`)
        })
      }}
      className={`text-white text-xs px-2.5 py-1 rounded disabled:opacity-50 ${cls}`}
    >
      {pending ? '…' : label}
    </button>
  )
}

export default function EntityQaClient({
  underMerge,
  overMerge,
  lowConf,
  absorb,
}: {
  underMerge: UnderMergePair[]
  overMerge: OverMergeRow[]
  lowConf: LowConfRow[]
  absorb: AbsorbRow[]
}) {
  return (
    <div className="space-y-8">
      {/* ① 분열 */}
      <section>
        <h2 className="text-base font-bold mb-1">① 분열 후보 (under-merge) · {underMerge.length}쌍</h2>
        <p className="text-xs text-gray-500 mb-2">
          서로 다른 canonical 인데 토큰셋이 유사하거나 같은 brand+category. 수요가 1/N 로 희석돼 final_score 과소평가.
          <b className="text-black"> 병합</b>은 A의 별칭을 B로 흡수하고 A를 삭제합니다.
        </p>
        {underMerge.length === 0 ? (
          <Empty />
        ) : (
          <div className="rounded border border-gray-200 overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-gray-50 text-gray-500">
                <tr>
                  <th className="px-2 py-2 text-left">유사도</th>
                  <th className="px-2 py-2 text-left">A (alias·final)</th>
                  <th className="px-2 py-2 text-left">B (alias·final)</th>
                  <th className="px-2 py-2 text-left">brand/cat</th>
                  <th className="px-2 py-2 text-right">액션</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {underMerge.map((r, i) => (
                  <tr key={i} className="align-top">
                    <td className="px-2 py-2">
                      {simBadge(r.similarity)}
                      {r.same_brand_cat && (
                        <span className="block mt-1 text-[10px] text-purple-600">동일 brand+cat</span>
                      )}
                    </td>
                    <td className="px-2 py-2">
                      {pLink(r.product_a, r.name_a)}
                      <span className="text-gray-400"> · {r.alias_count_a} · {r.final_a ?? '—'}</span>
                    </td>
                    <td className="px-2 py-2">
                      {pLink(r.product_b, r.name_b)}
                      <span className="text-gray-400"> · {r.alias_count_b} · {r.final_b ?? '—'}</span>
                    </td>
                    <td className="px-2 py-2 text-gray-500">
                      {r.brand_a ?? '—'}/{r.cat_a ?? '—'}
                      <br />
                      {r.brand_b ?? '—'}/{r.cat_b ?? '—'}
                    </td>
                    <td className="px-2 py-2 text-right space-y-1 whitespace-nowrap">
                      <ActionButton
                        label="A→B 병합"
                        confirmMsg={`「${r.name_a}」의 별칭을 「${r.name_b}」로 병합하고 A를 삭제합니다.`}
                        run={() => mergeProducts(r.product_a, r.product_b)}
                      />
                      <br />
                      <ActionButton
                        label="B→A 병합"
                        confirmMsg={`「${r.name_b}」의 별칭을 「${r.name_a}」로 병합하고 B를 삭제합니다.`}
                        run={() => mergeProducts(r.product_b, r.product_a)}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ② 과병합 */}
      <section>
        <h2 className="text-base font-bold mb-1">② 과병합 후보 (over-merge) · {overMerge.length}건</h2>
        <p className="text-xs text-gray-500 mb-2">
          한 product 안 별칭들의 상호 유사도가 낮음 — 서로 다른 상품이 뭉침.
          <b className="text-black"> 최이질 별칭 분리</b>는 가장 동떨어진 별칭 1건을 새 product 로 승격합니다.
        </p>
        {overMerge.length === 0 ? (
          <Empty />
        ) : (
          <div className="rounded border border-gray-200 overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-gray-50 text-gray-500">
                <tr>
                  <th className="px-2 py-2 text-left">최저쌍 sim</th>
                  <th className="px-2 py-2 text-left">product (alias·final)</th>
                  <th className="px-2 py-2 text-left">최이질 쌍</th>
                  <th className="px-2 py-2 text-right">액션</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {overMerge.map((r, i) => (
                  <tr key={i} className="align-top">
                    <td className="px-2 py-2">
                      {simBadge(r.min_pair_sim)}
                      <span className="block text-[10px] text-gray-400 mt-1">avg {r.avg_pair_sim}</span>
                    </td>
                    <td className="px-2 py-2">
                      {pLink(r.product_id, r.canonical_name)}
                      <span className="text-gray-400"> · {r.alias_count} · {r.final_score ?? '—'}</span>
                    </td>
                    <td className="px-2 py-2 text-gray-500">
                      “{r.worst_a}” ⟷ “{r.worst_b}”
                    </td>
                    <td className="px-2 py-2 text-right whitespace-nowrap">
                      <ActionButton
                        label="최이질 별칭 분리"
                        tone="danger"
                        confirmMsg={`「${r.canonical_name}」에서 가장 이질적인 별칭 1건을 새 product 로 분리합니다.`}
                        run={() => splitWorstAlias(r.product_id)}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ③ 저신뢰 앵커 */}
      <section>
        <h2 className="text-base font-bold mb-1">③ 저신뢰 앵커 · {lowConf.length}건</h2>
        <p className="text-xs text-gray-500 mb-2">
          manual 별칭 0건 + 최고 confidence &lt; 0.6. 저신뢰 llm_haiku 별칭만으로 지탱되는 product (오분류 위험).
          상세 페이지에서 별칭을 검수하세요.
        </p>
        {lowConf.length === 0 ? (
          <Empty />
        ) : (
          <div className="rounded border border-gray-200 overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-gray-50 text-gray-500">
                <tr>
                  <th className="px-2 py-2 text-left">max conf</th>
                  <th className="px-2 py-2 text-left">product</th>
                  <th className="px-2 py-2 text-left">brand</th>
                  <th className="px-2 py-2 text-right">llm/total</th>
                  <th className="px-2 py-2 text-right">final</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {lowConf.map((r, i) => (
                  <tr key={i}>
                    <td className="px-2 py-2">{simBadge(r.max_conf)}</td>
                    <td className="px-2 py-2">{pLink(r.product_id, r.canonical_name)}</td>
                    <td className="px-2 py-2 text-gray-500">{r.brand ?? '—'}</td>
                    <td className="px-2 py-2 text-right font-mono text-gray-600">
                      {r.llm_alias_count}/{r.total_alias}
                    </td>
                    <td className="px-2 py-2 text-right font-mono">{r.final_score ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ④ 흡수 후보 */}
      <section>
        <h2 className="text-base font-bold mb-1">④ 흡수 후보 (미분류 → 기존 canonical) · {absorb.length}건</h2>
        <p className="text-xs text-gray-500 mb-2">
          llm 미분류 product 중 기존 분류 canonical 과 토큰 매칭되는 건. <b className="text-black">흡수</b>는 미분류 product 를 타깃으로 병합합니다.
        </p>
        {absorb.length === 0 ? (
          <Empty />
        ) : (
          <div className="rounded border border-gray-200 overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-gray-50 text-gray-500">
                <tr>
                  <th className="px-2 py-2 text-left">유사도</th>
                  <th className="px-2 py-2 text-left">미분류</th>
                  <th className="px-2 py-2 text-left">타깃 canonical (alias)</th>
                  <th className="px-2 py-2 text-right">액션</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {absorb.map((r, i) => (
                  <tr key={i}>
                    <td className="px-2 py-2">{simBadge(r.similarity)}</td>
                    <td className="px-2 py-2">{pLink(r.unclassified_id, r.unclassified_name)}</td>
                    <td className="px-2 py-2">
                      {pLink(r.target_id, r.target_name)}
                      <span className="text-gray-400"> · {r.target_brand ?? '—'} · {r.target_alias_count}</span>
                    </td>
                    <td className="px-2 py-2 text-right whitespace-nowrap">
                      <ActionButton
                        label="흡수 병합"
                        confirmMsg={`미분류 「${r.unclassified_name}」를 「${r.target_name}」로 흡수 병합합니다.`}
                        run={() => mergeProducts(r.unclassified_id, r.target_id)}
                      />
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

function Empty() {
  return <div className="rounded border border-dashed border-gray-200 p-4 text-xs text-gray-400">후보 없음.</div>
}
