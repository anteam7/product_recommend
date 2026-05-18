interface PenetrationRow {
  category: string
  current_week: string | null
  cohort_week: string | null
  new_entries: number
  survived: number
  survival_pct: number | null
  avg_settled_rank: number | null
}

const CATEGORY_LABEL: Record<string, string> = {
  health: '건강식품',
  living: '생활/리빙',
  digital: '디지털/가전',
  community: '커뮤니티',
  shopping_tv: 'TV',
  all: '전체',
}

function tone(pct: number | null) {
  if (pct == null) return { bg: '#f3f4f6', label: 'text-gray-500', tag: '데이터 부족', tagBg: 'bg-gray-100 text-gray-600' }
  if (pct >= 50) return { bg: '#dcfce7', label: 'text-emerald-700', tag: '진입 가능', tagBg: 'bg-emerald-100 text-emerald-700' }
  if (pct < 20) return { bg: '#fee2e2', label: 'text-red-700', tag: '진입 불가', tagBg: 'bg-red-100 text-red-700' }
  return { bg: '#fef3c7', label: 'text-amber-700', tag: '관망', tagBg: 'bg-amber-100 text-amber-700' }
}

export default function PenetrationPanel({ rows }: { rows: PenetrationRow[] }) {
  if (rows.length === 0) {
    return (
      <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500 space-y-2">
        <p className="text-base font-medium">아직 SERP 스냅샷 데이터가 없습니다</p>
        <p className="text-sm">
          매주 KST 18:00 <code className="px-1 bg-gray-100 rounded">scripts/scrape-serp-snapshot.mjs</code> 누적 후
          <br />
          12주(약 3개월) 적재되면 4주 전 진입 코호트의 잔존율이 표시됩니다.
        </p>
      </div>
    )
  }

  const maxPct = Math.max(100, ...rows.map((r) => r.survival_pct ?? 0))

  return (
    <div className="space-y-6">
      <div className="rounded border border-gray-200 p-4 bg-slate-50">
        <h3 className="text-sm font-semibold mb-1">Penetration Index — 신규 진입자 4주 생존율</h3>
        <p className="text-xs text-gray-600 leading-relaxed">
          4주 전 처음 등장(이전 8주 미존재)한 SKU 가 현재 SERP 상위 50 에 잔존하는 비율.
          50% 이상 = 진입 가능, 20% 미만 = 진입 불가.
        </p>
        {rows[0]?.current_week && (
          <p className="text-xs text-gray-500 mt-1">
            기준 주: {rows[0].current_week} · 코호트 주: {rows[0].cohort_week}
          </p>
        )}
      </div>

      <div className="rounded border border-gray-200">
        <div className="grid grid-cols-12 text-xs text-gray-500 px-3 py-2 border-b border-gray-200 bg-gray-50">
          <div className="col-span-2">카테고리</div>
          <div className="col-span-5">생존율</div>
          <div className="col-span-1 text-right">신규</div>
          <div className="col-span-1 text-right">잔존</div>
          <div className="col-span-1 text-right">생존%</div>
          <div className="col-span-1 text-right">정착순위</div>
          <div className="col-span-1 text-right">신호</div>
        </div>
        {rows.map((r) => {
          const t = tone(r.survival_pct)
          const pct = r.survival_pct ?? 0
          const barW = Math.min(100, (pct / maxPct) * 100)
          return (
            <div key={r.category} className="grid grid-cols-12 px-3 py-2 text-sm border-b border-gray-100 items-center">
              <div className="col-span-2 font-medium">{CATEGORY_LABEL[r.category] ?? r.category}</div>
              <div className="col-span-5 pr-3">
                <div className="h-4 rounded bg-gray-100 overflow-hidden">
                  <div
                    className="h-full"
                    style={{ width: `${barW}%`, background: t.bg }}
                    title={`${pct}%`}
                  />
                </div>
              </div>
              <div className="col-span-1 text-right font-mono text-gray-600">{r.new_entries}</div>
              <div className="col-span-1 text-right font-mono text-gray-600">{r.survived}</div>
              <div className={`col-span-1 text-right font-mono font-bold ${t.label}`}>
                {r.survival_pct == null ? '—' : `${r.survival_pct}%`}
              </div>
              <div className="col-span-1 text-right font-mono text-gray-600">
                {r.avg_settled_rank == null ? '—' : r.avg_settled_rank}
              </div>
              <div className="col-span-1 text-right">
                <span className={`text-xs px-2 py-0.5 rounded ${t.tagBg}`}>{t.tag}</span>
              </div>
            </div>
          )
        })}
      </div>

      <div className="text-xs text-gray-500 leading-relaxed">
        <p>
          <span className="inline-block w-3 h-3 rounded mr-1" style={{ background: '#dcfce7' }} />
          50%↑ 진입 가능 · &nbsp;
          <span className="inline-block w-3 h-3 rounded mr-1" style={{ background: '#fef3c7' }} />
          20–50% 관망 · &nbsp;
          <span className="inline-block w-3 h-3 rounded mr-1" style={{ background: '#fee2e2' }} />
          20%↓ 진입 불가
        </p>
      </div>
    </div>
  )
}
