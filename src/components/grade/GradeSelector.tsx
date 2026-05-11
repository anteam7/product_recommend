'use client'

import type { GradeLevel } from '@/types'

interface GradeSelectorProps {
  value: GradeLevel
  onChange: (v: GradeLevel) => void
}

const GRADES: { level: GradeLevel; label: string; desc: string }[] = [
  { level: 1, label: '일반 (기본)', desc: '신규 회원 기본 요금 — 몰테일 일반, 아이포터 Lounge, 포스트고 균일가 등' },
  { level: 2, label: '중간 등급',   desc: '약 5~7% 할인 — 몰테일 실버(6회↑), 아이포터 Business(21회↑), 훗타운 실버(10회↑) 등' },
  { level: 3, label: 'VIP',         desc: '약 8~11% 할인 — 몰테일 플래티넘(101회↑), 아이포터 Premium First(300회↑), 훗타운 VIP(30회↑) 등' },
]

export default function GradeSelector({ value, onChange }: GradeSelectorProps) {
  return (
    <div>
      <label className="text-sm font-medium text-gray-700 mb-2 block">회원 등급</label>
      <div className="flex gap-2 flex-wrap">
        {GRADES.map((g) => (
          <button
            key={g.level}
            type="button"
            onClick={() => onChange(g.level)}
            title={g.desc}
            className={`px-4 py-1.5 rounded-full text-sm border transition-all ${
              value === g.level
                ? 'bg-blue-600 text-white border-blue-600 shadow-sm'
                : 'bg-white text-gray-600 border-gray-200 hover:border-blue-400'
            }`}
          >
            {g.label}
          </button>
        ))}
      </div>
      <p className="text-xs text-gray-400 mt-1.5">
        {GRADES.find((g) => g.level === value)?.desc}
        {value === 1 && ' — 포스트고는 모든 등급에서 균일 요금 적용'}
      </p>
    </div>
  )
}
