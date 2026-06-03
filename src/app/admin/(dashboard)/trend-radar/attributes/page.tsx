import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

// supabase generated 타입 미반영 테이블/RPC — `npm run gen:types` 후 캐스팅 제거
/* eslint-disable @typescript-eslint/no-explicit-any */

interface ModifierRow {
  modifier: string
  base_category: string | null
  occurrence_count: number
  momentum_7d: number
  sample_product_ids: string[]
  computed_at: string
}

interface GgsanMatch {
  goods_no: string
  title: string
  cate_cd: string | null
  cate_label: string | null
  price_krw: number | null
  is_imminent: boolean
  image_url: string | null
  detail_url: string | null
  sim: number
}

const CATEGORY_COLORS: Record<string, string> = {
  health: '#10b981',
  living: '#f59e0b',
  digital: '#3b82f6',
  community: '#a78bfa',
  shopping_tv: '#ef4444',
  all: '#6b7280',
}

// 최신 스냅샷(computed_at MAX)만 modifier+base_category 별로 추린다.
async function fetchModifiers(): Promise<ModifierRow[]> {
  const sb = createAdminClient()
  const { data } = await sb
    .from('jimscanner_trends_modifiers' as any)
    .select('modifier, base_category, occurrence_count, momentum_7d, sample_product_ids, computed_at')
    .order('computed_at', { ascending: false })
    .limit(2000)

  const seen = new Set<string>()
  const latest: ModifierRow[] = []
  for (const r of ((data ?? []) as any[]) as ModifierRow[]) {
    const key = `${r.modifier}|||${r.base_category ?? ''}`
    if (seen.has(key)) continue
    seen.add(key)
    latest.push(r)
  }
  return latest
}

// 드릴다운: 해당 속성 토큰을 가진 ggsan 변형 SKU (pg_trgm ILIKE 매칭 RPC)
async function fetchGgsanMatches(modifier: string): Promise<{ rows: GgsanMatch[]; error: string | null }> {
  const sb = createAdminClient()
  const { data, error } = await sb.rpc('jimscanner_trends_modifier_ggsan_match' as never, {
    modifier_token: modifier,
    result_limit: 60,
  } as never)
  if (error) {
    // RPC 미적용 fallback: title ILIKE 직접 질의 (gin_trgm 인덱스 활용)
    const fb = await sb
      .from('jimscanner_ggsan_products' as any)
      .select('goods_no, title, cate_cd, cate_label, price_krw, is_imminent, image_url, detail_url')
      .eq('status', 'active')
      .ilike('title', `%${modifier}%`)
      .order('is_imminent', { ascending: false })
      .limit(60)
    const rows = ((fb.data ?? []) as any[]).map((r) => ({ ...r, sim: 0 })) as GgsanMatch[]
    return { rows, error: fb.error ? fb.error.message : null }
  }
  return { rows: ((data ?? []) as any[]) as GgsanMatch[], error: null }
}

