'use client'

import dynamic from 'next/dynamic'
import type { MapPin } from './MapInner'

export type { MapPin }

const MapInner = dynamic(() => import('./MapInner'), {
  ssr: false,
  loading: () => (
    <div
      className="w-full rounded-lg border bg-gray-50 animate-pulse flex items-center justify-center text-sm text-gray-400"
      style={{ height: 500 }}
    >
      지도를 불러오는 중…
    </div>
  ),
})

export function MapView(props: {
  pins: MapPin[]
  height?: number | string
  initialCenter?: [number, number]
  initialZoom?: number
}) {
  if (props.pins.length === 0) {
    return (
      <div
        className="w-full rounded-lg border bg-gray-50 flex items-center justify-center text-sm text-gray-400"
        style={{ height: props.height ?? 500 }}
      >
        표시할 위치 데이터가 없습니다.
      </div>
    )
  }
  return <MapInner {...props} />
}
