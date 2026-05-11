'use client'

import { useEffect } from 'react'
import { MapContainer, TileLayer, Marker, Popup, useMap } from 'react-leaflet'
import L from 'leaflet'
import Link from 'next/link'
import 'leaflet/dist/leaflet.css'

// Leaflet 기본 마커 아이콘이 Webpack 빌드에서 경로를 잃는 흔한 문제 우회.
// unpkg CDN 을 참조해 client 에서만 실행 (이 파일 자체가 ssr:false 경로로 로드됨).
const DefaultIcon = L.icon({
  iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
  iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
  shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
  iconSize: [25, 41],
  iconAnchor: [12, 41],
  popupAnchor: [1, -34],
  shadowSize: [41, 41],
})
L.Marker.prototype.options.icon = DefaultIcon

export type MapPin = {
  id: string
  lat: number
  lng: number
  forwarderName: string
  forwarderSlug: string
  centerName: string
  country: string
  address?: string | null
}

function FitBounds({ pins }: { pins: MapPin[] }) {
  const map = useMap()
  useEffect(() => {
    if (pins.length === 0) return
    if (pins.length === 1) {
      map.setView([pins[0].lat, pins[0].lng], 12)
      return
    }
    const bounds = L.latLngBounds(pins.map((p) => [p.lat, p.lng]))
    map.fitBounds(bounds, { padding: [40, 40], maxZoom: 11 })
  }, [pins, map])
  return null
}

export default function MapInner({
  pins,
  height = 500,
  initialCenter = [37.5, 127.0],
  initialZoom = 2,
}: {
  pins: MapPin[]
  height?: number | string
  initialCenter?: [number, number]
  initialZoom?: number
}) {
  return (
    <MapContainer
      center={initialCenter}
      zoom={initialZoom}
      style={{ height, width: '100%' }}
      scrollWheelZoom={false}
      className="rounded-lg border"
    >
      <TileLayer
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
        url="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
      />
      <FitBounds pins={pins} />
      {pins.map((pin) => (
        <Marker key={pin.id} position={[pin.lat, pin.lng]}>
          <Popup>
            <div className="space-y-1 min-w-[180px]">
              <div className="font-semibold text-gray-900">
                <Link
                  href={`/forwarders/${pin.forwarderSlug}`}
                  className="text-blue-600 hover:underline"
                >
                  {pin.forwarderName}
                </Link>
              </div>
              <div className="text-xs text-gray-600">{pin.centerName}</div>
              {pin.address && (
                <div className="text-xs text-gray-500 leading-snug">{pin.address}</div>
              )}
            </div>
          </Popup>
        </Marker>
      ))}
    </MapContainer>
  )
}
