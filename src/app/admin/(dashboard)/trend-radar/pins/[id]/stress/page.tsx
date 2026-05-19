import Link from 'next/link'
import { notFound } from 'next/navigation'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import {
  computeStress,
  factorLabel,
  resilienceBadge,
  type PinStressInputs,
  type StressFactor,
  type StressResult,
} from '@/lib/trends/pin-stress'

export const dynamic = 'force-dynamic'

interface PageProps {
  params: Promise<{ id: string }>
}

async function fetchOne(id: string): Promise<{ inputs: PinStressInputs; stress: StressResult } | null> {
  const sb = createAdminClient()
  const { data, error } = await (sb as any)
    .from('jimscanner_pin_stress_inputs')
    .select('*')
    .eq('product_id', id)
    .maybeSingle()
  if (error || !data) return null
  const inputs = data as PinStressInputs
  return { inputs, stress: computeStress(inputs) }
}

function fmtKrw(n: number): string {
  if (!Number.isFinite(n)) return '-'
  return Math.round(n).toLocaleString('ko-KR') + '원'
}

function Tornado({ stress }: { stress: StressResult }) {
  // 각 인자별로 ±20% 까지 마진 변동폭(델타 KRW) 을 좌우로 그림.
  const factors: StressFactor[] = ['fx', 'supplier', 'shipping', 'duty']

  // 스케일: 전체 포인트의 |delta_from_base| 최대값
  const maxAbs = Math.max(
    1,
    ...stress.points.map((p) => Math.abs(p.delta_from_base_krw)),
  )

  const ROW_H = 56
  const W = 720
  const MID = W / 2
  const HALF = MID - 90 // left/right label gutters
  const deltaShades: Record<number, string> = {
    20: 'rgba(239,68,68,0.85)',
    10: 'rgba(239,68,68,0.55)',
    5: 'rgba(239,68,68,0.30)',
  }
  const posShades: Record<number, string> = {
    20: 'rgba(34,197,94,0.85)',
    10: 'rgba(34,197,94,0.55)',
    5: 'rgba(34,197,94,0.30)',
  }

  return (
    <svg viewBox={`0 0 ${W} ${factors.length * ROW_H + 30}`} className="w-full max-w-4xl">
      {/* 중앙 base line */}
      <line x1={MID} y1={10} x2={MID} y2={factors.length * ROW_H + 10} stroke="#9ca3af" strokeDasharray="3 3" />
      {factors.map((f, idx) => {
        const y0 = idx * ROW_H + 14
        const pts = stress.points.filter((p) => p.factor === f)
        return (
          <g key={f}>
            <text x={6} y={y0 + 22} className="fill-gray-700" fontSize="12">
              {factorLabel(f)}
            </text>
            {/* 막대들 — 큰 변동률이 더 길고 진함 */}
            {[20, 10, 5].map((mag) => {
              const minus = pts.find((p) => p.delta_pct === -mag)
              const plus = pts.find((p) => p.delta_pct === mag)
              if (!minus || !plus) return null
              const minusW = (Math.abs(minus.delta_from_base_krw) / maxAbs) * HALF
              const plusW = (Math.abs(plus.delta_from_base_krw) / maxAbs) * HALF
              const minusColor = minus.delta_from_base_krw >= 0 ? posShades[mag] : deltaShades[mag]
              const plusColor = plus.delta_from_base_krw >= 0 ? posShades[mag] : deltaShades[mag]
              const h = 12
              const yy = y0 + 6 + (20 - mag) // 큰 막대가 가운데로 정렬되게 살짝 띄움
              return (
                <g key={mag}>
                  <rect x={MID - minusW} y={yy} width={minusW} height={h} fill={minusColor} />
                  <rect x={MID} y={yy} width={plusW} height={h} fill={plusColor} />
                </g>
              )
            })}
            {/* 값 라벨: 마진 ±20% 결과만 표기 */}
            {(() => {
              const m20 = pts.find((p) => p.delta_pct === -20)
              const p20 = pts.find((p) => p.delta_pct === 20)
              return (
                <>
                  {m20 && (
                    <text x={MID - HALF - 4} y={y0 + 28} textAnchor="end" fontSize="11" className="fill-gray-700">
                      −20% : {fmtKrw(m20.margin_krw)}
                    </text>
                  )}
                  {p20 && (
                    <text x={MID + HALF + 4} y={y0 + 28} textAnchor="start" fontSize="11" className="fill-gray-700">
                      +20% : {fmtKrw(p20.margin_krw)}
                    </text>
                  )}
                </>
              )
            })()}
          </g>
        )
      })}
      {/* x축 캡션 */}
      <text x={MID - HALF} y={factors.length * ROW_H + 26} fontSize="10" className="fill-gray-500">
        마진 ↓ (악화)
      </text>
      <text x={MID + HALF} y={factors.length * ROW_H + 26} textAnchor="end" fontSize="10" className="fill-gray-500">
        마진 ↑ (개선)
      </text>
    </svg>
  )
}

