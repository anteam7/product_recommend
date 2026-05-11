// 매니페스트 (ACI 엑셀) 파싱·정제·PII drop — 서버 전용
// scripts/import_manifests.py 와 동일 로직의 Node.js 포팅.
//
// 보안 원칙:
//   - PII 컬럼 (수취인·주민번호·주소·전화·메모·송장번호 평문 등)은 절대 반환·저장하지 않음
//   - 송장번호 → SHA256 해시로만 그룹화 (역으로 식별 불가)

import { createHash } from 'node:crypto'
import * as XLSX from 'xlsx'

export type Country = 'US' | 'JP' | 'CN'
export type Mode = 'air' | 'boat' | 'mixed'

export type ParsedManifestRow = {
  source_file: string
  source_country: Country
  shipping_mode: Mode
  center_name: string | null
  source_forwarder_slug: string | null
  collected_date: string | null // 'YYYY-MM-DD'
  invoice_id_hash: string
  item_count_in_invoice: number
  hs_code: string | null
  category_tag: string | null
  product_name_en: string
  brand_raw: string | null
  purchase_site: string | null
  pcs: number
  unit_value_usd: number | null
  invoice_total_weight_kg: number | null
  invoice_volumetric_weight_kg: number | null
  is_outlier: boolean
  outlier_reason: string | null
}

export type ParseResult = {
  rows: ParsedManifestRow[]
  total_input_rows: number
  invoices: number
  skipped_meaningless: number
  outliers: number
  warnings: string[]
}

const TAG_RE = /^\s*\[([^\]]+)\]/
const REPETITIVE_RE = /^([a-z]{2,5})\1{2,}$/i

function extractTag(name: string | null | undefined): string | null {
  if (!name) return null
  const m = TAG_RE.exec(String(name))
  return m ? m[1].trim() : null
}

function stripTag(name: string | null | undefined): string {
  if (!name) return ''
  return String(name).replace(TAG_RE, '').trim()
}

function isMeaningless(name: string | null | undefined): boolean {
  if (!name) return true
  const s = stripTag(name)
  if (s.length < 5) return true
  const noSpace = s.replace(/\s+/g, '').toLowerCase()
  if (noSpace.length >= 8 && REPETITIVE_RE.test(noSpace)) return true
  if (noSpace.length >= 6 && new Set(noSpace).size <= 2) return true
  return false
}

function hashInvoice(orderId: unknown): string {
  return createHash('sha256').update(String(orderId)).digest('hex')
}

