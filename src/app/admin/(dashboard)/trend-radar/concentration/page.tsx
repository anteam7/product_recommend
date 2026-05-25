import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

interface ConcentrationRow {
  category_top: string
  hhi: number
  top1_brand: string | null
  top1_share: number | null
  top3_share: number | null
  brand_count: number
  distinct_skus: number
  computed_at: string
}

interface BrandShareRow {
  brand: string
  share: number
}

const CATEGORY_LABEL: Record<string, string> = {
  health: '건강식품',
  living: '생활/리빙',
  digital: '디지털/가전',
  other: '기타',
}

function verdict(hhi: number): { label: string; tone: 'good' | 'mid' | 'bad' } {
  if (hhi < 1500) return { label: '진입추천', tone: 'good' }
  if (hhi <= 2500) return { label: '경합', tone: 'mid' }
  return { label: '독과점', tone: 'bad' }
}

function firstToken(name: string | null | undefined): string | null {
  if (!name) return null
  const cleaned = String(name).trim().replace(/[\[\]()]/g, ' ')
  const tok = cleaned.split(/\s+/)[0]
  if (!tok || tok.length < 2 || /^[0-9]+$/.test(tok)) return null
  return tok
}

async function fetchTop3ByCategory(): Promise<Map<string, BrandShareRow[]>> {
  const sb = createAdminClient()
  const { data } = await (sb as any)
    .from('jimscanner_trends_products')
    .select('canonical_name, category_top, brand, alias_count')
  type Row = { canonical_name: string; category_top: string; brand: string | null; alias_count: number }
  const rows = (data ?? []) as Row[]
  const acc = new Map<string, Map<string, number>>()
  for (const r of rows) {
    const cat = r.category_top || 'other'
    const brand = r.brand && r.brand.trim() ? r.brand.trim() : firstToken(r.canonical_name)
    if (!brand) continue
    const w = Math.max(1, Number(r.alias_count ?? 1))
    if (!acc.has(cat)) acc.set(cat, new Map())
    const m = acc.get(cat)!
    m.set(brand, (m.get(brand) ?? 0) + w)
  }
  const out = new Map<string, BrandShareRow[]>()
  for (const [cat, m] of acc.entries()) {
    const total = [...m.values()].reduce((a, b) => a + b, 0)
    if (total === 0) continue
    const list = [...m.entries()]
      .map(([brand, w]) => ({ brand, share: w / total }))
      .sort((a, b) => b.share - a.share)
      .slice(0, 3)
    out.set(cat, list)
  }
  return out
}

async function fetchData() {
  const sb = createAdminClient()
  const { data, error } = await (sb as any)
    .from('jimscanner_trends_category_concentration')
    .select('*')
    .order('hhi', { ascending: true })

  const rows = ((data ?? []) as ConcentrationRow[]) || []
  const top3 = await fetchTop3ByCategory()

  return { rows, error, top3 }
}

