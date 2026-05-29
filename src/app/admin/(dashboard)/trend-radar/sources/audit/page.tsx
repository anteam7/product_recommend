import Link from 'next/link'
import { runSeedCoverageAudit } from '@/lib/trends/seed-coverage'
import { ProposeButton, RetireButton } from './ActionButtons'

export const dynamic = 'force-dynamic'

function pct(x: number): string {
  return `${Math.round(x * 100)}%`
}

function coverageColor(rate: number): string {
  if (rate >= 0.7) return 'text-green-600'
  if (rate >= 0.4) return 'text-yellow-600'
  return 'text-red-600'
}

export default async function SeedCoverageAuditPage() {
  const audit = await runSeedCoverageAudit(30)

  return (
    <div className="space-y-8 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold">시드 커버리지 갭 감사</h1>
          <p className="mt-1 text-sm text-gray-500">
            수집 입력단(활성 시드 {audit.activeSeedCount}개)이 실제 발굴 수요를 얼마나 커버하는지
            역추적 · 최근 {audit.windowDays}일 · 토큰 교집합 매칭(보수적)
          </p>
        </div>
        <Link href="/admin/trend-radar/sources" className="text-sm text-gray-700 underline hover:text-black">
          ← 소스 헬스
        </Link>
      </header>

      {/* ① 커버리지 요약 */}
      <section className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Stat label="발굴 상품 커버리지" value={pct(audit.productCoverageRate)}
          sub={`${audit.coveredProducts}/${audit.totalProducts}`} color={coverageColor(audit.productCoverageRate)} />
        <Stat label="시그널 커버리지" value={pct(audit.signalCoverageRate)}
          sub={`${audit.coveredSignals}/${audit.totalSignals}`} color={coverageColor(audit.signalCoverageRate)} />
        <Stat label="블라인드스팟 클러스터" value={String(audit.blindspots.length)}
          sub="대응 시드 0" color={audit.blindspots.length ? 'text-red-600' : 'text-green-600'} />
        <Stat label="Dead 시드" value={String(audit.deadSeeds.length)}
          sub="저수율(예산 낭비)" color={audit.deadSeeds.length ? 'text-yellow-600' : 'text-green-600'} />
      </section>

      {/* ② 블라인드스팟 → 신규 시드 추천 (기대 발굴수율 순) */}
      <section>
        <h2 className="mb-2 text-sm font-semibold text-gray-700">
          ② 블라인드스팟 — 시그널은 상승 중인데 대응 시드가 없는 클러스터 (빈도순 = 기대 발굴수율)
        </h2>
        {audit.blindspots.length === 0 ? (
          <p className="rounded border border-dashed border-gray-300 p-4 text-sm text-gray-400">
            블라인드스팟 없음 — 모든 시그널이 활성 시드에 매칭됨.
          </p>
        ) : (
          <div className="overflow-x-auto rounded border border-gray-200">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-xs text-gray-500">
                <tr>
                  <th className="px-3 py-2 text-left">카테고리</th>
                  <th className="px-3 py-2 text-left">키워드 클러스터</th>
                  <th className="px-3 py-2 text-right">빈도</th>
                  <th className="px-3 py-2 text-right">시그널 수</th>
                  <th className="px-3 py-2 text-left">추천</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {audit.blindspots.slice(0, 30).map((b, i) => (
                  <tr key={i}>
                    <td className="px-3 py-2 font-medium">{b.category ?? '—'}</td>
                    <td className="px-3 py-2 text-xs text-gray-600">
                      {b.keywords.length ? b.keywords.join(', ') : (b.sampleDescription ?? '—')}
                    </td>
                    <td className="px-3 py-2 text-right font-mono">{b.frequency}</td>
                    <td className="px-3 py-2 text-right text-gray-500">{b.signalCount}</td>
                    <td className="px-3 py-2">
                      <ProposeButton
                        label={b.category ?? b.keywords[0] ?? 'blindspot'}
                        keywords={b.keywords.length ? b.keywords : b.category ? [b.category] : []}
                        category={b.category}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ③ 폐기 후보 (dead seed) */}
      <section>
        <h2 className="mb-2 text-sm font-semibold text-gray-700">
          ③ 폐기 후보 — 귀속 발굴이 거의 없는 저수율 시드 (수집예산 낭비)
        </h2>
        {audit.deadSeeds.length === 0 ? (
          <p className="rounded border border-dashed border-gray-300 p-4 text-sm text-gray-400">
            dead 시드 없음 — 모든 활성 시드가 발굴에 기여 중.
          </p>
        ) : (
          <div className="overflow-x-auto rounded border border-gray-200">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-xs text-gray-500">
                <tr>
                  <th className="px-3 py-2 text-left">시드</th>
                  <th className="px-3 py-2 text-left">source / kind</th>
                  <th className="px-3 py-2 text-right">귀속 상품</th>
                  <th className="px-3 py-2 text-right">귀속 시그널</th>
                  <th className="px-3 py-2 text-left">조치</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {audit.deadSeeds.map((c) => (
                  <tr key={c.seed.id}>
                    <td className="px-3 py-2 font-medium">{c.seed.label}</td>
                    <td className="px-3 py-2 font-mono text-xs text-gray-500">
                      {c.seed.source} / {c.seed.kind}
                    </td>
                    <td className="px-3 py-2 text-right">{c.matchedProducts}</td>
                    <td className="px-3 py-2 text-right text-gray-500">{c.matchedSignals}</td>
                    <td className="px-3 py-2">
                      <RetireButton id={c.seed.id} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* 전체 시드 귀속 랭킹 */}
      <section>
        <h2 className="mb-2 text-sm font-semibold text-gray-700">활성 시드별 귀속 수율 (전체)</h2>
        <div className="overflow-x-auto rounded border border-gray-200">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-xs text-gray-500">
              <tr>
                <th className="px-3 py-2 text-left">시드</th>
                <th className="px-3 py-2 text-right">귀속 상품</th>
                <th className="px-3 py-2 text-right">귀속 시그널</th>
                <th className="px-3 py-2 text-right">final_score 합</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {audit.seedCoverages.map((c) => (
                <tr key={c.seed.id} className={c.dead ? 'bg-red-50/40' : ''}>
                  <td className="px-3 py-2">{c.seed.label}</td>
                  <td className="px-3 py-2 text-right">{c.matchedProducts}</td>
                  <td className="px-3 py-2 text-right text-gray-500">{c.matchedSignals}</td>
                  <td className="px-3 py-2 text-right font-mono">{Math.round(c.attributedScore)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <p className="text-xs text-gray-400">
        분석 시각 {audit.generatedAt.slice(0, 19).replace('T', ' ')} · &lsquo;+ 시드 제안&rsquo;은
        jimscanner_trends_seeds 에 is_active=false draft 로 insert (운영자 승인 후 수집 시작) ·
        매칭은 토큰 교집합 기반이라 카테고리 표기 차이를 보수적으로 반영(과소 커버리지로 표기될 수 있음).
      </p>
    </div>
  )
}

function Stat({ label, value, sub, color }: { label: string; value: string; sub: string; color: string }) {
  return (
    <div className="rounded border border-gray-200 p-4">
      <div className="text-xs text-gray-500">{label}</div>
      <div className={`mt-1 text-2xl font-bold ${color}`}>{value}</div>
      <div className="text-xs text-gray-400">{sub}</div>
    </div>
  )
}
