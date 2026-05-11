import { ImageResponse } from 'next/og'
import { supabase } from '@/lib/supabase'

export const runtime = 'nodejs'
export const alt = '짐스캐너 배대지 배송비 비교'
export const size = { width: 1200, height: 630 }
export const contentType = 'image/png'

const COUNTRY_META: Record<string, { flag: string; name: string; en: string }> = {
  US: { flag: '🇺🇸', name: '미국', en: 'United States' },
  JP: { flag: '🇯🇵', name: '일본', en: 'Japan' },
  CN: { flag: '🇨🇳', name: '중국', en: 'China' },
}

type Props = { params: Promise<{ country: string }> }

export default async function Image({ params }: Props) {
  const { country } = await params
  const code = country.toUpperCase()
  const meta = COUNTRY_META[code]

  // 해당 국가 1kg 최저가와 활성 배대지 수 집계 (SEO 신호 + CTR 훅)
  const { data: rates } = await supabase
    .from('shipping_rates')
    .select('forwarder_id, price_krw, weight_min, weight_max, grade_level')
    .eq('country', code)
    .eq('grade_level', 1)

  const activeFwdIds = new Set((rates ?? []).map((r) => r.forwarder_id as string))
  const oneKgPrices = (rates ?? [])
    .filter((r) => r.weight_min <= 1 && r.weight_max >= 1 && r.price_krw)
    .map((r) => r.price_krw as number)
  const minPrice = oneKgPrices.length > 0 ? Math.min(...oneKgPrices) : null
  const fwdCount = activeFwdIds.size

  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          padding: 72,
          background: 'linear-gradient(135deg, #1d4ed8 0%, #1e3a8a 100%)',
          color: '#ffffff',
          fontFamily: 'sans-serif',
        }}
      >
        {/* Top: brand */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 56,
              height: 56,
              background: '#ffffff',
              borderRadius: 14,
              color: '#1d4ed8',
              fontSize: 32,
              fontWeight: 800,
            }}
          >
            J
          </div>
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            <div style={{ fontSize: 24, fontWeight: 700, letterSpacing: -0.4 }}>짐스캐너</div>
            <div style={{ fontSize: 16, color: '#bfdbfe' }}>jimscanner.co.kr</div>
          </div>
        </div>

        {/* Center: headline */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
          <div style={{ fontSize: 120, lineHeight: 1 }}>{meta?.flag ?? '🌐'}</div>
          <div
            style={{
              fontSize: 72,
              fontWeight: 800,
              lineHeight: 1.1,
              letterSpacing: -1.2,
            }}
          >
            {meta?.name ?? country.toUpperCase()} 배대지
          </div>
          <div
            style={{
              fontSize: 40,
              fontWeight: 600,
              color: '#bfdbfe',
              letterSpacing: -0.6,
            }}
          >
            배송비 최저가 비교
          </div>
        </div>

        {/* Bottom: data signals */}
        <div
          style={{
            display: 'flex',
            gap: 24,
            alignItems: 'stretch',
          }}
        >
          <div
            style={{
              flex: 1,
              display: 'flex',
              flexDirection: 'column',
              background: 'rgba(255,255,255,0.12)',
              padding: '18px 24px',
              borderRadius: 14,
            }}
          >
            <div style={{ fontSize: 16, color: '#bfdbfe' }}>등록 배대지</div>
            <div style={{ fontSize: 44, fontWeight: 800 }}>{fwdCount}곳</div>
          </div>
          {minPrice != null && (
            <div
              style={{
                flex: 1.4,
                display: 'flex',
                flexDirection: 'column',
                background: 'rgba(255,255,255,0.12)',
                padding: '18px 24px',
                borderRadius: 14,
              }}
            >
              <div style={{ fontSize: 16, color: '#bfdbfe' }}>1kg 최저가 (일반 등급)</div>
              <div style={{ fontSize: 44, fontWeight: 800 }}>
                {minPrice.toLocaleString('ko-KR')}원
              </div>
            </div>
          )}
          <div
            style={{
              flex: 1,
              display: 'flex',
              flexDirection: 'column',
              background: 'rgba(255,255,255,0.12)',
              padding: '18px 24px',
              borderRadius: 14,
            }}
          >
            <div style={{ fontSize: 16, color: '#bfdbfe' }}>환율</div>
            <div style={{ fontSize: 44, fontWeight: 800 }}>실시간</div>
          </div>
        </div>
      </div>
    ),
    { ...size },
  )
}
