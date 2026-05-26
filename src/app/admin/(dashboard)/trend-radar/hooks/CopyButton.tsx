'use client'

import { useState } from 'react'

export default function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text)
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        } catch {
          // ignore
        }
      }}
      className="mt-1 text-xs px-2 py-0.5 rounded border border-gray-300 text-gray-600 hover:bg-gray-100 hover:text-black transition-colors"
      title={text}
    >
      {copied ? '✓ 복사됨' : label}
    </button>
  )
}
