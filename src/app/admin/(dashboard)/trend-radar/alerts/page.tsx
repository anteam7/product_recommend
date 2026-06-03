import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import AlertsManager, { type AlertFeedRow, type AlertRuleRow } from './AlertsManager'

export const dynamic = 'force-dynamic'

async function fetchData() {
  const sb = createAdminClient()

  const [rulesRes, alertsRes] = await Promise.all([
    (sb as any)
      .from('jimscanner_trends_alert_rules')
      .select(
        'id, name, description, condition, category_top, channel, enabled, fired_count, hit_count, created_at',
      )
      .order('created_at', { ascending: false }),
    (sb as any)
      .from('jimscanner_trends_alerts')
      .select(
        'id, rule_id, product_id, product_name, category_top, trigger_value, message, channel, delivered, feedback, fired_at',
      )
      .order('fired_at', { ascending: false })
      .limit(120),
  ])

  return {
    rules: (rulesRes.data ?? []) as AlertRuleRow[],
    alerts: (alertsRes.data ?? []) as AlertFeedRow[],
    loadError: rulesRes.error?.message ?? alertsRes.error?.message ?? null,
  }
}

export default async function AlertsPage() {
  const { rules, alerts, loadError } = await fetchData()

  // 직전 24h 발화 수 (heartbeat 배너 패턴 재사용 — 능동 감지 살아있는지)
  const since24h = Date.now() - 24 * 60 * 60 * 1000
  const fired24h = alerts.filter((a) => new Date(a.fired_at).getTime() >= since24h).length

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold">🔔 발굴 알림 룰</h1>
          <p className="text-sm text-gray-500 mt-1">
            능동 감지 — 임계 돌파·브레이크아웃·신규 공급원을 cron 이 자동 발화. 60개 보드를 다 안 열어도 됨.
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      {loadError && (
        <div className="rounded border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-700">
          테이블 로드 실패 — 마이그레이션(<code>supabase/trends_v5_alert_rules.sql</code>) 미적용일 수 있음:{' '}
          {loadError}
        </div>
      )}

      {!loadError && fired24h === 0 && rules.some((r) => r.enabled) && (
        <div className="rounded border border-yellow-300 bg-yellow-50 px-4 py-3 text-sm text-yellow-800">
          ⚠ 최근 24h 발화 0건 — evaluate-alerts cron 이 score 재계산 직후 도는지 확인하세요.
        </div>
      )}

      <AlertsManager initialRules={rules} initialAlerts={alerts} />
    </div>
  )
}
