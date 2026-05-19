import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

interface ChannelMapRow {
  community_id: string
  tribe_label: string
  channel: string
  channel_label: string
  priority: number
  expected_ctr_low: number | null
  expected_ctr_high: number | null
  copy_tone: string | null
  note: string | null
}

interface KeywordShareRow {
  community_id: string
  keyword: string
  share_pct: number
  dominance_idx: number
  sample_count: number
}

interface RawRow {
  source: string
  title: string | null
  query: string | null
}

const COMMUNITY_META: Record<string, { tribe: string; persona: string; emoji: string }> = {
  '82cook':           { tribe: '주부 (Family-CPG)',           persona: '30~40대 여성 · 가족·살림·식품 의사결정자', emoji: '🍳' },
  ppomppu:            { tribe: '가성비러 (Deal-Hunter)',       persona: '전 연령 · 가격 민감 · 핫딜 사냥',         emoji: '🏷️' },
  dcinside:           { tribe: '오타쿠/남성 (Otaku-Male)',     persona: '20~30대 남성 · 서브컬쳐·과몰입',          emoji: '🎮' },
  natepan:            { tribe: '청년여성 (GenZ-Female)',       persona: '10~20대 여성 · 라이프스타일·후기',         emoji: '💄' },
  clien_park:         { tribe: 'IT 매니아 (Power-User)',       persona: '얼리어답터 · 스펙·벤치마크 중시',         emoji: '💻' },
  quasarzone_sale:    { tribe: '하드웨어 매니아 (Hardware-Geek)', persona: 'PC·하드웨어 매니아 · 튜닝·오버클럭',       emoji: '🖥️' },
}

const COMMUNITY_TO_RAW_SOURCE: Record<string, string[]> = {
  clien_park:      ['clien_park'],
  quasarzone_sale: ['quasarzone_sale'],
  // 82cook · ppomppu · dcinside · natepan 은 아직 raw 수집기가 없을 수 있음 — share 테이블 기준으로만 표시
  '82cook':   ['82cook'],
  ppomppu:    ['ppomppu'],
  dcinside:   ['dcinside'],
  natepan:    ['natepan'],
}

async function fetchData() {
  const sb = createAdminClient() as any
  const since30d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()

  const [mapRes, shareRes, rawRes] = await Promise.all([
    sb.from('jimscanner_tribe_channel_map').select('*').order('community_id').order('priority'),
    sb
      .from('jimscanner_tribe_keyword_share')
      .select('community_id, keyword, share_pct, dominance_idx, sample_count')
      .order('dominance_idx', { ascending: false })
      .limit(500),
    sb
      .from('jimscanner_market_raw')
      .select('source, title, query')
      .gte('captured_at', since30d)
      .limit(2000),
  ])

  const mapRows = ((mapRes.data ?? []) as ChannelMapRow[])
  const shareRows = ((shareRes.data ?? []) as KeywordShareRow[])
  const rawRows = ((rawRes.data ?? []) as RawRow[])

  // community_id 별 raw 카운트
  const rawCount = new Map<string, number>()
  for (const r of rawRows) {
    rawCount.set(r.source, (rawCount.get(r.source) ?? 0) + 1)
  }

  // community_id 별 channel map 그룹화
  const byCommunity = new Map<string, ChannelMapRow[]>()
  for (const m of mapRows) {
    if (!byCommunity.has(m.community_id)) byCommunity.set(m.community_id, [])
    byCommunity.get(m.community_id)!.push(m)
  }

  // community_id 별 top-keywords (share 테이블이 비어있어도 그래도 표시는 가능)
  const topKeywordsBy = new Map<string, KeywordShareRow[]>()
  for (const s of shareRows) {
    if (!topKeywordsBy.has(s.community_id)) topKeywordsBy.set(s.community_id, [])
    const arr = topKeywordsBy.get(s.community_id)!
    if (arr.length < 8) arr.push(s)
  }

  return { byCommunity, topKeywordsBy, rawCount }
}

