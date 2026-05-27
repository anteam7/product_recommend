'use client'

const AGE_BUCKETS = ['10', '20', '30', '40', '50', '60']
const GENDERS = ['m', 'f'] as const

interface Props {
  gender_share: Record<string, number>
  age_share: Record<string, number>
  dominant_segment: string | null
  concentration_hhi: number | null
  computed_at: string | null
}

function segmentLabel(seg: string | null): string {
  if (!seg) return '—'
  const [age, gender] = seg.split('_')
  const g = gender === 'f' ? '여성' : '남성'
  return `${age?.replace('s', '')}대 ${g}`
}

function channelHint(seg: string | null): string {
  if (!seg) return '—'
  const [age, gender] = seg.split('_')
  const a = Number(age?.replace('s', '') || '0')
  if (gender === 'f' && a <= 30) return '인스타 릴스 · 올리브영'
  if (gender === 'f' && a >= 40) return '카카오스토리 · 홈쇼핑'
  if (gender === 'm' && a <= 30) return '유튜브 쇼츠 · 무신사'
  if (gender === 'm' && a >= 40) return '네이버 밴드 · 카카오톡 광고'
  return '인스타 + 네이버 SA'
}

function copyHint(seg: string | null): string {
  if (!seg) return '—'
  const [age, gender] = seg.split('_')
  const a = Number(age?.replace('s', '') || '0')
  if (gender === 'f' && a <= 20) return '"감성·트렌디" 톤'
  if (gender === 'f' && a >= 40) return '"꼼꼼한 후기·안심" 톤'
  if (gender === 'm' && a <= 30) return '"스펙·가성비" 톤'
  if (gender === 'm' && a >= 40) return '"오래쓰는·신뢰" 톤'
  return '범용 톤'
}

function RadarChart({ matrix, size = 200 }: { matrix: Record<string, number>; size?: number }) {
  const axes = AGE_BUCKETS.flatMap((a) => GENDERS.map((g) => `${a}s_${g}`))
  const cx = size / 2
  const cy = size / 2
  const radius = size / 2 - 28
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

  const grid = [0.5, 1].map((g) => g * radius)
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
        const labelX = cx + (radius + 11) * Math.cos(angleFor(i))
        const labelY = cy + (radius + 11) * Math.sin(angleFor(i))
        const isFemale = seg.endsWith('_f')
        return (
          <text
            key={seg}
            x={labelX}
            y={labelY}
            textAnchor="middle"
            dominantBaseline="middle"
            fontSize={8}
            fill={isFemale ? '#db2777' : '#2563eb'}
          >
            {seg.replace('s_m', 'M').replace('s_f', 'F').replace('s', '')}
          </text>
        )
      })}
      <polygon points={points} fill="rgba(59, 130, 246, 0.25)" stroke="#2563eb" strokeWidth={1.5} />
    </svg>
  )
}

export default function FingerprintPanel(props: Props) {
  const matrix: Record<string, number> = {}
  for (const a of AGE_BUCKETS) {
    for (const g of GENDERS) {
      const av = Number(props.age_share?.[a] ?? 0)
      const gv = Number(props.gender_share?.[g] ?? 0)
      matrix[`${a}s_${g}`] = +(av * gv).toFixed(4)
    }
  }

  return (
    <section>
      <h2 className="text-sm font-semibold mb-2">Demographic Fingerprint</h2>
      <div className="rounded border border-gray-200 p-4 grid md:grid-cols-3 gap-4 items-center">
        <div className="flex justify-center">
          <RadarChart matrix={matrix} />
        </div>
        <div className="space-y-2 text-sm">
          <div>
            <div className="text-xs text-gray-500">우세 세그먼트</div>
            <div className="text-lg font-semibold">{segmentLabel(props.dominant_segment)}</div>
          </div>
          <div>
            <div className="text-xs text-gray-500">HHI (집중도)</div>
            <div className="font-mono">
              {(props.concentration_hhi ?? 0).toFixed(3)}
              {(props.concentration_hhi ?? 0) > 0.18 ? (
                <span className="ml-2 text-red-600 text-xs">쏠림 위험</span>
              ) : (
                <span className="ml-2 text-emerald-600 text-xs">균형</span>
              )}
            </div>
          </div>
          {props.computed_at && (
            <div className="text-[10px] text-gray-400 font-mono">
              산출: {props.computed_at.slice(0, 19).replace('T', ' ')}
            </div>
          )}
        </div>
        <div className="space-y-2 text-sm">
          <div>
            <div className="text-xs text-gray-500">추천 채널</div>
            <div>{channelHint(props.dominant_segment)}</div>
          </div>
          <div>
            <div className="text-xs text-gray-500">추천 카피 톤</div>
            <div>{copyHint(props.dominant_segment)}</div>
          </div>
        </div>
      </div>
    </section>
  )
}
