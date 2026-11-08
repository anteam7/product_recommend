import Link from 'next/link'
import { FEE_RATE, FEE_RATE_BY_SOURCE } from '@/lib/coupang/fee'
import { TOSS_FEE_RATE } from '@/lib/toss/fee'
import { loadLastSync, loadOpenClaims, loadOrders, loadPeriodCoupangActivity, loadTodo } from './data'
import { OrdersTable } from './OrdersTable'
import SyncOrdersButton from './coupang/SyncOrdersButton'
import {
  MARKETS, MARKET_META, OPEN_CLAIMS_HREF, ORDERS_PATH, PERIOD_OPTIONS, PURCHASE_STATUSES, PURCHASE_STATUS_LABELS, SORT_OPTIONS, DEFAULT_DAYS,
  buildHref, countByPurchase, filterOrders, fmtDate, fmtKst, isPurchaseStatus, paginate, parseParams, periodActivity, sortOrders, summarize,
  type Agg, type Market, type OpenClaim, type PeriodActivity, type RawSearchParams, type Tally,
} from './model'

export const dynamic = 'force-dynamic'

/**
 * 주문 ↔ 매입 (전 마켓) — 쿠팡·네이버·토스 주문을 한 화면에서. 마켓 칩으로 한 마켓만 보기, 매출·실수익 카드도 통합(마켓별 분해 포함).
 * 2026-10-13 사용자 요청: 마켓별 메뉴라 다른 마켓 주문을 놓치는 일이 반복 → 통합 + "처리 대기" 배너(기간 무관).
 */