function parseDate(yyyymmdd: unknown): string | null {
  if (!yyyymmdd) return null
  const s = String(typeof yyyymmdd === 'number' ? Math.trunc(yyyymmdd) : yyyymmdd)
  if (!/^\d{8}$/.test(s)) return null
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`
}

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function intPos(v: unknown, fallback = 1): number {
  const n = num(v)
  if (n === null || n <= 0) return fallback
  return Math.floor(n)
}

const PII_HEADERS = new Set([
  '수취인',
  '수취인TEL',
  '수취인HP',
  '주민번호',
  '우편번호',
  '주소',
  '나머지주소',
  '메모',
  '업체TEL',
  '업체주소',
  '송장번호', // 평문 보관 금지 — 주문번호 해시만 사용
])

const REQUIRED_HEADERS = ['주문번호', '내용물', '실무게', 'PCS']

export type ParseInput = {
  buffer: Buffer
  fileName: string
  country: Country
  mode: Mode
  centerName?: string | null
  forwarderSlug?: string | null
  outlierWeightKg?: number // 기본 50
}

export function parseManifest({
  buffer,
  fileName,
  country,
  mode,
  centerName = null,
  forwarderSlug = null,
  outlierWeightKg = 50,
}: ParseInput): ParseResult {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: false })
  const sheet = wb.Sheets[wb.SheetNames[0]]
  if (!sheet) {
    return {
      rows: [],
      total_input_rows: 0,
      invoices: 0,
      skipped_meaningless: 0,
      outliers: 0,
      warnings: ['엑셀에 시트가 없습니다.'],
    }
  }
  const grid = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: null }) as unknown[][]
  if (grid.length === 0) {
    return {
      rows: [],
      total_input_rows: 0,
      invoices: 0,
      skipped_meaningless: 0,
      outliers: 0,
      warnings: ['엑셀이 비어있습니다.'],
    }
  }

  const headerRow = grid[0]
  const H: Record<string, number> = {}
  for (let i = 0; i < headerRow.length; i++) {
    const h = headerRow[i]
    if (typeof h !== 'string') continue
    const trimmed = h.trim()
    if (PII_HEADERS.has(trimmed)) continue // 의도적으로 인덱스 매핑 안 함
    H[trimmed] = i
  }

  const warnings: string[] = []
  for (const req of REQUIRED_HEADERS) {
    if (!(req in H)) warnings.push(`필수 컬럼 누락: ${req}`)
  }
  if (warnings.length > 0) {
    return {
      rows: [],
      total_input_rows: grid.length - 1,
      invoices: 0,
      skipped_meaningless: 0,
      outliers: 0,
      warnings: ['파싱 중단', ...warnings],
    }
  }

  // ── 송장 그룹화 (주문번호 forward-fill) ──
  type InvAcc = {
    weight: number | null
    volumetric: number | null
    site: string | null
    date: string | null
    items: {
      name: string
      pcs: number
      hs: string | null
      value: number | null
      brand: string | null
    }[]
  }
  const invoices = new Map<string, InvAcc>()
  let curOrder: string | null = null

  for (let r = 1; r < grid.length; r++) {
    const row = grid[r]
    const orderRaw = row[H['주문번호']]
    if (orderRaw) {
      curOrder = String(orderRaw)
      if (!invoices.has(curOrder)) {
        invoices.set(curOrder, {
          weight: num(row[H['실무게']]),
          volumetric: H['부피무게'] != null ? num(row[H['부피무게']]) : null,
          site: H['구입사이트'] != null ? toStr(row[H['구입사이트']]) : null,
          date: H['날짜'] != null ? parseDate(row[H['날짜']]) : null,
          items: [],
        })
      }
    }
    if (!curOrder) continue
    const inv = invoices.get(curOrder)!
    const nameRaw = row[H['내용물']]
    if (!nameRaw) continue
    inv.items.push({
      name: String(nameRaw),
      pcs: intPos(row[H['PCS']], 1),
      hs: H['HS CODE'] != null && row[H['HS CODE']] != null ? String(row[H['HS CODE']]) : null,
      value: H['Value'] != null ? num(row[H['Value']]) : null,
      brand: H['Brand'] != null && row[H['Brand']] != null ? String(row[H['Brand']]).trim() : null,
    })
  }

  // ── 적재 행 생성 ──
  const out: ParsedManifestRow[] = []
  let skippedMeaningless = 0
  let outliers = 0

  for (const [orderId, inv] of invoices) {
    const invoiceHash = hashInvoice(orderId)
    const itemCount = inv.items.length
    const heavyInvoice = inv.weight !== null && inv.weight > outlierWeightKg

    for (const it of inv.items) {
      if (isMeaningless(it.name)) {
        skippedMeaningless++
        continue
      }
      const cleanedName = stripTag(it.name).slice(0, 1000)
      const tag = extractTag(it.name)

      let isOutlier = heavyInvoice
      let outlierReason: string | null = heavyInvoice ? 'weight_over_50kg' : null
      // 단일품목인데 개당 무게 > 30kg 도 outlier
      if (!isOutlier && itemCount === 1 && inv.weight && inv.weight / Math.max(it.pcs, 1) > 30) {
        isOutlier = true
        outlierReason = 'weight_per_pc_over_30kg'
      }
      if (isOutlier) outliers++

      out.push({
        source_file: fileName,
        source_country: country,
        shipping_mode: mode,
        center_name: centerName ? centerName.slice(0, 100) : null,
        source_forwarder_slug: forwarderSlug ? forwarderSlug.slice(0, 100) : null,
        collected_date: inv.date,
        invoice_id_hash: invoiceHash,
        item_count_in_invoice: itemCount,
        hs_code: it.hs ? it.hs.slice(0, 10) : null,
        category_tag: tag ? tag.slice(0, 60) : null,
        product_name_en: cleanedName,
        brand_raw: it.brand ? it.brand.slice(0, 200) : null,
        purchase_site: inv.site ? inv.site.slice(0, 200) : null,
        pcs: it.pcs,
        unit_value_usd: it.value,
        invoice_total_weight_kg: inv.weight,
        invoice_volumetric_weight_kg: inv.volumetric,
        is_outlier: isOutlier,
        outlier_reason: outlierReason,
      })
    }
  }

  return {
    rows: out,
    total_input_rows: grid.length - 1,
    invoices: invoices.size,
    skipped_meaningless: skippedMeaningless,
    outliers,
    warnings,
  }
}

function toStr(v: unknown): string | null {
  if (v === null || v === undefined) return null
  return String(v)
}
