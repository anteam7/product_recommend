/**
 * 쿠팡 쓰기 작업(발주확인·송장등록)을 집 PC 큐로 보내고 결과를 기다리는 클라이언트 유틸.
 *
 * 왜 큐인가: Vercel IP는 쿠팡 OpenAPI IP 접근제어 밖(403)이고, 브라우저→127.0.0.1 헬퍼 직접 호출은
 * 기기(모바일)·브라우저 권한(크롬 로컬 네트워크 접근)에 따라 막힌다. 그래서 Vercel 은 `jimscanner_purchase_jobs`
 * 에 잡만 넣고, 집 PC 의 order-server 폴러(3초)가 실행한다. 헬퍼가 꺼져 있으면 잡은 큐에 남았다가 켜지면 처리된다.
 */
export type CoupangJobMode = 'coupang_ack' | 'coupang_invoice'

export interface JobResult {
  id: number
  status: 'queued' | 'running' | 'done' | 'error' | string
  result_msg: string | null
}

/** 잡 등록. 같은 주문·같은 종류의 잡이 대기/실행 중이면 그 잡 id 를 재사용한다. */
export async function enqueueCoupangJob(orderKey: string, mode: CoupangJobMode): Promise<{ id: number } | { error: string }> {
  try {
    const res = await fetch('/api/admin/purchase-jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ order_key: orderKey, mode }),
    })
    const j = await res.json().catch(() => ({}))
    if (res.ok && j.id) return { id: Number(j.id) }
    if (res.status === 409 && j.id) return { id: Number(j.id) } // 이미 진행 중 → 그 잡을 기다림
    return { error: j.error || `HTTP ${res.status}` }
  } catch (e) {
    return { error: e instanceof Error ? e.message : '네트워크 오류' }
  }
}

/** 잡이 done/error 가 될 때까지 폴링(기본 2초 × 최대 30초). 시간 초과면 마지막 상태 반환. */
export async function waitForJob(id: number, { intervalMs = 2000, timeoutMs = 30000 } = {}): Promise<JobResult> {
  const t0 = Date.now()
  let last: JobResult = { id, status: 'queued', result_msg: null }
  while (Date.now() - t0 < timeoutMs) {
    try {
      const res = await fetch(`/api/admin/purchase-jobs?id=${id}`, { cache: 'no-store' })
      if (res.ok) {
        const j = await res.json().catch(() => null)
        const job = j?.job
        if (job?.status) {
          last = { id, status: job.status, result_msg: job.result_msg ?? null }
          if (job.status === 'done' || job.status === 'error') return last
        }
      }
    } catch { /* 네트워크 일시 오류 — 다음 폴링 */ }
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  return last
}

/** 등록 + 대기 한 번에. 사용자 메시지(✓/⚠/⏳ 접두)로 정리해 반환. */
export async function runCoupangJob(orderKey: string, mode: CoupangJobMode, labels: { doing: string; done: string }, onProgress?: (msg: string) => void): Promise<string> {
  const q = await enqueueCoupangJob(orderKey, mode)
  if ('error' in q) return `⚠ ${labels.doing} 요청 실패: ${q.error}`
  onProgress?.(`집 PC에서 ${labels.doing} 중… (잡 #${q.id})`)
  const r = await waitForJob(q.id)
  if (r.status === 'done') return `✓ ${labels.done}${r.result_msg && r.result_msg !== 'OK' ? ` — ${r.result_msg}` : ''}`
  if (r.status === 'error') return `⚠ ${labels.doing} 실패: ${r.result_msg ?? '원인 미상'}`
  return `⏳ ${labels.doing} 대기 중(잡 #${q.id}) — 집 PC 헬퍼가 켜지면 자동 처리됩니다. 잠시 후 새로고침해 확인하세요`
}
