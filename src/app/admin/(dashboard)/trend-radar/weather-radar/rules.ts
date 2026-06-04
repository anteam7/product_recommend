// 예보 임계 돌파 → 선행 수요 토픽 매핑 엔진.
//
// news-demand/rules.ts 는 '뉴스 보도' 발생 후 반응형이다. 코드 주석 스스로
// '위탁 선점 골든타임은 검색 급증 직전'이라 적어 타이밍 갭을 인정한다.
// 예보는 7~10일 선행하는 유일한 구조적·수치 신호원이므로, 여기서는 '뉴스'가 아니라
// '예보 임계 돌파'를 트리거로 삼아 항상 demand_phase='lead' 로 두고 D-카운트다운을 계산한다.
//
// 수요 카테고리/ggsan 매핑은 news-demand 의 NEWS_TOPICS 를 재사용한다(단일 진실원).

import { NEWS_TOPICS, type NewsTopic } from '../news-demand/rules'

export type WeatherMetric = 'tmax' | 'tmin' | 'pm10' | 'pm25' | 'rain_prob'

// 예보 적재 1행 (jimscanner_weather_forecast 의 코드측 표현)
export interface ForecastRow {
  base_date: string
  forecast_date: string
  region: string
  metric: WeatherMetric
  value: number | null
  anomaly?: number | null
}

// 임계 돌파 규칙: 어떤 지표가 어느 방향으로 임계를 넘으면 어떤 news-demand 토픽을 발화시키는지.
export interface ThresholdRule {
  metric: WeatherMetric
  // value 가 threshold 를 이 방향으로 넘으면 돌파
  direction: 'gte' | 'lte'
  threshold: number
  topicKey: string             // NEWS_TOPICS 의 key (heat_wave | cold_wave | fine_dust)
  breachLabel: string          // 화면 표기 ('폭염특보(33℃↑)' 등)
}

// 기상청/에어코리아 통보문 기준선:
//  - 폭염특보: 일최고 33℃ 이상 / 한파특보: 일최저 -12℃ 이하
//  - 미세먼지 '나쁨': PM10 81㎍/㎥↑, PM2.5 36㎍/㎥↑
export const THRESHOLD_RULES: ThresholdRule[] = [
  { metric: 'tmax', direction: 'gte', threshold: 33, topicKey: 'heat_wave', breachLabel: '폭염(일최고 33℃↑)' },
  { metric: 'tmax', direction: 'gte', threshold: 35, topicKey: 'heat_wave', breachLabel: '폭염경보급(35℃↑)' },
  { metric: 'tmin', direction: 'lte', threshold: -12, topicKey: 'cold_wave', breachLabel: '한파(일최저 -12℃↓)' },
  { metric: 'tmin', direction: 'lte', threshold: -15, topicKey: 'cold_wave', breachLabel: '강한 한파(-15℃↓)' },
  { metric: 'pm10', direction: 'gte', threshold: 81, topicKey: 'fine_dust', breachLabel: '미세먼지 나쁨(PM10 81↑)' },
  { metric: 'pm10', direction: 'gte', threshold: 151, topicKey: 'fine_dust', breachLabel: '미세먼지 매우나쁨(PM10 151↑)' },
  { metric: 'pm25', direction: 'gte', threshold: 36, topicKey: 'fine_dust', breachLabel: '초미세먼지 나쁨(PM2.5 36↑)' },
]

const TOPIC_BY_KEY: Record<string, NewsTopic> = Object.fromEntries(
  NEWS_TOPICS.map((t) => [t.key, t]),
)

export interface BreachEvent {
  topic: NewsTopic
  metric: WeatherMetric
  forecastDate: string         // YYYY-MM-DD
  region: string
  value: number
  breachLabel: string
  dday: number                 // 오늘 기준 며칠 후 (0=오늘, 양수=미래 선행)
  // 예보 기반은 항상 선행 신호 — 검색·뉴스가 아직 잠잠한 선점 골든타임
  demandPhase: 'lead'
}

function breaches(rule: ThresholdRule, value: number): boolean {
  return rule.direction === 'gte' ? value >= rule.threshold : value <= rule.threshold
}

function ddayFromToday(forecastDate: string, today: Date): number {
  const f = new Date(`${forecastDate}T00:00:00+09:00`)
  const t = new Date(`${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(
    today.getDate(),
  ).padStart(2, '0')}T00:00:00+09:00`)
  return Math.round((f.getTime() - t.getTime()) / 86_400_000)
}

/**
 * 적재된 예보 행들을 임계 돌파 이벤트로 번역한다.
 * 동일 (topic, forecastDate, region) 은 가장 강한 돌파(breachLabel)만 남긴다.
 * 과거(D<0) 예보는 버린다.
 */
export function detectBreaches(rows: ForecastRow[], now: Date = new Date()): BreachEvent[] {
  const byKey = new Map<string, BreachEvent>()

  for (const row of rows) {
    if (row.value == null) continue
    const dday = ddayFromToday(row.forecast_date, now)
    if (dday < 0) continue

    for (const rule of THRESHOLD_RULES) {
      if (rule.metric !== row.metric) continue
      if (!breaches(rule, row.value)) continue
      const topic = TOPIC_BY_KEY[rule.topicKey]
      if (!topic) continue

      const key = `${topic.key}:${row.forecast_date}:${row.region}`
      const event: BreachEvent = {
        topic,
        metric: row.metric,
        forecastDate: row.forecast_date,
        region: row.region,
        value: row.value,
        breachLabel: rule.breachLabel,
        dday,
        demandPhase: 'lead',
      }
      const prev = byKey.get(key)
      // 더 극단적인 돌파(임계 큰 쪽) 우선 — threshold 절댓값으로 비교
      if (!prev || Math.abs(rule.threshold) > extremeOf(prev)) {
        byKey.set(key, event)
        breachThreshold.set(event, Math.abs(rule.threshold))
      }
    }
  }

  return [...byKey.values()].sort((a, b) => a.dday - b.dday)
}

// BreachEvent → 채택된 threshold 절댓값 (더 극단적 돌파 우선 비교용)
const breachThreshold = new WeakMap<BreachEvent, number>()
function extremeOf(e: BreachEvent): number {
  return breachThreshold.get(e) ?? 0
}
