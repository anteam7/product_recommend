import SubNavLink from './SubNavLink'

export const metadata = {
  title: '트렌드 레이더 PRO',
}

const NAV = [
  { href: '/admin/trend-radar', label: '대시보드' },
  { href: '/admin/trend-radar/recommend', label: '⭐ 추천' },
  { href: '/admin/trend-radar/tv-pushes', label: 'TV 편성' },
  { href: '/admin/trend-radar/tv-ggsan-match', label: 'TV ↔ ggsan' },
  { href: '/admin/trend-radar/ggsan', label: 'ggsan 카탈로그' },
  { href: '/admin/trend-radar/opportunity', label: 'Opportunity' },
  { href: '/admin/trend-radar/backtest', label: '🧪 백테스트' },
  { href: '/admin/trend-radar/synonyms', label: '의미군' },
  { href: '/admin/trend-radar/pins', label: '핀' },
  { href: '/admin/trend-radar/sources', label: '소스 헬스' },
]

export default function TrendRadarLayout({ children }: { children: React.ReactNode }) {
  return (
    <div>
      <nav className="border-b border-gray-200 px-6 pt-4">
        <div className="flex gap-1">
          {NAV.map((n) => (
            <SubNavLink key={n.href} href={n.href} label={n.label} />
          ))}
        </div>
      </nav>
      {children}
    </div>
  )
}