export default async function PinStressPage(props: PageProps) {
  const { id } = await props.params
  const row = await fetchOne(id)
  if (!row) notFound()
  const { inputs, stress } = row
  const badge = resilienceBadge(stress.resilience)

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold">{stress.name}</h1>
          <p className="text-sm text-gray-500 mt-1">
            카테고리 {inputs.category_top ?? '-'} · 공급 {inputs.supplier_source ?? '-'} · 환율 1 CNY ={' '}
            {inputs.cny_krw}원
          </p>
        </div>
        <div className="flex items-center gap-3">
          <span className={`inline-block rounded border px-3 py-1 text-sm ${badge.cls}`}>
            {badge.label}
          </span>
          <Link
            href="/admin/trend-radar/stress"
            className="text-sm text-gray-700 hover:text-black underline"
          >
            ← 보드
          </Link>
        </div>
      </header>

      <section className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <Stat label="추정 판매가" value={fmtKrw(stress.selling_price_krw)} />
        <Stat label="매입가(KRW환산)" value={fmtKrw(stress.supplier_price_krw)} />
        <Stat
          label="기본 마진"
          value={fmtKrw(stress.base_margin_krw)}
          accent={stress.base_margin_krw < 0 ? 'red' : 'green'}
        />
        <Stat label="마진율" value={`${stress.base_margin_pct.toFixed(1)}%`} />
      </section>

      <section>
        <h2 className="text-lg font-semibold mb-2">토네이도 — ±5/10/20% 충격 시 마진 변동</h2>
        {stress.computable ? (
          <div className="rounded border border-gray-200 bg-white p-4">
            <Tornado stress={stress} />
            <p className="text-xs text-gray-500 mt-3">
              짙은 빨강 = ±20%, 옅은 빨강 = ±5%. 좌측은 마진 악화, 우측은 마진 개선.
            </p>
          </div>
        ) : (
          <div className="rounded border border-dashed border-gray-300 p-8 text-center text-sm text-gray-500">
            계산 불가: {stress.reason}
          </div>
        )}
      </section>

      <section>
        <h2 className="text-lg font-semibold mb-2">BEP (마진=0 임계 변동률)</h2>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {(['fx', 'duty', 'supplier', 'shipping'] as StressFactor[]).map((f) => (
            <div key={f} className="rounded border border-gray-200 p-3">
              <div className="text-xs text-gray-500">{factorLabel(f)}</div>
              <div className="text-xl font-mono mt-1">
                {stress.bep[f] == null ? '안전' : `+${stress.bep[f]}%`}
              </div>
              <div className="text-xs text-gray-400">
                {stress.bep[f] == null
                  ? '+200% 까지 흔들어도 마진 양수'
                  : '이 % 만큼 악화 시 마진 0'}
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="rounded border border-gray-200 bg-gray-50 p-4 text-xs text-gray-600">
        <h3 className="text-sm font-semibold text-gray-800 mb-1">계산 가정</h3>
        <ul className="list-disc pl-5 space-y-0.5">
          <li>관세 = 매입가 × {inputs.duty_rate_percent}% (카테고리 매핑 추정)</li>
          <li>부가세 = 매가 × {inputs.vat_rate_percent}%</li>
          <li>국제택배 = {fmtKrw(inputs.shipping_krw)} (대표 1kg 특송 평균)</li>
          <li>부대비 = {fmtKrw(inputs.handling_krw)} (포장·국내발송·결제수수료 추정)</li>
          <li>판매가 = 매입가 × 2.2 (위탁 평균 마크업 가정)</li>
          <li>면세한도 / 특송 분류 / 마켓 수수료는 미반영</li>
        </ul>
      </section>
    </div>
  )
}

function Stat({
  label,
  value,
  accent,
}: {
  label: string
  value: string
  accent?: 'red' | 'green'
}) {
  const color = accent === 'red' ? 'text-red-700' : accent === 'green' ? 'text-green-700' : ''
  return (
    <div className="rounded border border-gray-200 bg-white p-3">
      <div className="text-xs text-gray-500">{label}</div>
      <div className={`text-lg font-mono mt-1 ${color}`}>{value}</div>
    </div>
  )
}
