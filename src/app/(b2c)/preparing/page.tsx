import type { Metadata } from 'next'
import Link from 'next/link'

const FEATURE_LABEL: Record<string, string> = {
  login: '로그인',
  reviews: '배대지 후기',
  wallet: '월렛',
}

type PageProps = {
  searchParams: Promise<{ feature?: string }>
}

export const metadata: Metadata = {
  title: '준비 중 — 짐스캐너',
  description: '짐스캐너의 새 기능을 준비 중입니다. 곧 안내드릴게요.',
  robots: { index: false, follow: false },
}

export default async function PreparingPage({ searchParams }: PageProps) {
  const { feature } = await searchParams
  const label = feature && FEATURE_LABEL[feature] ? FEATURE_LABEL[feature] : null

  return (
    <main className="bg-[var(--jim-bg-primary)] text-[var(--jim-text-primary)]">
      <section className="mx-auto flex min-h-[60vh] max-w-[640px] flex-col items-center justify-center px-5 py-24 text-center sm:px-8">
        <p className="mb-5 text-[11px] font-medium tracking-[0.2em] text-[var(--jim-text-tertiary)]">
          COMING SOON
        </p>
        <h1 className="text-[36px] font-medium leading-[1.1] tracking-tight sm:text-[42px]">
          {label ? (
            <>
              {label} 기능을<br />
              준비 중입니다.
            </>
          ) : (
            <>
              새 기능을<br />
              준비 중입니다.
            </>
          )}
        </h1>
        <p className="mt-6 max-w-md text-[15px] leading-7 text-[var(--jim-text-secondary)]">
          더 나은 형태로 다듬어 곧 공개합니다. 그동안은 직구 시뮬레이터에서 무게·배대지·관부가세를 한 번에 계산해보세요.
        </p>
        <div className="mt-10 flex flex-wrap items-center justify-center gap-3">
          <Link
            href="/recommend"
            className="inline-flex h-11 items-center rounded-full bg-[var(--jim-bg-inverse)] px-6 text-sm font-medium text-white transition-opacity hover:opacity-90"
          >
            시뮬레이터 시작하기 →
          </Link>
          <Link
            href="/"
            className="inline-flex h-11 items-center rounded-full px-4 text-sm font-medium text-[var(--jim-text-secondary)] transition-colors hover:text-[var(--jim-text-primary)]"
          >
            홈으로
          </Link>
        </div>
      </section>
    </main>
  )
}