export default async function AttributesPage({
  searchParams,
}: {
  searchParams: Promise<{ m?: string; cat?: string }>
}) {
  const sp = await searchParams
  const selected = sp.m ?? ''
  const catFilter = sp.cat ?? ''

  const all = await fetchModifiers()
  let rows = all
  if (catFilter) rows = rows.filter((r) => (r.base_category ?? '') === catFilter)

  // 모멘텀 내림차순, 동률이면 등장수
  rows = [...rows].sort((a, b) => b.momentum_7d - a.momentum_7d || b.occurrence_count - a.occurrence_count)

  const maxOcc = Math.max(1, ...rows.map((r) => r.occurrence_count))
  const cats = Array.from(new Set(all.map((r) => r.base_category ?? 'all')))

  const drill = selected ? await fetchGgsanMatches(selected) : null

  const current: Record<string, string> = { m: selected, cat: catFilter }
  const buildHref = (override: Record<string, string | null>) => {
    const params = new URLSearchParams()
    for (const [k, v] of Object.entries(current)) if (v) params.set(k, v)
    for (const [k, v] of Object.entries(override)) {
      if (v == null || v === '') params.delete(k)
      else params.set(k, v)
    }
    const qs = params.toString()
    return '/admin/trend-radar/attributes' + (qs ? `?${qs}` : '')
  }

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold">📊 속성 모멘텀 보드</h1>
          <p className="text-sm text-gray-500 mt-1">
            트렌드 코퍼스를 수식어(스펙) 토큰으로 분해 — 베이스 안에서 <strong>지금 뜨는 변형</strong>을 데이터로 고른다.
            막대 클릭 → 해당 속성을 가진 ggsan 변형 SKU 드릴다운.
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      {/* 카테고리 필터 */}
      <div className="flex flex-wrap gap-1">
        <Link
          href={buildHref({ cat: null, m: null })}
          className={`px-2 py-1 text-xs rounded ${catFilter === '' ? 'bg-black text-white font-semibold' : 'text-gray-500 hover:text-black'}`}
        >
          전체
        </Link>
        {cats.map((c) => (
          <Link
            key={c}
            href={buildHref({ cat: c === 'all' ? null : c, m: null })}
            className={`px-2 py-1 text-xs rounded ${catFilter === c ? 'bg-black text-white font-semibold' : 'text-gray-500 hover:text-black'}`}
          >
            {c}
          </Link>
        ))}
      </div>

      {rows.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500 space-y-2">
          <div className="text-base font-medium">아직 속성 데이터 없음</div>
          <div className="text-xs text-gray-400">
            <code className="font-mono">node scripts/_extract-modifiers.mjs</code> 실행 후 누적됨.
            (마이그레이션 <code>supabase/trends_v4_modifiers.sql</code> 선적용 필요)
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-[minmax(360px,1fr)_minmax(420px,1.2fr)] gap-6">
          {/* 모멘텀 막대 */}
          <div className="rounded border border-gray-200 p-4 space-y-2">
            <h2 className="text-sm font-semibold mb-3">
              모멘텀 랭킹 <span className="text-xs font-normal text-gray-400">(최근7일 / 이전7일 등장비)</span>
            </h2>
            {rows.map((r) => {
              const color = CATEGORY_COLORS[r.base_category ?? 'all'] ?? '#6b7280'
              const widthPct = Math.round((r.occurrence_count / maxOcc) * 100)
              const rising = r.momentum_7d > 1.0
              const isSel = r.modifier === selected
              return (
                <Link
                  key={`${r.modifier}-${r.base_category ?? 'all'}`}
                  href={buildHref({ m: isSel ? null : r.modifier })}
                  className={`block rounded px-2 py-1.5 transition-colors ${isSel ? 'bg-gray-100 ring-1 ring-gray-300' : 'hover:bg-gray-50'}`}
                >
                  <div className="flex items-center justify-between text-xs mb-1">
                    <span className="font-medium">
                      {r.modifier}
                      <span className="ml-1 text-gray-400">[{r.base_category ?? 'all'}]</span>
                    </span>
                    <span className="font-mono flex items-center gap-2">
                      <span className="text-gray-400">n={r.occurrence_count}</span>
                      <span className={rising ? 'text-emerald-600 font-semibold' : 'text-gray-400'}>
                        {rising ? '▲' : '▽'} {r.momentum_7d.toFixed(2)}×
                      </span>
                    </span>
                  </div>
                  <div className="h-2.5 rounded bg-gray-100 overflow-hidden">
                    <div
                      className="h-full rounded"
                      style={{ width: `${widthPct}%`, background: color, opacity: rising ? 0.9 : 0.4 }}
                    />
                  </div>
                </Link>
              )
            })}
          </div>

          {/* 드릴다운 */}
          <div className="rounded border border-gray-200 p-4">
            {!selected ? (
              <div className="text-sm text-gray-400 p-8 text-center">
                ← 좌측 속성 막대를 클릭하면 해당 스펙을 가진 ggsan 변형 SKU 가 여기 뜬다.
              </div>
            ) : (
              <>
                <div className="flex items-baseline justify-between mb-3">
                  <h2 className="text-sm font-semibold">
                    &ldquo;{selected}&rdquo; 변형 ggsan SKU
                    <span className="ml-2 text-xs font-normal text-gray-400">{drill?.rows.length ?? 0}건</span>
                  </h2>
                  <Link href={buildHref({ m: null })} className="text-xs text-gray-400 hover:text-black">
                    ✕ 닫기
                  </Link>
                </div>
                {drill?.error && (
                  <div className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 mb-3">
                    RPC <code>jimscanner_trends_modifier_ggsan_match</code> 미적용 — ILIKE fallback 사용 중.
                  </div>
                )}
                {(!drill || drill.rows.length === 0) ? (
                  <div className="text-xs text-gray-400 p-6 text-center">
                    매칭되는 ggsan 변형 없음. ggsan 카탈로그에 해당 스펙 상품이 아직 없거나, 다른 표현일 수 있음.
                  </div>
                ) : (
                  <div className="space-y-2 max-h-[640px] overflow-y-auto pr-1">
                    {drill.rows.map((g) => (
                      <a
                        key={g.goods_no}
                        href={g.detail_url ?? '#'}
                        target="_blank"
                        rel="noopener"
                        className={`flex items-start gap-3 rounded border p-2 hover:shadow-sm transition-all ${
                          g.is_imminent ? 'border-red-200 bg-red-50/40 hover:bg-red-50' : 'border-gray-200 hover:bg-gray-50'
                        }`}
                      >
                        <div className="w-14 h-14 bg-gray-100 rounded overflow-hidden flex-shrink-0 relative">
                          {g.image_url && (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img src={g.image_url} alt="" loading="lazy" className="w-full h-full object-cover" />
                          )}
                          {g.is_imminent && (
                            <span className="absolute top-0 left-0 bg-red-600 text-white text-[8px] px-1 leading-tight rounded-br">
                              임박
                            </span>
                          )}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="text-xs font-medium leading-snug" title={g.title}>
                            {g.title}
                          </div>
                          <div className="text-[11px] text-gray-500 mt-0.5">
                            {g.cate_label ?? g.cate_cd} · {g.goods_no}
                          </div>
                        </div>
                        <div className="text-right flex-shrink-0">
                          <div className="text-sm font-bold">
                            {g.price_krw ? `${g.price_krw.toLocaleString()}원` : <span className="text-gray-400 text-xs">-</span>}
                          </div>
                          {g.sim > 0 && (
                            <div className="text-[10px] font-mono text-gray-400">sim {Number(g.sim).toFixed(2)}</div>
                          )}
                        </div>
                      </a>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}

      {/* 설명 */}
      <section className="text-xs text-gray-500 border-t border-gray-200 pt-4 space-y-1">
        <div className="font-semibold text-gray-700">📐 동작</div>
        <p>
          <code>scripts/_extract-modifiers.mjs</code> 가 trends alias+canonical 코퍼스에서 수식어 토큰을 룰 추출 →
          <code> jimscanner_trends_modifiers</code> 에 시계열 적재. momentum_7d = 최근7일 등장 / 이전7일 등장.
          드릴다운은 <code>jimscanner_ggsan_products.title</code> 에 pg_trgm(ILIKE, gin_trgm 인덱스) 매칭.
        </p>
      </section>
    </div>
  )
}
