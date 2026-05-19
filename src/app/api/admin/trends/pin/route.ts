import { NextResponse, type NextRequest } from 'next/server'
import { createClient as createSupabaseClient } from '@supabase/supabase-js'
import { createClient, isAdminEmail } from '@/lib/auth/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** body { keyword, source, pinned: boolean, notes? } */
export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isAdminEmail(user.email)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const body = (await request.json().catch(() => ({}))) as {
    keyword?: string
    source?: string
    pinned?: boolean
    notes?: string
  }
  if (!body.keyword || !body.source) {
    return NextResponse.json({ error: 'keyword, source required' }, { status: 400 })
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) return NextResponse.json({ error: 'env missing' }, { status: 500 })
  const admin = createSupabaseClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } })

  if (body.pinned === false) {
    const { error } = await admin
      .from('jimscanner_trends_pins')
      .delete()
      .eq('keyword', body.keyword)
      .eq('source', body.source)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ ok: true, pinned: false })
  }

  const { error } = await admin
    .from('jimscanner_trends_pins')
    .upsert(
      { keyword: body.keyword, source: body.source, notes: body.notes ?? null, pinned_at: new Date().toISOString() },
      { onConflict: 'keyword,source' },
    )
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // 컴플라이언스 인라인 스캔 — 핀 등록 시 한국 규제 사전으로 즉시 확인.
  // 신규 테이블이라 supabase 타입에 미반영 → as any.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const adminAny = admin as any
  const warnings: Array<{ domain: string; rule_name: string; matched: string; action: string; severity: string; disclaimer: string | null }> = []
  try {
    const { data: rules } = await adminAny
      .from('jimscanner_compliance_rules')
      .select('rule_id, domain, rule_name, banned_phrases, action, severity, required_disclaimer')
      .eq('is_active', true)
    const scanText = `${body.keyword} ${body.notes ?? ''}`.toLowerCase()
    const findingsToInsert: Array<Record<string, unknown>> = []
    for (const rule of (rules ?? []) as Array<{ rule_id: string; domain: string; rule_name: string; banned_phrases: string[] | null; action: string; severity: string; required_disclaimer: string | null }>) {
      for (const phrase of rule.banned_phrases ?? []) {
        if (!phrase) continue
        if (scanText.includes(phrase.toLowerCase())) {
          warnings.push({
            domain: rule.domain,
            rule_name: rule.rule_name,
            matched: phrase,
            action: rule.action,
            severity: rule.severity,
            disclaimer: rule.required_disclaimer,
          })
          findingsToInsert.push({
            target_kind: 'pin',
            target_id: `${body.source}::${body.keyword}`,
            target_label: body.keyword,
            rule_id: rule.rule_id,
            matched_text: phrase,
            severity: rule.severity,
            action: rule.action,
          })
        }
      }
    }
    if (findingsToInsert.length > 0) {
      await adminAny
        .from('jimscanner_compliance_findings')
        .upsert(findingsToInsert, {
          onConflict: 'target_kind,target_id,rule_id,matched_text',
          ignoreDuplicates: true,
        })
    }
  } catch {
    // 컴플라이언스 테이블이 아직 마이그레이션 전이면 무시 (핀 토글 자체는 성공).
  }

  return NextResponse.json({ ok: true, pinned: true, compliance_warnings: warnings })
}