export default async function TribeChannelPage() {
  const { byCommunity, topKeywordsBy, rawCount } = await fetchData()

  const communityIds = Object.keys(COMMUNITY_META)

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold">트라이브 → 광고 채널 매칭</h1>
          <p className="text-sm text-gray-500 mt-1">
            커뮤니티별 청중 핑거프린트 · 추천 광고 채널 · 예상 CTR 밴드 · 카피 톤
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      <section className="rounded border border-dashed border-gray-300 p-3 text-xs text-gray-600">
        <strong className="text-gray-800">방법:</strong> 커뮤니티별 키워드 점유율(<code>jimscanner_tribe_keyword_share</code>) 로
        '어떤 트라이브가 이 상품을 갈망하는가'를 추정하고, <code>jimscanner_tribe_channel_map</code> 의 휴리스틱 매핑으로
        Top 3 광고 채널·예상 CTR·카피 톤을 출력합니다. 초기 휴리스틱은 한국 마케팅 업계 통념 기반이며, ROAS 데이터가 누적되면 보정합니다.
      </section>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {communityIds.map((cid) => {
          const meta = COMMUNITY_META[cid]
          const channels = byCommunity.get(cid) ?? []
          const topKw = topKeywordsBy.get(cid) ?? []
          const rc = rawCount.get(cid) ?? 0
          return (
            <div key={cid} className="rounded-lg border border-gray-200 p-4 space-y-3">
              <div className="flex items-baseline justify-between">
                <div>
                  <div className="text-lg font-bold">
                    <span className="mr-1">{meta.emoji}</span>
                    {meta.tribe}
                  </div>
                  <div className="text-xs text-gray-500 font-mono">{cid}</div>
                  <div className="text-xs text-gray-600 mt-1">{meta.persona}</div>
                </div>
                <div className="text-right">
                  <div className="text-xs text-gray-400">raw 30d</div>
                  <div className={`text-sm font-mono ${rc > 0 ? 'text-gray-800' : 'text-gray-300'}`}>
                    {rc}건
                  </div>
                </div>
              </div>

              <div>
                <div className="text-xs text-gray-500 mb-1">추천 광고 채널 Top {Math.min(channels.length, 3)}</div>
                {channels.length === 0 ? (
                  <div className="text-xs text-gray-400 py-2">매핑 시드가 비어있음 (마이그레이션 미적용)</div>
                ) : (
                  <div className="space-y-1.5">
                    {channels.slice(0, 3).map((c) => (
                      <div key={c.channel} className="flex items-start gap-2 text-sm">
                        <div className="w-5 text-center text-xs text-gray-500 font-mono mt-0.5">
                          #{c.priority}
                        </div>
                        <div className="flex-1">
                          <div className="flex items-baseline justify-between gap-2">
                            <span className="font-medium">{c.channel_label}</span>
                            <span className="text-xs text-gray-500 font-mono">
                              {c.expected_ctr_low != null && c.expected_ctr_high != null
                                ? `CTR ${c.expected_ctr_low}~${c.expected_ctr_high}%`
                                : '—'}
                            </span>
                          </div>
                          {c.copy_tone && (
                            <div className="text-xs text-gray-600 mt-0.5">톤: {c.copy_tone}</div>
                          )}
                          {c.note && (
                            <div className="text-[11px] text-gray-400">{c.note}</div>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {topKw.length > 0 && (
                <div>
                  <div className="text-xs text-gray-500 mb-1">우세 키워드 (dominance idx)</div>
                  <div className="flex flex-wrap gap-1">
                    {topKw.map((k) => (
                      <span
                        key={k.keyword}
                        className="text-xs px-1.5 py-0.5 rounded bg-gray-100 text-gray-700 font-mono"
                        title={`share ${k.share_pct}% · dominance ${k.dominance_idx} · n=${k.sample_count}`}
                      >
                        {k.keyword}
                        <span className="text-gray-400 ml-1">×{k.dominance_idx.toFixed(1)}</span>
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )
        })}
      </div>

      <section className="rounded border border-gray-200 p-3 text-xs text-gray-500">
        <strong className="text-gray-700">다음 단계:</strong>
        <ol className="list-decimal ml-5 mt-1 space-y-0.5">
          <li>82cook · ppomppu · dcinside · natepan raw 수집기 추가 (지금은 clien_park · quasarzone_sale 만 적재됨)</li>
          <li>cron <code>compute_tribe_keyword_share</code> — 30d 윈도우로 community×keyword 점유율·dominance 산출 후 <code>jimscanner_tribe_keyword_share</code> 적재</li>
          <li>핀 상세 페이지에서 핀의 alias 와 share 테이블 join 으로 트라이브 우세도 → 채널 Top 3 출력 (이미 일부 구현)</li>
          <li>ROAS 실측 누적 시 <code>expected_ctr_low/high</code> 보정</li>
        </ol>
      </section>
    </div>
  )
}
