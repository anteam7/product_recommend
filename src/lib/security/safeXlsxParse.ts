/**
 * 안전한 xlsx 파싱 (브라우저 사이드 전용).
 *
 * B2B 직구 사업자 도구의 엑셀 업로드 → 33 배대지 양식 변환 흐름에서 사용.
 * 결정 (S7): PII 가 서버 도달하지 않도록 *브라우저에서만* 파싱.
 *
 * 가드:
 *  - 파일 size limit (default 10MB)
 *  - mime type + magic byte 검증 (.xlsx 만)
 *  - 시트 수 limit (default 10)
 *  - 행 수 limit (default 10,000)
 *  - prototype pollution 방어 (Object.create(null) + key sanitize, CVE-2023-30533)
 *
 * `xlsx` 패키지는 dynamic import 로 번들 분리. 사용 페이지에서만 로드.
 *
 * 메모리: b2b_track_plan.md (S5/P1).
 */

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

const VALID_MIME = new Set([
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
  'application/octet-stream', // 일부 브라우저
  '', // file 객체에 mime 없는 경우
])

export interface SafeXlsxOptions {
  /** 최대 파일 크기 (bytes). default 10MB */
  maxBytes?: number
  /** 최대 시트 수. default 10 */
  maxSheets?: number
  /** 시트 당 최대 행 수. default 10,000 */
  maxRows?: number
}

export class SafeXlsxError extends Error {
  constructor(
    public reason:
      | 'file_too_large'
      | 'invalid_mime'
      | 'invalid_magic_bytes'
      | 'too_many_sheets'
      | 'too_many_rows',
    public details?: Record<string, unknown>,
  ) {
    super(`safeXlsxParse: ${reason}`)
    this.name = 'SafeXlsxError'
  }
}

export interface ParsedSheet {
  name: string
  rows: Record<string, unknown>[]
}

export interface ParsedXlsx {
  sheets: ParsedSheet[]
  totalRows: number
}

function sanitizeRow(row: Record<string, unknown>): Record<string, unknown> {
  const safe: Record<string, unknown> = Object.create(null)
  for (const k of Object.keys(row)) {
    if (FORBIDDEN_KEYS.has(k)) continue
    safe[k] = row[k]
  }
  return safe
}

export async function safeXlsxParse(file: File, opts: SafeXlsxOptions = {}): Promise<ParsedXlsx> {
  const maxBytes = opts.maxBytes ?? 10 * 1024 * 1024
  const maxSheets = opts.maxSheets ?? 10
  const maxRows = opts.maxRows ?? 10_000

  // 1) size
  if (file.size > maxBytes) {
    throw new SafeXlsxError('file_too_large', { size: file.size, max: maxBytes })
  }

  // 2) mime type
  if (file.type && !VALID_MIME.has(file.type)) {
    throw new SafeXlsxError('invalid_mime', { type: file.type })
  }

  // 3) magic bytes — xlsx 는 ZIP container → "PK\x03\x04"
  const header = new Uint8Array(await file.slice(0, 4).arrayBuffer())
  if (!(header[0] === 0x50 && header[1] === 0x4b && header[2] === 0x03 && header[3] === 0x04)) {
    throw new SafeXlsxError('invalid_magic_bytes')
  }

  // 4) parse — dynamic import for bundle splitting
  const xlsx = await import('xlsx')
  const buffer = await file.arrayBuffer()
  const wb = xlsx.read(buffer, { type: 'array' })

  if (wb.SheetNames.length > maxSheets) {
    throw new SafeXlsxError('too_many_sheets', {
      count: wb.SheetNames.length,
      max: maxSheets,
    })
  }

  const sheets: ParsedSheet[] = []
  let totalRows = 0
  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name]
    const rows = xlsx.utils.sheet_to_json(ws, { defval: null }) as Record<string, unknown>[]
    if (rows.length > maxRows) {
      throw new SafeXlsxError('too_many_rows', {
        sheet: name,
        count: rows.length,
        max: maxRows,
      })
    }
    sheets.push({ name, rows: rows.map(sanitizeRow) })
    totalRows += rows.length
  }

  return { sheets, totalRows }
}
