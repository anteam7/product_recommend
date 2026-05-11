import DisableGA from './DisableGA'

export const metadata = {
  title: '관리자',
  robots: { index: false, follow: false },
}

export default function AdminRootLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <DisableGA />
      {children}
    </>
  )
}