export default async function OrdersPage({ searchParams }: { searchParams: Promise<RawSearchParams> }) {
  const p = parseParams(await searchParams)
  const [{ orders: allOrders, errors }, todo, lastSync, openClaims, periodCoupang] = await Promise.all([
    loadOrders(MARKETS, p.days), loadTodo(), loadLastSync(),
    // 실패해도 주문 화면은 보여준다(패널 자리에 실패 문구)
    loadOpenClaims().catch((e: unknown) => { console.error('[orders] 진행 중 반품·출고중지 조회 실패:', e instanceof Error ? e.message : e); return null }),
    loadPeriodCoupangActivity(p.days).catch((e: unknown) => { console.error('[orders] 기간 반품·문의 조회 실패:', e instanceof Error ? e.message : e); return null }),
  ])

  // 마켓 필터는 메모리 — 전 마켓을 항상 읽어야 마켓 칩에 기간 내 건수를 함께 보여줄 수 있다(규모 작음)
  const scoped = p.market ? allOrders.filter((o) => o.market === p.market) : allOrders
  const summary = summarize(scoped)
  // 쿠팡 접수·문의는 전 마켓·쿠팡 보기에서만 더한다
  const activity = periodActivity(scoped, p.market === '' || p.market === 'coupang' ? periodCoupang : undefined)
  const byPurchase = countByPurchase(scoped)
  const list = paginate(sortOrders(filterOrders(scoped, p), p.sort), p.page)
  const periodCount = Object.fromEntries(MARKETS.map((m) => [m, allOrders.filter((o) => o.market === m).length])) as Record<Market, number>
  const allTimeTotal = MARKETS.reduce((s, m) => s + todo[m].total, 0)
  const todoTotal = MARKETS.reduce((s, m) => s + todo[m].pending + todo[m].awaiting + todo[m].attention, 0)
  // 진행 중 반품·출고중지 접수 — 대개 주문 행 확인필요와 겹쳐 처리 대기 합계엔 더하지 않고 따로 보여준다
  const claimTotal = todo.coupang.claimStop + todo.coupang.claimReturn
  const periodLabel = PERIOD_OPTIONS.find((o) => o.v === p.days)?.label ?? ''
  const failedMarkets = MARKETS.filter((m) => errors[m])

  const feeSub = p.market === 'coupang' ? `기본 ${(FEE_RATE * 100).toFixed(1)}% · 화장품스토리 ${(FEE_RATE_BY_SOURCE.cmtstory * 100).toFixed(1)}%`
    : p.market === 'naver' ? '네이버 실수수료 합(주문 API 값)'
    : p.market === 'toss' ? `${(TOSS_FEE_RATE * 100).toFixed(0)}% 추정(판매 8%+결제 3%)`
    : `쿠팡 요율(${(FEE_RATE * 100).toFixed(1)}%·화장품 ${(FEE_RATE_BY_SOURCE.cmtstory * 100).toFixed(1)}%) · 네이버 실값 · 토스 ${(TOSS_FEE_RATE * 100).toFixed(0)}%`

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold">주문 ↔ 매입 <span className="text-gray-400 font-normal text-lg">전 마켓</span></h1>
          <p className="text-sm text-gray-500 mt-1">
            쿠팡·네이버·토스 주문이 들어오면 매입처 발주 → 매입처 발송 → 마켓 송장 등록까지 한 화면에서 추적 · 누적{' '}
            <strong>{allTimeTotal.toLocaleString()}</strong>건
            <span className="text-gray-400"> ({MARKETS.map((m) => `${MARKET_META[m].label} ${todo[m].total.toLocaleString()}`).join(' · ')})</span>
          </p>
          <p className="text-[11px] text-gray-400 mt-0.5">
            마지막 수집 · {MARKETS.map((m) => {
              const r = lastSync[m]
              // 정상 표기는 크론마다 다름(쿠팡 success · 네이버 ok) — 그 외(error/running)만 괄호로 노출
              const bad = r && !['success', 'ok'].includes(r.status)
              return `${MARKET_META[m].label} ${r ? `${fmtDate(r.started_at)}${bad ? ` (${r.status})` : ''}` : '기록 없음'}`
            }).join(' · ')}
          </p>
        </div>
        <SyncOrdersButton />
      </header>

      {/* 진행 중 쿠팡 반품·출고중지 — 맨 위 건별 목록(기간 무관). 출고중지요청은 결제진행도 막혀 있다 */}
      {openClaims === null ? (
        <div className="rounded border border-rose-300 bg-rose-50 px-4 py-2 text-xs text-rose-700">쿠팡 반품·출고중지 요청을 못 읽었습니다(DB 오류) — Wing에서 직접 확인하세요.</div>
      ) : openClaims.items.length > 0 && <ClaimPanel stop={openClaims.stop} returning={openClaims.returning} items={openClaims.items} />}

      {failedMarkets.length > 0 && (
        <div className="rounded border border-rose-300 bg-rose-50 px-4 py-3 text-sm text-rose-700">
          DB 오류로 일부 마켓 주문을 못 읽었습니다 — {failedMarkets.map((m) => `${MARKET_META[m].label}: ${String(errors[m]).slice(0, 120)}`).join(' / ')}. 아래 목록·합계에서 빠져 있습니다.
        </div>
      )}

      {/* 처리 대기(기간 무관) — 기간 필터 밖의 미발주·입금대기·확인필요를 놓치지 않게 항상 전체 기간 기준 */}
      {(todoTotal > 0 || claimTotal > 0) && (
        <div className="rounded border border-rose-300 bg-rose-50 px-4 py-3 text-sm text-rose-700 flex flex-wrap items-center gap-x-4 gap-y-1">
          <strong>⚠ 처리 대기 {todoTotal}건{claimTotal > 0 ? ` · 쿠팡 반품·출고중지 ${claimTotal}건` : ''}</strong>
          {MARKETS.map((m) => {
            const t = todo[m]
            const n = t.pending + t.awaiting + t.attention + t.claimStop + t.claimReturn
            if (n === 0) return <span key={m} className="text-rose-400">{MARKET_META[m].icon} {MARKET_META[m].label} 0</span>
            return (
              <span key={m} className="flex items-center gap-1.5">
                <span className="font-semibold">{MARKET_META[m].icon} {MARKET_META[m].label}</span>
                {t.pending > 0 && <Link href={buildHref(p, { market: m, purchase: 'PENDING', days: 0, q: null, page: null })} className="underline hover:text-rose-900">미발주 {t.pending}</Link>}
                {t.awaiting > 0 && <Link href={buildHref(p, { market: m, purchase: 'AWAITING_DEPOSIT', days: 0, q: null, page: null })} className="underline hover:text-rose-900">💰 입금대기 {t.awaiting}</Link>}
                {t.attention > 0 && <Link href={buildHref(p, { market: m, purchase: null, claim: null, days: 0, q: null, page: null })} className="underline hover:text-rose-900" title="매입처 취소/반품·택배사 미매핑·송장등록 실패 등 — 행의 ⚠ 표시">확인필요 {t.attention}</Link>}
                {t.claimStop > 0 && <Link href={buildHref(p, { market: m, purchase: null, claim: 'open', days: 0, q: null, page: null })} className="underline font-bold hover:text-rose-900" title="고객이 발주확인 뒤 취소 — 매입처 발주 전이면 발주하지 말고, 발주했으면 매입처 취소 후 Wing에서 출고중지 처리">🛑 출고중지요청 {t.claimStop}</Link>}
                {t.claimReturn > 0 && <Link href={buildHref(p, { market: m, purchase: null, claim: 'open', days: 0, q: null, page: null })} className="underline hover:text-rose-900" title="반품접수·반품 입고완료·쿠팡확인요청 — 회수 확인 후 Wing에서 반품 승인, 매입처 반품·환불 확인">↩ 반품 진행 {t.claimReturn}</Link>}
              </span>
            )
          })}
          <span className="text-[11px] text-rose-400 ml-auto">전체 기간 기준 · 클릭하면 해당 마켓·전체 기간으로 이동</span>
        </div>
      )}

      {/* 마켓 칩 + 기간 */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-gray-500">마켓</span>
        <Link
          href={buildHref(p, { market: null, page: null })}
          className={`px-3 py-1 text-sm rounded-full border ${p.market === '' ? 'bg-gray-900 text-white border-gray-900 font-semibold' : 'text-gray-600 border-gray-300 hover:bg-gray-100'}`}
        >
          전체 <span className={`text-xs ${p.market === '' ? 'text-gray-300' : 'text-gray-400'}`}>{allOrders.length}</span>
        </Link>
        {MARKETS.map((m) => {
          const active = p.market === m
          return (
            <Link
              key={m}
              href={buildHref(p, { market: m, page: null })}
              className={`px-3 py-1 text-sm rounded-full border ${active ? `${MARKET_META[m].badgeCls} border-transparent font-semibold` : 'text-gray-600 border-gray-300 hover:bg-gray-100'}`}
            >
              {MARKET_META[m].icon} {MARKET_META[m].label} <span className="text-xs opacity-70">{periodCount[m]}</span>
            </Link>
          )
        })}
        <span className="mx-2 h-5 border-l border-gray-200" />
        <span className="text-xs text-gray-500">기간</span>
        {PERIOD_OPTIONS.map((o) => (
          <Link
            key={o.v}
            href={buildHref(p, { days: o.v, page: null })}
            className={`px-2.5 py-1 text-xs rounded ${p.days === o.v ? 'bg-gray-900 text-white font-semibold' : 'text-gray-500 hover:bg-gray-100'}`}
          >
            {o.label}
          </Link>
        ))}
      </div>

      {/* 통합 실수익 요약 */}
      <section className="space-y-2">
        <div className="text-xs text-gray-500">
          {periodLabel === '전체' ? '전체 기간' : `최근 ${periodLabel}`} · {p.market ? MARKET_META[p.market].label : '전 마켓'} · 주문 {summary.total.count.toLocaleString()}건 (취소·반품 제외)
        </div>
        <ActivityCards a={activity} keptOrders={summary.total.count} />
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          <Kpi label="총 매출" value={`${summary.total.revenue.toLocaleString()}원`} />
          <Kpi label="총 매입원가" value={`${summary.total.cost.toLocaleString()}원`} />
          <Kpi label="수수료" value={`${summary.total.fee.toLocaleString()}원`} sub={feeSub} />
          <Kpi label="총 실수익 (부가세 포함)" value={`${(summary.total.net + summary.total.vat).toLocaleString()}원`} sub={`납부 부가세 차감 전 (부가세 ${summary.total.vat.toLocaleString()})`} />
          <Kpi label="총 실수익 (부가세 제외)" value={`${summary.total.net.toLocaleString()}원`} sub={`납부 부가세 = (결제−매입원가)÷11 → −${summary.total.vat.toLocaleString()} · 마진 ${summary.total.netPct.toFixed(1)}%`} highlight positive={summary.total.net >= 0} />
        </div>
        {summary.total.costMissing > 0 && (
          <p className="text-[11px] text-amber-600">
            ⚠ 매입원가 미입력 <strong>{summary.total.costMissing}건</strong>은 원가 0으로 계산되어 실수익이 과대 표시됩니다. 매입가를 입력하면 정확해집니다.
          </p>
        )}

        {/* 마켓별 분해 — 전 마켓 보기일 때만 */}
        {p.market === '' && (
          <div className="overflow-x-auto">
            <table className="text-xs tabular-nums border rounded bg-white min-w-[640px]">
              <thead className="bg-gray-50 text-gray-500">
                <tr>
                  <th className="px-3 py-1.5 text-left font-semibold">마켓</th>
                  <th className="px-3 py-1.5 text-right font-semibold">주문</th>
                  <th className="px-3 py-1.5 text-right font-semibold">매출</th>
                  <th className="px-3 py-1.5 text-right font-semibold">매입원가</th>
                  <th className="px-3 py-1.5 text-right font-semibold">수수료</th>
                  <th className="px-3 py-1.5 text-right font-semibold">부가세</th>
                  <th className="px-3 py-1.5 text-right font-semibold">실수익</th>
                  <th className="px-3 py-1.5 text-right font-semibold">마진</th>
                </tr>
              </thead>
              <tbody>
                {MARKETS.map((m) => <BreakdownRow key={m} market={m} agg={summary.byMarket[m]} href={buildHref(p, { market: m, page: null })} />)}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* 매입 상태 탭 (현재 마켓·기간 내 건수) */}
      <nav className="flex flex-wrap gap-1 border-b border-gray-200">
        <Link
          href={buildHref(p, { purchase: null, page: null })}
          className={`px-3 py-2 text-sm border-b-2 ${p.purchase === '' ? 'border-gray-900 font-semibold' : 'border-transparent text-gray-500 hover:text-black'}`}
        >
          전체 <span className="text-xs text-gray-400">{scoped.length}</span>
        </Link>
        {PURCHASE_STATUSES.map((s) => {
          const cnt = byPurchase.get(s) ?? 0
          if (cnt === 0 && p.purchase !== s) return null
          return (
            <Link
              key={s}
              href={buildHref(p, { purchase: s, page: null })}
              className={`px-3 py-2 text-sm border-b-2 ${p.purchase === s ? 'border-gray-900 font-semibold' : 'border-transparent text-gray-500 hover:text-black'}`}
            >
              {PURCHASE_STATUS_LABELS[s].label} <span className="text-xs text-gray-400">{cnt}</span>
            </Link>
          )
        })}
      </nav>

      {/* 검색 + 정렬 */}
      <div className="flex flex-wrap items-center gap-3">
        <form className="flex-1 max-w-sm" action={ORDERS_PATH}>
          {p.market && <input type="hidden" name="market" value={p.market} />}
          {p.purchase && <input type="hidden" name="purchase" value={p.purchase} />}
          {p.claim && <input type="hidden" name="claim" value={p.claim} />}
          {p.sort !== 'recent' && <input type="hidden" name="sort" value={p.sort} />}
          {p.days !== DEFAULT_DAYS && <input type="hidden" name="days" value={String(p.days)} />}
          <input
            type="text"
            name="q"
            defaultValue={p.q}
            placeholder="상품명 검색"
            className="w-full px-3 py-1 text-sm border border-gray-300 rounded"
          />
        </form>
        {p.claim === 'open' && (
          <Link href={buildHref(p, { claim: null, page: null })} className="text-xs px-2 py-1 rounded bg-rose-100 text-rose-700 font-semibold hover:bg-rose-200" title="필터 해제">
            🛑↩ 진행 중 반품·출고중지만 보는 중 ✕
          </Link>
        )}
        <div className="ml-auto flex items-center gap-2">
          <span className="text-xs text-gray-500">정렬</span>
          {SORT_OPTIONS.map((s) => (
            <Link
              key={s.v}
              href={buildHref(p, { sort: s.v, page: null })}
              className={`text-xs px-2 py-1 rounded ${p.sort === s.v ? 'bg-blue-100 text-blue-700 font-semibold' : 'text-gray-500 hover:bg-gray-100'}`}
            >
              {s.label}
            </Link>
          ))}
        </div>
      </div>

      <OrdersTable
        rows={list.rows}
        emptyText={
          p.q || p.purchase || p.claim
            ? '조건에 맞는 주문이 없습니다.'
            : `${periodLabel === '전체' ? '' : `최근 ${periodLabel} `}주문이 없습니다. 마켓에서 주문이 들어오면 매시간 자동으로 추가됩니다.`
        }
      />

      {list.totalPages > 1 && (
        <div className="flex justify-center items-center gap-1 text-sm">
          {list.page > 1 && <Link href={buildHref(p, { page: list.page - 1 })} className="px-2 py-1 rounded bg-gray-100 text-gray-700 hover:bg-gray-200">← 이전</Link>}
          {pageWindow(list.page, list.totalPages).map((n) => (
            <Link
              key={n}
              href={buildHref(p, { page: n })}
              className={`px-3 py-1 rounded ${list.page === n ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'}`}
            >
              {n}
            </Link>
          ))}
          {list.page < list.totalPages && <Link href={buildHref(p, { page: list.page + 1 })} className="px-2 py-1 rounded bg-gray-100 text-gray-700 hover:bg-gray-200">다음 →</Link>}
          <span className="text-xs text-gray-400 ml-2">{list.page} / {list.totalPages} · {list.total.toLocaleString()}건</span>
        </div>
      )}

      <div className="text-xs text-gray-400 border-t pt-3 leading-relaxed">
        ℹ️ 흐름: 마켓 주문 자동 수집(매시간, 집 PC 크론) → 🛒 매입처 발주(💳 결제진행 = 주문서 자동 작성, 완주 시 💰입금대기 + 주문번호 자동 기록 → 이체 후 <strong>[✓ 입금완료]</strong>) → 매시간 매입처 송장 감지 → <strong>매입처발송</strong> → 마켓 송장 등록 시 <strong>발송완료</strong>.
        <br />※ <strong>쿠팡</strong>: 송장은 쿠팡에 자동 등록(반자동 모드는 매입처 추적 칸의 [확인·등록]). <strong>네이버</strong>: 매입 상태를 발주완료로 바꾸면 발주확인 자동 호출, 발송처리는 집 PC 큐가 수행. <strong>토스</strong>: 발주확인·송장 등록 모두 크론 자동, 발송기한 ⚠는 페널티라 우선 처리.
        <br />※ 실수익 = 결제금액 − 매입원가 − 수수료 − 납부부가세(<strong>(결제금액−매입원가)÷11</strong>, 매입세액 공제 반영). 수수료는 쿠팡 매입처별 요율(기본 {(FEE_RATE * 100).toFixed(1)}%·화장품 {(FEE_RATE_BY_SOURCE.cmtstory * 100).toFixed(1)}%), 네이버 주문 API 실값, 토스 {(TOSS_FEE_RATE * 100).toFixed(0)}% 추정.
        <br />※ <strong>⚠ 처리 대기</strong> 배너는 기간 필터와 무관하게 전체 기간의 미발주·입금대기·확인필요를 셉니다 — 다른 마켓 주문을 놓치지 않기 위한 장치.
        <br />※ <strong>쿠팡 반품·취소 요청</strong>(🛑 출고중지요청·↩ 반품접수 등)은 주문 수집 때 같이 읽어 마켓 상태 칸에 배지로 붙입니다(배지에 마우스를 올리면 사유·접수일). 새 접수는 확인필요로 올라오고, 반품·취소가 완료된 라인은 매출 집계에서 빠집니다. 출고중지·반품 승인 처리는 Wing에서.
      </div>
    </div>
  )
}

function ClaimPanel({ stop, returning, items }: { stop: number; returning: number; items: OpenClaim[] }) {
  const urgent = stop > 0
  return (
    <section className={`rounded-lg border-2 px-4 py-3 ${urgent ? 'border-rose-500 bg-rose-50' : 'border-rose-200 bg-rose-50/60'}`}>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 mb-2">
        <h2 className="font-bold text-rose-800">
          {stop > 0 && <span>🛑 쿠팡 출고중지요청 {stop}건</span>}
          {stop > 0 && returning > 0 && <span className="mx-1.5 text-rose-300">·</span>}
          {returning > 0 && <span>↩ 반품 진행 {returning}건</span>}
        </h2>
        <span className="text-xs text-rose-600">처리는 Wing에서 · 출고중지요청 주문은 결제진행이 막혀 있습니다</span>
        <Link href={OPEN_CLAIMS_HREF} className="ml-auto text-xs font-semibold text-rose-700 underline hover:text-rose-900">아래 목록에서 보기 →</Link>
      </div>
      <ul className="divide-y divide-rose-100">
        {items.map((c) => (
          <li key={c.receiptId} className="py-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm">
            <span className={`text-[11px] px-1.5 py-0.5 rounded ${c.cls}`}>{c.label}</span>
            <span className="font-semibold text-gray-900 break-all">{c.productName ?? `주문#${c.orderId}`}</span>
            {c.optionName && c.optionName !== c.productName && <span className="text-xs text-gray-500 break-all">{c.optionName}</span>}
            <span className="text-xs text-gray-500">
              · {c.reason} · 접수 {fmtKst(c.requestedAt)} · 매입 {isPurchaseStatus(c.purchaseStatus) ? PURCHASE_STATUS_LABELS[c.purchaseStatus].label : '—'}
            </span>
            <span className={`text-xs font-semibold basis-full ${c.stop ? 'text-rose-700' : 'text-rose-600'}`}>→ {c.todo}</span>
          </li>
        ))}
      </ul>
    </section>
  )
}

/** 현재 페이지 주변 최대 9개 페이지 번호 — 10페이지 넘어도 이전/다음과 함께 모두 도달 가능 */
function pageWindow(page: number, totalPages: number, span = 4): number[] {
  const start = Math.max(1, Math.min(page - span, totalPages - span * 2))
  const end = Math.min(totalPages, start + span * 2)
  return Array.from({ length: end - start + 1 }, (_, i) => start + i)
}

function Kpi({ label, value, sub, highlight = false, positive = true }: { label: string; value: string; sub?: string; highlight?: boolean; positive?: boolean }) {
  return (
    <div className={`rounded border p-3 ${highlight ? (positive ? 'border-emerald-300 bg-emerald-50' : 'border-rose-300 bg-rose-50') : 'border-gray-200 bg-white'}`}>
      <div className="text-xs text-gray-500">{label}</div>
      <div className={`text-lg font-bold mt-1 tabular-nums ${highlight ? (positive ? 'text-emerald-700' : 'text-rose-600') : 'text-gray-900'}`}>{value}</div>
      {sub && <div className="text-[10px] text-gray-400 mt-0.5 tabular-nums">{sub}</div>}
    </div>
  )
}

/** 기간 건수 카드 — 주문·출고중지·반품·취소·문의. 미처리가 있으면 빨갛게(출고중지·반품은 진행 중 목록으로 링크) */
function ActivityCards({ a, keptOrders }: { a: PeriodActivity; keptOrders: number }) {
  const coupangNote = a.coupang === 'error' ? '⚠ 쿠팡 접수·문의 조회 실패' : null
  const coupangOnly = (t: Tally, openLabel: string, basis: string, href?: string) =>
    a.coupang === 'na' ? <CountCard label={basis} value="—" sub="쿠팡만 해당" muted />
      : a.coupang === 'error' ? <CountCard label={basis} value="?" sub="조회 실패" alert />
      : <CountCard label={basis} value={`${t.total.toLocaleString()}건`} sub={t.open > 0 ? `${openLabel} ${t.open}` : `${openLabel} 없음`} alert={t.open > 0} href={t.open > 0 ? href : undefined} />
  return (
    <div className="space-y-1">
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <CountCard label="주문" value={`${a.orders.toLocaleString()}건`} sub={`매출 집계 ${keptOrders.toLocaleString()} · 취소·반품 ${(a.orders - keptOrders).toLocaleString()}`} />
        {coupangOnly(a.stop, '미처리', '출고중지 (쿠팡)', OPEN_CLAIMS_HREF)}
        <CountCard label="반품" value={`${a.returns.total.toLocaleString()}건`} sub={a.returns.open > 0 ? `진행 중 ${a.returns.open}` : (coupangNote ?? '진행 중 없음')} alert={a.returns.open > 0 || !!coupangNote} href={a.returns.open > 0 ? OPEN_CLAIMS_HREF : undefined} />
        <CountCard label="취소" value={`${a.cancels.total.toLocaleString()}건`} sub={a.cancels.open > 0 ? `요청 중 ${a.cancels.open}` : (coupangNote ?? '출고 전 고객 취소')} alert={a.cancels.open > 0 || !!coupangNote} />
        {coupangOnly(a.inquiries, '미답변', '고객문의 (쿠팡)')}
      </div>
      <p className="text-[10px] text-gray-400">
        주문은 주문일 기준 · 쿠팡 출고중지·반품·취소는 접수일, 문의는 문의일 기준(네이버·토스 반품·취소는 주문 상태로 셈) · 출고중지 = 발주확인 뒤 고객 취소 · 문의 답변은 Wing에서
      </p>
    </div>
  )
}

function CountCard({ label, value, sub, alert = false, muted = false, href }: { label: string; value: string; sub?: string; alert?: boolean; muted?: boolean; href?: string }) {
  const body = (
    <div className={`h-full rounded border p-3 ${alert ? 'border-rose-300 bg-rose-50' : 'border-gray-200 bg-white'} ${href ? 'hover:border-rose-400' : ''}`}>
      <div className="text-xs text-gray-500">{label}</div>
      <div className={`text-lg font-bold mt-1 tabular-nums ${muted ? 'text-gray-300' : alert ? 'text-rose-700' : 'text-gray-900'}`}>{value}</div>
      {sub && <div className={`text-[10px] mt-0.5 tabular-nums ${alert ? 'text-rose-600 font-semibold' : 'text-gray-400'}`}>{sub}{href ? ' →' : ''}</div>}
    </div>
  )
  return href ? <Link href={href} className="block">{body}</Link> : body
}

function BreakdownRow({ market, agg, href }: { market: Market; agg: Agg; href: string }) {
  const meta = MARKET_META[market]
  const empty = agg.count === 0
  return (
    <tr className={`border-t ${empty ? 'text-gray-300' : 'text-gray-700'}`}>
      <td className="px-3 py-1.5">
        <Link href={href} className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded font-semibold ${empty ? 'bg-gray-100 text-gray-400' : meta.badgeCls} hover:opacity-80`}>
          {meta.icon} {meta.label}
        </Link>
      </td>
      <td className="px-3 py-1.5 text-right">{agg.count.toLocaleString()}{agg.costMissing > 0 && <span className="text-amber-600" title="매입원가 미입력"> (미입력 {agg.costMissing})</span>}</td>
      <td className="px-3 py-1.5 text-right">{agg.revenue.toLocaleString()}</td>
      <td className="px-3 py-1.5 text-right">{agg.cost.toLocaleString()}</td>
      <td className="px-3 py-1.5 text-right">{agg.fee.toLocaleString()}</td>
      <td className="px-3 py-1.5 text-right">{agg.vat.toLocaleString()}</td>
      <td className={`px-3 py-1.5 text-right font-semibold ${empty ? '' : agg.net >= 0 ? 'text-emerald-700' : 'text-rose-600'}`}>{agg.net.toLocaleString()}</td>
      <td className="px-3 py-1.5 text-right">{empty ? '—' : `${agg.netPct.toFixed(1)}%`}</td>
    </tr>
  )
}
