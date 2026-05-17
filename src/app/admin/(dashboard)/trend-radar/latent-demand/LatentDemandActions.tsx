'use client'

import { useState } from 'react'

interface Props {
  noun: string
  mapped: boolean
}

// noun 단위 액션 — 실제 mutation 라우트가 붙기 전까지는 클립보드 복사 + 토스트로 시작.
// 매핑 RPC 가 준비되면 fetch('/api/admin/trend-radar/latent-demand/...') 로 교체.
export default function LatentDemandActions({ noun, mapped }: Props) {
  const [busy, setBusy] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)

  async function copy(text: string, label: string) {
    setBusy(label)
    try {
      await navigator.clipboard.writeText(text)
      setMsg(`${label} 복사됨`)
    } catch {
      setMsg('복사 실패')
    } finally {
      setBusy(null)
      setTimeout(() => setMsg(null), 2000)
    }
  }

  if (noun === '__unmapped__') {
    return <span className="text-xs text-gray-400">—</span>
  }

  return (
    <div className="flex items-center gap-1">
      <button
        type="button"
        disabled={busy !== null || mapped}
        onClick={() => copy(noun, '상품명')}
        className="text-xs rounded border border-gray-300 px-2 py-0.5 hover:bg-gray-50 disabled:opacity-40"
        title="상품 생성 시 canonical_name 후보로 복사"
      >
        + 상품
      </button>
      <button
        type="button"
        disabled={busy !== null}
        onClick={() => copy(noun, '시드')}
        className="text-xs rounded border border-gray-300 px-2 py-0.5 hover:bg-gray-50 disabled:opacity-40"
        title="market-keywords.ts 시드에 추가용 복사"
      >
        + 시드
      </button>
      {msg && <span className="text-[10px] text-green-600">{msg}</span>}
    </div>
  )
}
