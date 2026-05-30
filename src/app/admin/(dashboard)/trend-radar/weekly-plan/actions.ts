'use server'

import { revalidatePath } from 'next/cache'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import type { PlanItem } from './planner'

// jimscanner_trends_weekly_plan 은 generated Database 타입에 아직 없어서
// `as any` 로 우회 (rpc_type_workaround / improvement-ideas 패턴 동일).
// types/supabase.ts 재생성 시 제거 가능.
function sbLoose() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return createAdminClient() as any
}

const PATH = '/admin/trend-radar/weekly-plan'

/**
 * 계산된 주간 배치를 확정·저장. 이미 done 처리된 항목의 상태는 보존,
 * 더 이상 추천되지 않는(미완료) 이전 선정은 정리한다.
 */
export async function confirmWeeklyPlan(weekStart: string, items: PlanItem[]) {
  const sb = sbLoose()

  // 기존 주차 선정 로드 (done 상태 보존용).
  const { data: existing, error: loadErr } = await sb
    .from('jimscanner_trends_weekly_plan')
    .select('goods_no, status, done_at')
    .eq('week_start', weekStart)
  if (loadErr) return { ok: false as const, error: loadErr.message as string }

  type ExistingRow = { goods_no: string; status: string; done_at: string | null }
  const doneMap = new Map<string, ExistingRow>(
    ((existing ?? []) as ExistingRow[])
      .filter((r) => r.status === 'done')
      .map((r) => [r.goods_no, r]),
  )

  const newGoods = new Set(items.map((i) => i.goods_no))

  // upsert 행 구성 — done 이던 항목은 done 유지.
  const rows = items.map((i) => {
    const prior = doneMap.get(i.goods_no)
    return {
      week_start: weekStart,
      goods_no: i.goods_no,
      title: i.title,
      cate_cd: i.cate_cd,
      cate_label: i.cate_label,
      price_krw: i.price_krw,
      is_imminent: i.is_imminent,
      final_score: i.final_score,
      expected_margin: i.expected_margin,
      plan_value: i.plan_value,
      group_type: i.group_type,
      seq: i.seq,
      reasons: i.reasons,
      status: prior ? 'done' : 'planned',
      done_at: prior?.done_at ?? null,
    }
  })

  const { error: upErr } = await sb
    .from('jimscanner_trends_weekly_plan')
    .upsert(rows, { onConflict: 'week_start,goods_no' })
  if (upErr) return { ok: false as const, error: upErr.message as string }

  // 이번 배치에서 빠졌고 아직 미완료인 이전 선정은 삭제 (재배치 정리).
  const stale = ((existing ?? []) as ExistingRow[])
    .filter((r) => r.status !== 'done' && !newGoods.has(r.goods_no))
    .map((r) => r.goods_no)
  if (stale.length > 0) {
    await sb
      .from('jimscanner_trends_weekly_plan')
      .delete()
      .eq('week_start', weekStart)
      .in('goods_no', stale)
  }

  revalidatePath(PATH)
  return { ok: true as const, saved: rows.length }
}

/** 항목 완료 토글. */
export async function toggleDone(weekStart: string, goodsNo: string, done: boolean) {
  const sb = sbLoose()
  const { error } = await sb
    .from('jimscanner_trends_weekly_plan')
    .update({ status: done ? 'done' : 'planned', done_at: done ? new Date().toISOString() : null })
    .eq('week_start', weekStart)
    .eq('goods_no', goodsNo)
  if (error) return { ok: false as const, error: error.message as string }
  revalidatePath(PATH)
  return { ok: true as const }
}
