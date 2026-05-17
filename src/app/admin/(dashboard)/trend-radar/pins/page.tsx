import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import type { Tables } from '@/lib/supabase'
import { PinLookalikeDrawer, type LookalikeRow } from './PinLookalikeDrawer'

export const dynamic = 'force-dynamic'

type PinRow = Tables<'jimscanner_trends_pins'>

async function fetchPins(): Promise<PinRow[]> {
  const sb = createAdminClient()
  const { data } = await sb
    .from('jimscanner_trends_pins')
    .select('keyword, source, notes, pinned_at')
    .order('pinned_at', { ascending: false })
  return (data ?? []) as PinRow[]
}

async function fetchLookalikes(keyword: string, source: string): Promise<LookalikeRow[]> {
  const sb = createAdminClient()
  // RPC 는 supabase/trends_v4_pin_lookalike.sql 적용 후 사용 가능.
  // generated 타입 미반영 → `as never` 캐스팅 (해제 조건: `npm run gen:types`)
  const { data, error } = await sb.rpc('jimscanner_pin_lookalikes' as never, {
    pin_keyword: keyword,
    pin_source: source,
    top_n: 8,
    min_winner_sim: 0.2,
  } as never)
  if (error) return []
  return (data ?? []) as LookalikeRow[]
}

export default async function PinsPage() {
  const pins = await fetchPins()

  // 핀 카드별 lookalike 병렬 로드 (핀 수 적을 때 가정 — 많아지면 페이지네이션 도입)
  const lookalikesByPin = await Promise.all(
    pins.map(async (p) => ({
      key: `${p.source}::${p.keyword}`,
      rows: await fetchLookalikes(p.keyword, p.source),
    })),
  )
  const lookalikeMap = new Map(lookalikesByPin.map((l) => [l.key, l.rows]))

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold">핀한 상품 후보</h1>
          <p className="text-sm text-gray-500 mt-1">
            위탁 검토 후보 + Winning-Pin Lookalike 자동 매칭 (카테고리·가격·공급·수요 4축 유사도)
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      {pins.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500">
          <p className="text-base font-medium">핀한 항목 없음</p>
          <p className="text-sm mt-2">
            대시보드 / 디테일 페이지에서 핀 토글 후 lookalike 자동 추천됨.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {pins.map((p) => {
            const key = `${p.source}::${p.keyword}`
            const rows = lookalikeMap.get(key) ?? []
            return (
              <div key={key} className="rounded border border-gray-200 overflow-hidden">
                <div className="px-4 py-3 grid grid-cols-12 items-center text-sm bg-white">
                  <div className="col-span-5">
                    <div className="font-medium">{p.keyword}</div>
                    {p.notes && <div className="text-xs text-gray-500 mt-1">{p.notes}</div>}
                  </div>
                  <div className="col-span-3 text-xs text-gray-500">{p.source}</div>
                  <div className="col-span-2 text-xs text-gray-400 font-mono">
                    {p.pinned_at?.slice(0, 16)}
                  </div>
                  <div className="col-span-2 text-right">
                    <span
                      className={`inline-block px-2 py-0.5 text-[11px] rounded ${
                        rows.length > 0
                          ? 'bg-emerald-100 text-emerald-700'
                          : 'bg-gray-100 text-gray-500'
                      }`}
                    >
                      Lookalike {rows.length}
                    </span>
                  </div>
                </div>
                {rows.length > 0 && (
                  <PinLookalikeDrawer pinKeyword={p.keyword} pinSource={p.source} rows={rows} />
                )}
              </div>
            )
          })}
        </div>
      )}

      <section className="text-xs text-gray-500 border-t border-gray-200 pt-4 space-y-1">
        <div className="font-semibold text-gray-700">📐 Lookalike Similarity 공식</div>
        <code className="block bg-gray-50 px-3 py-2 rounded font-mono text-[11px] leading-relaxed">
          composite = 0.35·category + 0.25·price + 0.20·supply + 0.20·demand
          <br />
          category: 동일 cate_cd=1.0 / 인접(앞2자리)=0.6 / 그 외=0.0
          <br />
          price: 1 − |후보가 − winner평균가| / winner평균가 (clip 0~1)
          <br />
          supply: 임박특가 +0.4, 후보가 ≤ winner평균가 면 +0.6
          <br />
          demand: 핀 키워드 ↔ 후보 title trigram × 2 + 임박 보너스
        </code>
        <div className="pt-2 text-gray-400">
          제외 조건: 이미 다른 핀에 trigram ≥ 0.4 로 매칭된 ggsan 상품. → 중복 진입 회피.
        </div>
      </section>
    </div>
  )
}
