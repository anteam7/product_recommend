import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import CopyButton from './CopyButton'

export const dynamic = 'force-dynamic'

const CATEGORIES = ['all', 'health', 'living', 'digital'] as const
type Category = (typeof CATEGORIES)[number]

const CATEGORY_LABEL: Record<Category, string> = {
  all: '전체',
  health: '건강식품',
  living: '생활/리빙',
  digital: '디지털/가전',
}

interface HookRow {
  id: string
  category: string
  phrase: string
  support: number
  avg_discount: number | null
  top_examples: Array<{
    title?: string
    source?: string
    source_url?: string
    captured_at?: string
    discount_pct?: number
  }>
  first_seen: string
  last_seen: string
}

async function fetchHooks(category: Category) {
  const sb = createAdminClient()
  const q = sb
    // jimscanner_hook_phrases 는 마이그레이션 (supabase/hook_phrases.sql) 적용 후 생성됨.
    // 빌드 시점 generated types 에 아직 없으므로 as any 캐스팅.
    .from('jimscanner_hook_phrases' as any)
    .select('*')
    .order('support', { ascending: false })
    .limit(20)

  if (category !== 'all') q.eq('category', category)
  const { data, error } = await q
  if (error) return { rows: [] as HookRow[], err: error.message }
  return { rows: (data ?? []) as unknown as HookRow[], err: null as string | null }
}

export default async function HookMiningPage({
  searchParams,
}: {
  searchParams: Promise<{ cat?: string }>
}) {
  const sp = await searchParams
  const category = (CATEGORIES.includes(sp.cat as Category) ? sp.cat : 'all') as Category
  const { rows, err } = await fetchHooks(category)

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold">후킹카피 마이닝</h1>
          <p className="text-sm text-gray-500 mt-1">
            market_raw 의 quasarzone_sale · naver_news · naver_blog 에서 반복 등장하는 클릭유도 어구 Top 20.
            카테고리 단위 검증된 후킹어구는 쿠팡 등록 제목 템플릿으로 바로 복사.
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      <nav className="flex gap-2 border-b border-gray-200">
        {CATEGORIES.map((c) => (
          <Link
            key={c}
            href={`/admin/trend-radar/hooks?cat=${c}`}
            className={`px-3 py-2 text-sm ${
              category === c
                ? 'border-b-2 border-black font-semibold text-black'
                : 'text-gray-500 hover:text-black'
            }`}
          >
            {CATEGORY_LABEL[c]}
          </Link>
        ))}
      </nav>

      {err && (
        <div className="rounded border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
          쿼리 실패: <code className="font-mono">{err}</code>
          <div className="mt-1 text-xs text-amber-800">
            supabase/hook_phrases.sql 적용 후 scripts/extract-hook-phrases.mjs 를 한 번 돌리면 채워집니다.
          </div>
        </div>
      )}

      {rows.length === 0 && !err ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500">
          <p className="text-base font-medium">아직 추출된 후킹어구가 없음</p>
          <p className="text-sm mt-2">
            <code className="px-1 bg-gray-100 rounded">node scripts/extract-hook-phrases.mjs</code> 실행 후 다시 로드.
            <br />
            cron 6시간마다 자동 누적.
          </p>
        </div>
      ) : (
        <section className="space-y-2">
          <div className="grid grid-cols-12 px-3 py-2 text-xs text-gray-500 border-b border-gray-200">
            <div className="col-span-1">#</div>
            <div className="col-span-3">어구</div>
            <div className="col-span-1 text-right">빈도</div>
            <div className="col-span-1 text-right">평균 할인</div>
            <div className="col-span-5">원문 예시</div>
            <div className="col-span-1 text-right">최근</div>
          </div>
          {rows.map((r, i) => (
            <HookRowCard key={r.id} row={r} idx={i} />
          ))}
        </section>
      )}

      <footer className="text-xs text-gray-400 pt-4 border-t border-gray-100">
        ⓘ 평균 할인은 quasarzone_sale metadata.discount_pct 동반 평균. 본 페이지의 어구는
        coupang-payload-builder.mjs <code>--hook</code> 옵션으로 등록 제목 슬롯 주입 가능.
      </footer>
    </div>
  )
}

function HookRowCard({ row, idx }: { row: HookRow; idx: number }) {
  const examples = Array.isArray(row.top_examples) ? row.top_examples.slice(0, 3) : []
  const template = `[${row.phrase}] {상품명}`
  return (
    <div className="grid grid-cols-12 px-3 py-3 rounded border border-gray-200 hover:bg-gray-50 transition-colors">
      <div className="col-span-1 text-gray-400 font-mono pt-0.5">{idx + 1}</div>
      <div className="col-span-3">
        <div className="font-semibold">{row.phrase}</div>
        <CopyButton text={template} label="쿠팡 제목 템플릿 복사" />
      </div>
      <div className="col-span-1 text-right font-mono font-bold pt-0.5">{row.support}</div>
      <div className="col-span-1 text-right font-mono text-gray-600 pt-0.5">
        {row.avg_discount != null ? `${Number(row.avg_discount).toFixed(0)}%` : '—'}
      </div>
      <div className="col-span-5 space-y-1">
        {examples.length === 0 ? (
          <div className="text-xs text-gray-400">예시 없음</div>
        ) : (
          examples.map((ex, j) => (
            <div key={j} className="text-xs text-gray-700 truncate">
              {ex.source_url ? (
                <a href={ex.source_url} target="_blank" rel="noreferrer" className="hover:underline">
                  <span className="text-gray-400 mr-1">[{ex.source}]</span>
                  {ex.title}
                </a>
              ) : (
                <>
                  <span className="text-gray-400 mr-1">[{ex.source}]</span>
                  {ex.title}
                </>
              )}
            </div>
          ))
        )}
      </div>
      <div className="col-span-1 text-right text-xs text-gray-400 font-mono pt-0.5">
        {row.last_seen?.slice(5, 10)}
      </div>
    </div>
  )
}