export default async function CategoryConcentrationPage() {
  const { rows, error, top3 } = await fetchData()

  const fragmented = rows.filter((r) => Number(r.hhi) < 1500).length
  const contested = rows.filter((r) => Number(r.hhi) >= 1500 && Number(r.hhi) <= 2500).length
  const dominated = rows.filter((r) => Number(r.hhi) > 2500).length

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold">카테고리 브랜드 집중도</h1>
          <p className="text-sm text-gray-500 mt-1">
            HHI 0~10000 · &lt; 1500 fragmented (위탁 진입 추천) · 1500~2500 경합 · &gt; 2500 독과점
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      <section className="grid grid-cols-3 gap-4">
        <Kpi label="fragmented (위탁 추천)" value={fragmented} tone="good" hint="HHI < 1500" />
        <Kpi label="경합" value={contested} tone="mid" hint="1500 ≤ HHI ≤ 2500" />
        <Kpi label="독과점" value={dominated} tone="bad" hint="HHI > 2500" />
      </section>

      {error && (
        <div className="rounded border border-red-200 bg-red-50 p-4 text-sm text-red-800">
          테이블 조회 실패: {error.message} — supabase/trends_v4_category_concentration.sql 마이그레이션이 적용됐는지 확인하세요.
        </div>
      )}

      {rows.length === 0 && !error ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500">
          <p className="text-base font-medium">아직 산출 데이터 없음</p>
          <p className="text-sm mt-2">
            <code className="px-1 bg-gray-100 rounded">
              node --env-file=.env.local scripts/compute-category-hhi.mjs
            </code>{' '}
            실행 후 다시 방문.
          </p>
        </div>
      ) : (
        <section className="rounded border border-gray-200 overflow-hidden">
          <div className="grid grid-cols-12 bg-gray-50 px-4 py-2 text-xs text-gray-500 font-semibold">
            <div className="col-span-2">카테고리</div>
            <div className="col-span-3">HHI</div>
            <div className="col-span-4">Top 3 브랜드 share</div>
            <div className="col-span-1 text-right">brands</div>
            <div className="col-span-1 text-right">SKU</div>
            <div className="col-span-1 text-right">판정</div>
          </div>
          {rows.map((r) => {
            const v = verdict(Number(r.hhi))
            const hhiPct = Math.min(100, (Number(r.hhi) / 10000) * 100)
            const brands = top3.get(r.category_top) ?? []
            return (
              <div
                key={r.category_top}
                className="grid grid-cols-12 px-4 py-3 border-t border-gray-100 items-center"
              >
                <div className="col-span-2">
                  <div className="font-medium">
                    {CATEGORY_LABEL[r.category_top] ?? r.category_top}
                  </div>
                  <div className="text-xs text-gray-500">{r.category_top}</div>
                </div>
                <div className="col-span-3">
                  <div className="flex items-center gap-2">
                    <div className="flex-1 h-2 rounded bg-gray-100 overflow-hidden">
                      <div
                        className={`h-full ${
                          v.tone === 'good'
                            ? 'bg-emerald-500'
                            : v.tone === 'mid'
                              ? 'bg-amber-500'
                              : 'bg-red-500'
                        }`}
                        style={{ width: `${hhiPct}%` }}
                      />
                    </div>
                    <div className="font-mono text-sm w-14 text-right">
                      {Math.round(Number(r.hhi))}
                    </div>
                  </div>
                  <div className="text-xs text-gray-500 mt-1">
                    top1 {r.top1_brand ?? '-'}{' '}
                    {r.top1_share != null ? `(${Math.round(Number(r.top1_share) * 100)}%)` : ''}
                    {r.top3_share != null
                      ? ` · top3 ${Math.round(Number(r.top3_share) * 100)}%`
                      : ''}
                  </div>
                </div>
                <div className="col-span-4">
                  <div className="flex h-5 w-full rounded overflow-hidden bg-gray-100">
                    {brands.map((b, i) => (
                      <div
                        key={b.brand}
                        title={`${b.brand} ${(b.share * 100).toFixed(1)}%`}
                        className={
                          i === 0
                            ? 'bg-indigo-500'
                            : i === 1
                              ? 'bg-indigo-400'
                              : 'bg-indigo-300'
                        }
                        style={{ width: `${b.share * 100}%` }}
                      />
                    ))}
                  </div>
                  <div className="text-xs text-gray-500 mt-1 truncate">
                    {brands
                      .map((b) => `${b.brand} ${(b.share * 100).toFixed(0)}%`)
                      .join(' · ') || '-'}
                  </div>
                </div>
                <div className="col-span-1 text-right font-mono text-sm">
                  {r.brand_count}
                </div>
                <div className="col-span-1 text-right font-mono text-sm">
                  {r.distinct_skus}
                </div>
                <div className="col-span-1 text-right">
                  <span
                    className={`inline-block text-xs px-2 py-1 rounded ${
                      v.tone === 'good'
                        ? 'bg-emerald-100 text-emerald-700'
                        : v.tone === 'mid'
                          ? 'bg-amber-100 text-amber-700'
                          : 'bg-red-100 text-red-700'
                    }`}
                  >
                    {v.label}
                  </span>
                </div>
              </div>
            )
          })}
        </section>
      )}

      {rows.length > 0 && (
        <p className="text-xs text-gray-400">
          마지막 산출: {rows[0]?.computed_at?.slice(0, 19).replace('T', ' ') ?? '-'}
        </p>
      )}
    </div>
  )
}

function Kpi({
  label,
  value,
  tone,
  hint,
}: {
  label: string
  value: number
  tone: 'good' | 'mid' | 'bad'
  hint: string
}) {
  const color =
    tone === 'good'
      ? 'text-emerald-600'
      : tone === 'mid'
        ? 'text-amber-600'
        : 'text-red-600'
  return (
    <div className="rounded border border-gray-200 p-4">
      <div className="text-xs text-gray-500">{label}</div>
      <div className={`text-3xl font-bold mt-1 ${color}`}>{value}</div>
      <div className="text-xs text-gray-400 mt-1">{hint}</div>
    </div>
  )
}
