// 상품 발굴 서사 타임라인 — 신호→소싱→판매 단일 연대기 뷰
// 여러 테이블(키워드/점수/도매가/주문)에 흩어진 사건을 시간축 하나로 엮어
// "이 상품이 왜·언제 떴고 우리가 어디까지 왔나"를 한눈에 보여준다.

export type TimelineKind =
  | 'signal' // 트렌드 신호 최초 포착 (키워드 등장)
  | 'score' // 점수 변곡점
  | 'sourcing' // 도매 소싱 연결
  | 'price' // 도매가 변동
  | 'sale' // 쿠팡 실판매
  | 'meta' // 발굴/마지막 관측 등 메타 이벤트

export interface TimelineEvent {
  at: string // ISO timestamp
  kind: TimelineKind
  title: string
  detail?: string
  // 규칙 기반 자동 주석 — 핵심 변곡점이면 강조 배지로 표시
  annotation?: string
}

const KIND_META: Record<
  TimelineKind,
  { dot: string; ring: string; label: string; icon: string }
> = {
  signal: { dot: 'bg-sky-500', ring: 'ring-sky-100', label: '신호', icon: '📡' },
  score: { dot: 'bg-violet-500', ring: 'ring-violet-100', label: '점수', icon: '📈' },
  sourcing: { dot: 'bg-emerald-500', ring: 'ring-emerald-100', label: '소싱', icon: '🛒' },
  price: { dot: 'bg-amber-500', ring: 'ring-amber-100', label: '도매가', icon: '💱' },
  sale: { dot: 'bg-rose-500', ring: 'ring-rose-100', label: '실판매', icon: '💰' },
  meta: { dot: 'bg-gray-400', ring: 'ring-gray-100', label: '메타', icon: '•' },
}

function fmt(at: string): string {
  // 2026-05-29T03:30:00Z → '05-29 03:30'
  if (!at) return '—'
  return at.slice(5, 16).replace('T', ' ')
}

export default function TimelineRail({ events }: { events: TimelineEvent[] }) {
  if (!events.length) {
    return (
      <p className="text-sm text-gray-400 rounded border border-dashed border-gray-200 p-4 text-center">
        연대기로 엮을 이벤트가 아직 없습니다 (신호·소싱·판매 데이터 대기 중)
      </p>
    )
  }

  return (
    <ol className="relative ml-2 border-l border-gray-200">
      {events.map((ev, i) => {
        const meta = KIND_META[ev.kind] ?? KIND_META.meta
        return (
          <li key={i} className="relative pl-6 pb-5 last:pb-0">
            <span
              className={`absolute -left-[7px] top-1 h-3.5 w-3.5 rounded-full ring-4 ${meta.dot} ${meta.ring}`}
              aria-hidden
            />
            <div className="flex items-baseline gap-2 flex-wrap">
              <span className="font-mono text-[11px] text-gray-400">{fmt(ev.at)}</span>
              <span className="text-[10px] uppercase tracking-wide text-gray-400">
                {meta.icon} {meta.label}
              </span>
              {ev.annotation && (
                <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-black text-white font-medium">
                  ★ {ev.annotation}
                </span>
              )}
            </div>
            <div className="text-sm text-gray-900 mt-0.5">{ev.title}</div>
            {ev.detail && <div className="text-xs text-gray-500 mt-0.5">{ev.detail}</div>}
          </li>
        )
      })}
    </ol>
  )
}
