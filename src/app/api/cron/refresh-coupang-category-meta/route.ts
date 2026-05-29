/**
 * 쿠팡 카테고리 메타 캐시 갱신 (cron) — coupang-category-meta.mjs 의 cron 화.
 *
 * 파일럿이 쓰는 displayCategoryCode 들의 필수속성·고시정보·인증요구 정보를
 * 조회해 jimscanner_trends_category_meta 에 upsert. 등록 준비도(readiness)
 * 산출의 입력 캐시가 된다.
 *
 * 인증: CRON_SECRET (Authorization: Bearer ...)
 */
import { NextRequest, NextResponse } from 'next/server'
import crypto from 'node:crypto'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

const COUPANG_HOST = 'https://api-gateway.coupang.com'

// coupang-category-meta.mjs 와 동일한 파일럿 카테고리 셋
const CODES: Array<{ id: number; name: string }> = [
  { id: 73137, name: '기타영양제' },
  { id: 73154, name: '기타다이어트식품' },
  { id: 58991, name: '유산균' },
  { id: 58912, name: '비타민K' },
  { id: 58890, name: '홍삼진액/파우치' },
  { id: 58960, name: '배즙/도라지즙' },
  { id: 58924, name: '쏘팔메토' },
  { id: 58926, name: '밀크시슬' },
  { id: 58913, name: '멀티비타민' },
  { id: 58956, name: '마늘즙' },
  { id: 58927, name: '글루코사민' },
  { id: 58909, name: '비타민C' },
  { id: 59163, name: '콜라겐/히알루론산' },
  { id: 102515, name: '초유' },
  { id: 56172, name: '앰플' },
]

function signCoupang(method: string, urlPath: string) {
  const dt = new Date().toISOString().substring(2, 19).replace(/[-:]/g, '') + 'Z'
  const secret = process.env.COUPANG_SECRET_KEY!
  const signature = crypto.createHmac('sha256', secret).update(dt + method + urlPath).digest('hex')
  return { datetime: dt, signature }
}

async function coupangApi(method: string, urlPath: string) {
  const { datetime, signature } = signCoupang(method, urlPath)
  const access = process.env.COUPANG_ACCESS_KEY!
  const res = await fetch(`${COUPANG_HOST}${urlPath}`, {
    method,
    headers: {
      Authorization: `CEA algorithm=HmacSHA256, access-key=${access}, signed-date=${datetime}, signature=${signature}`,
      'Content-Type': 'application/json;charset=UTF-8',
    },
  })
  const text = await res.text()
  try { return { status: res.status, body: JSON.parse(text) } } catch { return { status: res.status, body: text as unknown } }
}

interface NoticeDetail { name: string; required?: string }
interface NoticeCategory { noticeCategoryName?: string; noticeCategoryDetailNames?: NoticeDetail[] }
interface Attr { required?: string }
interface Cert { name: string; required?: string }

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get('authorization')
  const cronSecret = process.env.CRON_SECRET
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  if (!process.env.COUPANG_ACCESS_KEY || !process.env.COUPANG_SECRET_KEY) {
    return NextResponse.json({ error: 'coupang keys missing' }, { status: 500 })
  }

  // 신규 테이블 — generated types 부재로 any 캐스팅 (service-role)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sb = createAdminClient() as any

  let upserted = 0
  const errors: string[] = []

  for (const c of CODES) {
    try {
      const r = await coupangApi(
        'GET',
        `/v2/providers/seller_api/apis/api/v1/marketplace/meta/category-related-metas/display-category-codes/${c.id}`,
      )
      if (r.status !== 200) {
        errors.push(`[${c.id}] HTTP ${r.status}`)
        continue
      }
      const d = (r.body as { data?: Record<string, unknown> })?.data ?? {}
      const noticeCategories = (d.noticeCategories as NoticeCategory[]) ?? []
      const attributes = (d.attributes as Attr[]) ?? []
      const certifications = (d.certifications as Cert[]) ?? []

      const noticeMandatory = noticeCategories.reduce(
        (acc, n) => acc + (n.noticeCategoryDetailNames ?? []).filter((dn) => dn.required === 'MANDATORY').length,
        0,
      )
      const attrMandatory = attributes.filter((a) => a.required === 'MANDATORY').length
      const certMandatory = certifications.filter((x) => x.required === 'MANDATORY').map((x) => x.name)

      await sb.from('jimscanner_trends_category_meta').upsert(
        {
          display_category_code: c.id,
          name: c.name,
          is_allow_single_item: (d.isAllowSingleItem as boolean) ?? null,
          notice_mandatory_count: noticeMandatory,
          attr_mandatory_count: attrMandatory,
          cert_required: certMandatory.length > 0,
          cert_names: certMandatory,
          raw: d,
          refreshed_at: new Date().toISOString(),
        },
        { onConflict: 'display_category_code' },
      )
      upserted++
      await new Promise((res) => setTimeout(res, 200))
    } catch (e) {
      errors.push(`[${c.id}] ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  return NextResponse.json({ ok: true, upserted, errors, executed_at: new Date().toISOString() })
}
