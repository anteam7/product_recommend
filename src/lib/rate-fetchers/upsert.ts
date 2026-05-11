import type { SupabaseClient } from '@supabase/supabase-js'
import type { ParsedRate } from './types'

/**
 * 한 번 페치 결과로 shipping_rates 갱신.
 *
 * 정책: (forwarder_id, country) 단위 wipe-and-replace.
 *       페치 결과에 등장한 country 의 기존 행은 모두 삭제 후 새 행 일괄 insert.
 *       사이트 페이지를 단일 진실(single source of truth) 로 간주 — 페이지에 없는 옛 데이터는 폐기.
 *       페치 실패한 country 의 데이터는 건드리지 않음.
 */
export async function upsertParsedRates(
  admin: SupabaseClient,
  forwarderId: string,
  rates: ParsedRate[],
): Promise<{ inserted: number; deletedCountries: string[] }> {
  if (rates.length === 0) return { inserted: 0, deletedCountries: [] }

  const countries = [...new Set(rates.map((r) => r.country))]

  // 해당 country 들의 기존 행 일괄 삭제
  const { error: delErr } = await admin
    .from('shipping_rates')
    .delete()
    .eq('forwarder_id', forwarderId)
    .in('country', countries)
  if (delErr) throw new Error(`delete failed: ${delErr.message}`)

  const rows = rates.map((r) => ({
    forwarder_id: forwarderId,
    country: r.country,
    center_name: r.center_name,
    weight_min: r.weight_min,
    weight_max: r.weight_max,
    weight_unit: r.weight_unit,
    price_krw: r.price_krw,
    price_usd: r.price_usd,
    price_jpy: r.price_jpy,
    price_cny: r.price_cny,
    price_eur: r.price_eur,
    shipping_type: r.shipping_type,
    service_label: r.service_label,
    member_grade: r.member_grade,
    grade_level: r.grade_level,
    source: 'auto:fetcher',
    updated_at: new Date().toISOString(),
  }))

  const { error: insErr } = await admin.from('shipping_rates').insert(rows)
  if (insErr) throw new Error(`insert failed: ${insErr.message}`)

  return { inserted: rows.length, deletedCountries: countries }
}
