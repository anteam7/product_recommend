// 테스트 픽스처. now 기준 상대 시각으로 만든다.
export const NOW = new Date('2026-10-11T03:00:00.000Z') // KST 12:00

const minAgo = (m, base = NOW) => new Date(base.getTime() - m * 60_000).toISOString()

export function rawHealthy(now = NOW) {
  const run = (m, status = 'success') => ({ status, started_at: minAgo(m + 1, now), finished_at: minAgo(m, now), error_message: null })
  return {
    syncRuns: {
      coupang_orders: [run(10)], naver_orders: [run(12, 'ok')], toss_orders: [run(20)],
      coupang_ggsan: [run(30)], coupang_stock: [run(27)],
    },
    heartbeats: [
      { name: 'work-agent', last_seen_at: minAgo(1, now), status: 'ok', detail: null },
      { name: 'order-server', last_seen_at: minAgo(1, now), status: 'ok', detail: null },
      ...['ggsan', 'bio77', 'upickb2b', 'wellroot', 'kwholesale', 'cmtstory', 'campingmoon'].map((s) => ({
        name: `supplier:${s}`, last_seen_at: minAgo(40, now), status: 'ok', detail: null,
      })),
    ],
    cronRuns: [{ created_at: new Date(now.getTime() - 8 * 3600_000).toISOString(), status: 'completed' }], // KST 04:00
    escalated: [],
    settings: [{ key: 'orchestrator_enabled', value: true }, { key: 'notifications_enabled', value: true }],
  }
}
