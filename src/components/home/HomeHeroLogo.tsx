'use client'

import { useEffect, useRef } from 'react'

const PLANE_DUR = 9000
const GAP = 1500
const ROUND_TRIP = PLANE_DUR * 2
const CYCLE = ROUND_TRIP + GAP

const PLANE_PATH = 'M 680 92 Q 300 -30 -80 92'

const HIDDEN = 'translate(-3000, 0)'

export default function HomeHeroLogo() {
  const planePathRef = useRef<SVGPathElement>(null)
  const planeRef = useRef<SVGGElement>(null)

  useEffect(() => {
    const planePath = planePathRef.current
    const plane = planeRef.current
    if (!planePath || !plane) return

    if (typeof window !== 'undefined') {
      const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
      if (reduced) return
    }

    const planeLen = planePath.getTotalLength()

    let raf = 0
    const start = performance.now()

    const animate = (now: number) => {
      const total = now - start
      const inCycle = total % CYCLE

      let forward: boolean
      let tPath: number
      if (inCycle < PLANE_DUR) {
        forward = true
        tPath = inCycle / PLANE_DUR
      } else if (inCycle < ROUND_TRIP) {
        forward = false
        tPath = 1 - (inCycle - PLANE_DUR) / PLANE_DUR
      } else {
        plane.setAttribute('transform', HIDDEN)
        raf = requestAnimationFrame(animate)
        return
      }

      const dt = 1 / planeLen
      const tPath2 = forward
        ? Math.min(tPath + dt, 1)
        : Math.max(tPath - dt, 0)
      const p = planePath.getPointAtLength(tPath * planeLen)
      const p2 = planePath.getPointAtLength(tPath2 * planeLen)
      let angle = (Math.atan2(p2.y - p.y, p2.x - p.x) * 180) / Math.PI
      const movingLeft = p2.x - p.x < 0
      const scale = movingLeft ? -1 : 1
      if (movingLeft) angle = angle + 180
      plane.setAttribute(
        'transform',
        `translate(${p.x}, ${p.y}) rotate(${angle}) scale(${scale}, 1)`,
      )

      raf = requestAnimationFrame(animate)
    }

    raf = requestAnimationFrame(animate)
    return () => cancelAnimationFrame(raf)
  }, [])

  return (
    <div className="mx-auto w-full max-w-[600px] select-none">
      <div aria-hidden className="relative">
        <svg
          viewBox="0 0 600 100"
          preserveAspectRatio="none"
          className="block h-[92px] w-full text-[#1c1c1a] sm:h-[100px]"
        >
          <path ref={planePathRef} d={PLANE_PATH} fill="none" stroke="none" />
          <g ref={planeRef} transform={HIDDEN}>
            <Airplane />
          </g>
        </svg>
      </div>

      <h1
        aria-label="짐스캐너"
        className="-mt-1 text-center font-semibold tracking-tight"
        style={{
          fontSize: 'clamp(44px, 9vw, 72px)',
          lineHeight: 1,
          letterSpacing: '-0.04em',
        }}
      >
        <svg
          aria-hidden
          viewBox="0 0 24 24"
          className="inline-block align-middle"
          style={{ width: '0.62em', height: '0.62em', marginRight: '0.22em' }}
        >
          {/* 우측면 (그림자) */}
          <polygon points="15,9 21,3 21,15 15,21" fill="#d97706" />
          {/* 윗면 (하이라이트) */}
          <polygon points="3,9 9,3 21,3 15,9" fill="#fde68a" />
          {/* 정면 */}
          <polygon points="3,9 15,9 15,21 3,21" fill="#fbbf24" />
          {/* 윗면 테이프 (사선) */}
          <polygon points="8,9 10,9 16,3 14,3" fill="#a16207" />
          {/* 정면 테이프 (세로) */}
          <rect x="8" y="9" width="2" height="12" fill="#a16207" />
          {/* 외곽선 */}
          <polygon
            points="3,9 9,3 21,3 21,15 15,21 3,21"
            fill="none"
            stroke="#78350f"
            strokeWidth="0.6"
            strokeLinejoin="round"
          />
          {/* 내부 모서리 (정면-우측면 경계) */}
          <line x1="15" y1="9" x2="15" y2="21" stroke="#78350f" strokeWidth="0.5" />
          {/* 내부 모서리 (정면-윗면 경계) */}
          <line x1="3" y1="9" x2="15" y2="9" stroke="#78350f" strokeWidth="0.5" />
          {/* 내부 모서리 (윗면-우측면 경계) */}
          <line x1="15" y1="9" x2="21" y2="3" stroke="#78350f" strokeWidth="0.5" />
        </svg>
        <span className="text-blue-600">jim</span>
        <span className="text-[#1c1c1a]">scanner</span>
      </h1>

      <p
        className="mt-2 text-center font-medium tracking-tight text-slate-500"
        style={{ fontSize: 'clamp(14px, 1.8vw, 18px)' }}
      >
        직구하기 전, 배송비·관세 한 번에
      </p>
    </div>
  )
}

function Airplane() {
  return (
    <g transform="translate(-25, -10)">
      <ellipse
        cx="25"
        cy="10"
        rx="24"
        ry="3.5"
        fill="white"
        stroke="currentColor"
        strokeWidth="1.3"
      />
      <path
        d="M 5 10 L 10 1 L 16 10 Z"
        fill="white"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <path
        d="M 3 10 L 0 13 L 7 12 Z"
        fill="white"
        stroke="currentColor"
        strokeWidth="1.1"
        strokeLinejoin="round"
      />
      <path
        d="M 18 12 L 27 19 L 35 19 L 30 12 Z"
        fill="white"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <path
        d="M 41 8 Q 45 9, 47 10.5"
        fill="none"
        stroke="#fbbf24"
        strokeWidth="1.8"
      />
      <circle cx="44" cy="9" r="1.6" fill="#fbbf24" />
      <line
        x1="45"
        y1="10"
        x2="49"
        y2="10"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
    </g>
  )
}
