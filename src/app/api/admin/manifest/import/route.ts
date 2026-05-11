// /api/admin/manifest/import — 매니페스트 엑셀 업로드 → 파싱 → PII drop → 적재
//
// A안: 사용자가 국가/모드/창고 명시. 한 파일 = 한 국가/모드/창고.
// 한 파일 ≤ 5MB / 5,000행 권장.
//
// 적재 후 자동으로 recompute_category_weights() 호출.

import { NextResponse, type NextRequest } from 'next/server'
import { createClient, isAdminEmail } from '@/lib/auth/server'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import {
  parseManifest,
  type Country,
  type Mode,
  type ParsedManifestRow,
} from '@/lib/recommend/manifest-import'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

const MAX_FILE_BYTES = 5 * 1024 * 1024 // 5MB
const SOFT_ROW_LIMIT = 5000
const HARD_ROW_LIMIT = 8000
const VALID_COUNTRIES = new Set<Country>(['US', 'JP', 'CN'])
const VALID_MODES = new Set<Mode>(['air', 'boat', 'mixed'])

async function requireAdmin() {
  const sb = await createClient()
  const {
    data: { user },
  } = await sb.auth.getUser()
  if (!user || !isAdminEmail(user.email)) return null
  return user
}

export async function POST(request: NextRequest) {
  const user = await requireAdmin()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let form: FormData
  try {
    form = await request.formData()
  } catch (e) {
    return NextResponse.json(
      { error: `multipart/form-data 파싱 실패: ${e instanceof Error ? e.message : String(e)}` },
      { status: 400 },
    )
  }

  const file = form.get('file')
  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'file 필드 필수' }, { status: 400 })
  }
  if (file.size === 0) {
    return NextResponse.json({ error: '빈 파일입니다.' }, { status: 400 })
  }
  if (file.size > MAX_FILE_BYTES) {
    return NextResponse.json(
      { error: `파일이 너무 큽니다 (${(file.size / 1024 / 1024).toFixed(1)}MB). 최대 5MB.` },
      { status: 413 },
    )
  }

  const country = String(form.get('country') ?? '').trim() as Country
  const mode = String(form.get('mode') ?? '').trim() as Mode
  const centerName = (String(form.get('center_name') ?? '').trim() || null)
  const forwarderSlug = (String(form.get('forwarder_slug') ?? '').trim() || null)

  if (!VALID_COUNTRIES.has(country)) {
    return NextResponse.json({ error: 'country 값이 잘못됨 (US/JP/CN)' }, { status: 400 })
  }
  if (!VALID_MODES.has(mode)) {
    return NextResponse.json({ error: 'mode 값이 잘못됨 (air/boat/mixed)' }, { status: 400 })
  }

  const buffer = Buffer.from(await file.arrayBuffer())
  let parsed: ReturnType<typeof parseManifest>
  try {
    parsed = parseManifest({
      buffer,
      fileName: file.name.slice(0, 100),
      country,
      mode,
      centerName,
      forwarderSlug,
    })
  } catch (e) {
    return NextResponse.json(
      { error: `엑셀 파싱 실패: ${e instanceof Error ? e.message : String(e)}` },
      { status: 400 },
    )
  }

  if (parsed.warnings.includes('파싱 중단')) {
    return NextResponse.json(
      { error: '엑셀 형식 오류', details: parsed.warnings },
      { status: 400 },
    )
  }

  if (parsed.rows.length > HARD_ROW_LIMIT) {
    return NextResponse.json(
      {
        error: `행 수가 너무 많습니다 (${parsed.rows.length}). 최대 ${HARD_ROW_LIMIT}행. 파일을 분할해 주세요.`,
      },
      { status: 413 },
    )
  }

  const warnings = [...parsed.warnings]
  if (parsed.rows.length > SOFT_ROW_LIMIT) {
    warnings.push(
      `행 수 ${parsed.rows.length}건 — 권장 ${SOFT_ROW_LIMIT}건 초과. 다음번에는 분할 업로드를 권장합니다.`,
    )
  }

  // ── DB 적재 (배치 INSERT) ──
  const admin = createAdminClient()
  const { count: beforeCount } = await admin
    .from('jimscanner_manifest_items')
    .select('*', { count: 'exact', head: true })

  const inserted = await batchInsert(admin, parsed.rows)
  if (typeof inserted === 'string') {
    return NextResponse.json({ error: `적재 실패: ${inserted}` }, { status: 500 })
  }

  const { count: afterCount } = await admin
    .from('jimscanner_manifest_items')
    .select('*', { count: 'exact', head: true })

  const newRows = (afterCount ?? 0) - (beforeCount ?? 0)
  const dedupRows = parsed.rows.length - newRows

  // ── 집계 재계산 ──
  let recomputeCount: number | null = null
  let recomputeError: string | null = null
  try {
    const { data: rc } = await admin.rpc('recompute_category_weights')
    if (typeof rc === 'number') recomputeCount = rc
  } catch (e) {
    recomputeError = e instanceof Error ? e.message : String(e)
  }

  return NextResponse.json({
    ok: true,
    file: file.name,
    country,
    mode,
    center_name: centerName,
    source_forwarder_slug: forwarderSlug,
    summary: {
      total_input_rows: parsed.total_input_rows,
      invoices: parsed.invoices,
      parsed_rows: parsed.rows.length,
      skipped_meaningless: parsed.skipped_meaningless,
      outliers: parsed.outliers,
      new_rows: newRows,
      dedup_rows: dedupRows,
      total_after: afterCount ?? 0,
      category_weights_after: recomputeCount,
    },
    warnings,
    recompute_error: recomputeError,
  })
}

type AdminClient = ReturnType<typeof createAdminClient>

async function batchInsert(admin: AdminClient, rows: ParsedManifestRow[]): Promise<true | string> {
  const CHUNK = 500
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK)
    const { error } = await admin
      .from('jimscanner_manifest_items')
      .upsert(chunk, {
        onConflict: 'source_file,invoice_id_hash,product_name_en,pcs',
        ignoreDuplicates: true,
      })
    if (error) return error.message
  }
  return true
}
