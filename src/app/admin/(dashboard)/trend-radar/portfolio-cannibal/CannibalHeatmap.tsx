'use client'

interface Props {
  pinKeys: string[]
  labels: string[]
  scoreByPair: Record<string, number>
}

function colorFor(score: number): string {
  if (score <= 0) return '#f9fafb'
  if (score >= 0.55) return '#e11d48'
  if (score >= 0.3) return '#f59e0b'
  if (score >= 0.15) return '#fde68a'
  return '#ecfdf5'
}

export default function CannibalHeatmap({ pinKeys, labels, scoreByPair }: Props) {
  const n = pinKeys.length

  if (n === 0) return null
  if (n > 40) {
    return (
      <div className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
        핀이 {n}개라 히트맵은 생략. Top 20 표를 참고하세요.
      </div>
    )
  }

  const cell = 22

  return (
    <div className="overflow-auto rounded border border-gray-200 bg-white p-3">
      <table className="border-collapse text-xs" style={{ tableLayout: 'fixed' }}>
        <thead>
          <tr>
            <th className="sticky left-0 z-10 bg-white" />
            {labels.map((l, j) => (
              <th
                key={j}
                className="text-left text-gray-400 align-bottom"
                style={{
                  width: cell,
                  height: 80,
                  writingMode: 'vertical-rl',
                  transform: 'rotate(180deg)',
                  whiteSpace: 'nowrap',
                  padding: '0 2px',
                }}
                title={l}
              >
                {l.length > 10 ? l.slice(0, 10) + '…' : l}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {pinKeys.map((ai, i) => (
            <tr key={i}>
              <th
                className="sticky left-0 z-10 bg-white text-right pr-2 text-gray-500 font-normal"
                style={{ whiteSpace: 'nowrap', maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis' }}
                title={labels[i]}
              >
                {labels[i]}
              </th>
              {pinKeys.map((bj, j) => {
                if (i === j) {
                  return (
                    <td
                      key={j}
                      style={{ width: cell, height: cell, background: '#e5e7eb' }}
                      title="self"
                    />
                  )
                }
                const key = `${ai}|${bj}`
                const score = scoreByPair[key] ?? 0
                return (
                  <td
                    key={j}
                    style={{
                      width: cell,
                      height: cell,
                      background: colorFor(score),
                      border: '1px solid #fff',
                    }}
                    title={`${labels[i]} ↔ ${labels[j]} : ${score.toFixed(3)}`}
                  />
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="mt-3 flex items-center gap-3 text-xs text-gray-500">
        <span>범례:</span>
        <Legend color="#ecfdf5" label="<0.15 유지" />
        <Legend color="#fde68a" label="0.15–0.30" />
        <Legend color="#f59e0b" label="0.30–0.55 통합" />
        <Legend color="#e11d48" label="≥0.55 회피" />
      </div>
    </div>
  )
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span className="inline-block w-3 h-3 rounded-sm border border-gray-200" style={{ background: color }} />
      {label}
    </span>
  )
}
