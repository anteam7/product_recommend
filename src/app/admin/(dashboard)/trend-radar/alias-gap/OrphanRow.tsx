'use client'

import { useState, useTransition } from 'react'
import { ignoreKeyword, createProductFromKeyword, addAliasToProduct } from './actions'

export interface ProductOption {
  id: string
  label: string
}

interface Props {
  keyword: string
  freq7d: number
  freq30d: number
  sourceCount: number
  sources: string[]
  lastSeenAt: string | null
  guessCategory: string | null
  products: ProductOption[]
}

const CATEGORY_TOP_OPTIONS = ['health', 'living', 'digital', 'beauty', 'food', 'fashion', 'baby', 'pet', 'sports', 'other']

export default function OrphanRow({
  keyword,
  freq7d,
  freq30d,
  sourceCount,
  sources,
  lastSeenAt,
  guessCategory,
  products,
}: Props) {
  const [mode, setMode] = useState<'idle' | 'create' | 'add' | 'ignore'>('idle')
  const [pending, startTransition] = useTransition()
  const [err, setErr] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)

  // create form
  const [canonical, setCanonical] = useState(keyword)
  const [catTop, setCatTop] = useState(guessCategory ?? 'other')
  const [catMid, setCatMid] = useState('')

  // add form
  const [productId, setProductId] = useState(products[0]?.id ?? '')

  // ignore form
  const [reason, setReason] = useState('noise')

  function handleCreate() {
    setErr(null)
    startTransition(async () => {
      const res = await createProductFromKeyword(keyword, canonical, catTop, catMid)
      if (!res.ok) setErr(res.error)
      else {
        setDone('product 생성됨')
        setMode('idle')
      }
    })
  }

  function handleAdd() {
    setErr(null)
    if (!productId) {
      setErr('product 선택 필요')
      return
    }
    startTransition(async () => {
      const res = await addAliasToProduct(productId, keyword)
      if (!res.ok) setErr(res.error)
      else {
        setDone('alias 추가됨')
        setMode('idle')
      }
    })
  }

  function handleIgnore() {
    setErr(null)
    startTransition(async () => {
      const res = await ignoreKeyword(keyword, reason)
      if (!res.ok) setErr(res.error)
      else {
        setDone('ignore 처리됨')
        setMode('idle')
      }
    })
  }

  return (
    <div className="border-b border-gray-100 px-4 py-3">
      <div className="grid grid-cols-12 items-center gap-2 text-sm">
        <div className="col-span-4">
          <div className="font-medium break-all">{keyword}</div>
          <div className="text-xs text-gray-500 mt-1 truncate" title={sources.join(', ')}>
            {sources.join(' · ')}
          </div>
        </div>
        <div className="col-span-1 text-right tabular-nums">{freq7d}</div>
        <div className="col-span-1 text-right tabular-nums text-gray-500">{freq30d}</div>
        <div className="col-span-1 text-right tabular-nums text-gray-500">{sourceCount}</div>
        <div className="col-span-2 text-xs text-gray-500 font-mono">
          {lastSeenAt ? lastSeenAt.slice(5, 16) : '—'}
        </div>
        <div className="col-span-1 text-xs">
          {guessCategory ? (
            <span className="rounded bg-gray-100 px-1.5 py-0.5 text-gray-700">{guessCategory}</span>
          ) : (
            <span className="text-gray-300">—</span>
          )}
        </div>
        <div className="col-span-2 flex gap-1 justify-end">
          {done ? (
            <span className="text-xs text-green-600">{done}</span>
          ) : (
            <>
              <button
                type="button"
                onClick={() => setMode(mode === 'create' ? 'idle' : 'create')}
                className="rounded border border-blue-300 bg-blue-50 px-2 py-1 text-xs text-blue-700 hover:bg-blue-100"
                disabled={pending}
              >
                + 신규
              </button>
              <button
                type="button"
                onClick={() => setMode(mode === 'add' ? 'idle' : 'add')}
                className="rounded border border-green-300 bg-green-50 px-2 py-1 text-xs text-green-700 hover:bg-green-100"
                disabled={pending}
              >
                + alias
              </button>
              <button
                type="button"
                onClick={() => setMode(mode === 'ignore' ? 'idle' : 'ignore')}
                className="rounded border border-gray-300 bg-gray-50 px-2 py-1 text-xs text-gray-700 hover:bg-gray-100"
                disabled={pending}
              >
                ignore
              </button>
            </>
          )}
        </div>
      </div>

      {mode === 'create' && (
        <div className="mt-2 rounded border border-blue-200 bg-blue-50/30 p-3 space-y-2">
          <div className="text-xs font-medium text-blue-900">새 product 생성 + 이 키워드를 alias 로 등록</div>
          <div className="grid grid-cols-12 gap-2">
            <input
              value={canonical}
              onChange={(e) => setCanonical(e.target.value)}
              placeholder="canonical_name"
              className="col-span-5 rounded border border-gray-300 px-2 py-1 text-sm"
            />
            <select
              value={catTop}
              onChange={(e) => setCatTop(e.target.value)}
              className="col-span-3 rounded border border-gray-300 px-2 py-1 text-sm"
            >
              {CATEGORY_TOP_OPTIONS.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
            <input
              value={catMid}
              onChange={(e) => setCatMid(e.target.value)}
              placeholder="category_mid (선택)"
              className="col-span-2 rounded border border-gray-300 px-2 py-1 text-sm"
            />
            <button
              type="button"
              onClick={handleCreate}
              disabled={pending}
              className="col-span-2 rounded bg-blue-600 px-3 py-1 text-sm text-white disabled:opacity-50"
            >
              {pending ? '저장중…' : '저장'}
            </button>
          </div>
        </div>
      )}

      {mode === 'add' && (
        <div className="mt-2 rounded border border-green-200 bg-green-50/30 p-3 space-y-2">
          <div className="text-xs font-medium text-green-900">기존 product 에 alias 추가</div>
          <div className="grid grid-cols-12 gap-2">
            <select
              value={productId}
              onChange={(e) => setProductId(e.target.value)}
              className="col-span-10 rounded border border-gray-300 px-2 py-1 text-sm"
            >
              <option value="">— product 선택 —</option>
              {products.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={handleAdd}
              disabled={pending || !productId}
              className="col-span-2 rounded bg-green-600 px-3 py-1 text-sm text-white disabled:opacity-50"
            >
              {pending ? '저장중…' : '저장'}
            </button>
          </div>
        </div>
      )}

      {mode === 'ignore' && (
        <div className="mt-2 rounded border border-gray-200 bg-gray-50 p-3 space-y-2">
          <div className="text-xs font-medium text-gray-900">노이즈 키워드로 기록 (다음 집계에서 제외)</div>
          <div className="grid grid-cols-12 gap-2">
            <select
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              className="col-span-10 rounded border border-gray-300 px-2 py-1 text-sm"
            >
              <option value="noise">noise (일반 노이즈)</option>
              <option value="irrelevant">irrelevant (관련 없음)</option>
              <option value="duplicate">duplicate (중복)</option>
              <option value="brand_term">brand_term (브랜드명 — 별도 처리)</option>
            </select>
            <button
              type="button"
              onClick={handleIgnore}
              disabled={pending}
              className="col-span-2 rounded bg-gray-700 px-3 py-1 text-sm text-white disabled:opacity-50"
            >
              {pending ? '저장중…' : '확정'}
            </button>
          </div>
        </div>
      )}

      {err && <div className="mt-2 text-xs text-red-600">에러: {err}</div>}
    </div>
  )
}
