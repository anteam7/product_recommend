/**
 * 쿠팡 거절사유 클러스터링 → 자동수선 플레이북
 *
 * 처리 흐름:
 *   1) jimscanner_coupang_listings 에서 status='REJECTED' 이고 rejection_reason 이 있는 행 조회
 *   2) rejection_reason || approval_status_name 텍스트를 text-embedding-3-small 로 임베딩
 *   3) HDBSCAN 대신 가벼운 응집 클러스터링 (코사인 유사도 + 단일 패스 그리디 그룹화)
 *      - 외부 의존성 없이 Node 만으로 실행 가능하도록 자체 구현
 *   4) 각 클러스터의 대표 사유(가장 짧고 중심에 가까운 텍스트) + 카테고리 분포 산출
 *   5) 클러스터별 LLM 라벨/fix_template 은 placeholder 로 채워두고
 *      사용자가 어드민에서 수동으로 다듬거나, OPENAI_API_KEY 있을 때 chat-completion 으로 자동 생성
 *   6) jimscanner_coupang_rejection_patterns / _assignments 에 적재
 *
 * 사용:
 *   node scripts/cluster-rejections.mjs                  # 전체 REJECTED 재클러스터링
 *   node scripts/cluster-rejections.mjs --dry-run        # 결과만 출력
 *   node scripts/cluster-rejections.mjs --threshold 0.78 # 유사도 임계값 조정 (기본 0.78)
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { createClient } from '@supabase/supabase-js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const env = Object.fromEntries(
  readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8')
    .split(/\r?\n/)
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => {
      const i = l.indexOf('=')
      let v = l.slice(i + 1).trim()
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
      return [l.slice(0, i).trim(), v]
    }),
)

const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY)
const OPENAI_KEY = env.OPENAI_API_KEY || process.env.OPENAI_API_KEY

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const thresholdIdx = args.indexOf('--threshold')
const SIM_THRESHOLD = thresholdIdx >= 0 ? parseFloat(args[thresholdIdx + 1]) : 0.78

async function embed(texts) {
  if (!OPENAI_KEY) {
    // 임베딩 키 없으면 더미 임베딩 (해시 기반) — 실제 운영 시 OPENAI_API_KEY 필수
    console.warn('[warn] OPENAI_API_KEY 없음 — 더미 토큰-overlap 유사도로 폴백')
    return texts.map((t) => bagOfWords(t))
  }
  const res = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OPENAI_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model: 'text-embedding-3-small', input: texts }),
  })
  if (!res.ok) {
    const errText = await res.text()
    throw new Error(`OpenAI embedding 실패: ${res.status} ${errText.slice(0, 300)}`)
  }
  const j = await res.json()
  return j.data.map((d) => d.embedding)
}

function bagOfWords(text) {
  // 한국어/영어 토큰화 (단순) — fallback 용
  const tokens = (text || '').toLowerCase().replace(/[^a-z가-힣0-9\s]/g, ' ').split(/\s+/).filter(Boolean)
  const map = new Map()
  for (const t of tokens) map.set(t, (map.get(t) ?? 0) + 1)
  // 256 차원으로 해시 임베딩
  const vec = new Array(256).fill(0)
  for (const [tok, cnt] of map) {
    let h = 0
    for (let i = 0; i < tok.length; i++) h = (h * 31 + tok.charCodeAt(i)) & 0xfffffff
    vec[h % 256] += cnt
  }
  // L2 normalize
  const n = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1
  return vec.map((v) => v / n)
}

function cosine(a, b) {
  let s = 0
  const len = Math.min(a.length, b.length)
  for (let i = 0; i < len; i++) s += a[i] * b[i]
  return s
}

function l2Normalize(v) {
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1
  return v.map((x) => x / n)
}

/**
 * 단일 패스 그리디 클러스터링.
 * - 각 새 포인트에 대해 가장 가까운 클러스터 중심과 cosine 비교
 * - threshold 이상이면 그 클러스터에 합류 (중심을 평균으로 업데이트)
 * - 아니면 새 클러스터 생성
 */
function greedyCluster(vectors, threshold) {
  const centroids = []
  const sizes = []
  const assignments = []
  const sims = []
  for (const v of vectors) {
    let bestIdx = -1
    let bestSim = -1
    for (let i = 0; i < centroids.length; i++) {
      const s = cosine(v, centroids[i])
      if (s > bestSim) {
        bestSim = s
        bestIdx = i
      }
    }
    if (bestIdx >= 0 && bestSim >= threshold) {
      const n = sizes[bestIdx]
      const c = centroids[bestIdx]
      for (let i = 0; i < c.length; i++) c[i] = (c[i] * n + v[i]) / (n + 1)
      centroids[bestIdx] = l2Normalize(c)
      sizes[bestIdx] = n + 1
      assignments.push(bestIdx)
      sims.push(bestSim)
    } else {
      centroids.push([...v])
      sizes.push(1)
      assignments.push(centroids.length - 1)
      sims.push(1.0)
    }
  }
  return { centroids, sizes, assignments, sims }
}

async function llmLabel(exemplarReason, sampleReasons) {
  if (!OPENAI_KEY) {
    return {
      label: exemplarReason.slice(0, 40),
      fix_template: {
        summary: '수동 검토 필요 — OPENAI_API_KEY 없음',
        steps: [],
        payload_patch: {},
      },
    }
  }
  const prompt = `너는 쿠팡 셀러 자동등록 에이전트다. 다음은 같은 패턴의 쿠팡 리스팅 거절 사유들이다.

대표 사유:
${exemplarReason}

샘플 사유 ${sampleReasons.length}개:
${sampleReasons.slice(0, 8).map((r, i) => `${i + 1}. ${r}`).join('\n')}

이 패턴에 대해 JSON으로만 답해라:
{
  "label": "5-15자 한국어 라벨 (예: 이미지 누락, 성분표 부족, 광고문구 위반)",
  "fix_template": {
    "summary": "1-2문장 수선 전략",
    "steps": ["구체적 수선 단계 1", "단계 2"],
    "payload_patch": { /* coupang seller-products 페이로드에 머지될 JSON 패치 */ }
  }
}`
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OPENAI_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
      temperature: 0.2,
    }),
  })
  if (!res.ok) {
    return {
      label: exemplarReason.slice(0, 40),
      fix_template: { summary: 'LLM 호출 실패', steps: [], payload_patch: {} },
    }
  }
  const j = await res.json()
  try {
    return JSON.parse(j.choices[0].message.content)
  } catch {
    return {
      label: exemplarReason.slice(0, 40),
      fix_template: { summary: '파싱 실패', steps: [], payload_patch: {} },
    }
  }
}

async function main() {
  console.log('[start] cluster-rejections — threshold=%s dryRun=%s', SIM_THRESHOLD, dryRun)

  const { data: rows, error } = await sb
    .from('jimscanner_coupang_listings')
    .select('id, rejection_reason, approval_status_name, display_category_code, display_category_name, list_price_krw, status')
    .eq('status', 'REJECTED')
    .not('rejection_reason', 'is', null)

  if (error) throw error
  if (!rows || rows.length === 0) {
    console.log('[done] REJECTED 행 없음')
    return
  }
  console.log('[info] REJECTED 리스팅 %d건', rows.length)

  const texts = rows.map((r) => [r.approval_status_name, r.rejection_reason].filter(Boolean).join(' — '))
  const rawVecs = await embed(texts)
  const vecs = rawVecs.map((v) => l2Normalize(v))

  const { sizes, assignments, sims } = greedyCluster(vecs, SIM_THRESHOLD)
  console.log('[info] %d개 클러스터 생성', sizes.length)

  // 클러스터별 집계
  const generatedAt = new Date().toISOString()
  const patterns = []
  const assignmentRows = []

  for (let cid = 0; cid < sizes.length; cid++) {
    const memberIdx = assignments
      .map((c, i) => (c === cid ? i : -1))
      .filter((i) => i >= 0)
    if (memberIdx.length < 2 && sizes.length > 1) continue // 1개짜리 클러스터는 노이즈로 취급

    const memberRows = memberIdx.map((i) => rows[i])
    const reasons = memberIdx.map((i) => texts[i])
    // 가장 짧은(=간결한) 사유를 exemplar 로
    const exemplar = reasons.slice().sort((a, b) => a.length - b.length)[0]
    const recoverableRevenue = memberRows.reduce((s, r) => s + (r.list_price_krw ?? 0), 0)
    // 카테고리 분포 top
    const catMap = new Map()
    for (const r of memberRows) {
      const key = `${r.display_category_code}|${r.display_category_name ?? ''}`
      const cur = catMap.get(key) ?? { code: r.display_category_code, name: r.display_category_name, count: 0 }
      cur.count += 1
      catMap.set(key, cur)
    }
    const categoryTop = [...catMap.values()].sort((a, b) => b.count - a.count).slice(0, 5)

    let llm = { label: exemplar.slice(0, 40), fix_template: { summary: '', steps: [], payload_patch: {} } }
    try {
      llm = await llmLabel(exemplar, reasons)
    } catch (e) {
      console.warn('[warn] LLM 라벨 실패 cid=%d: %s', cid, e.message)
    }

    patterns.push({
      cluster_id: cid,
      label: llm.label,
      exemplar_reason: exemplar,
      fix_template: llm.fix_template,
      category_top: categoryTop,
      sample_count: memberIdx.length,
      recoverable_revenue_krw: recoverableRevenue,
      generated_at: generatedAt,
    })
    for (let k = 0; k < memberIdx.length; k++) {
      const i = memberIdx[k]
      assignmentRows.push({
        listing_id: rows[i].id,
        cluster_id: cid,
        similarity: sims[i],
        assigned_at: generatedAt,
      })
    }
    console.log('  cluster %d: %d건 — %s', cid, memberIdx.length, llm.label)
  }

  if (dryRun) {
    console.log('[dry-run] 적재 생략. patterns=%d, assignments=%d', patterns.length, assignmentRows.length)
    return
  }

  // 새 generated_at 으로 INSERT (히스토리 보존). assignments 는 PK 가 listing_id 라 upsert.
  if (patterns.length > 0) {
    const { error: e1 } = await sb.from('jimscanner_coupang_rejection_patterns').insert(patterns)
    if (e1) throw e1
  }
  if (assignmentRows.length > 0) {
    const { error: e2 } = await sb
      .from('jimscanner_coupang_rejection_assignments')
      .upsert(assignmentRows, { onConflict: 'listing_id' })
    if (e2) throw e2
  }
  console.log('[done] patterns=%d assignments=%d 적재 완료', patterns.length, assignmentRows.length)
}

main().catch((e) => {
  console.error('[fatal]', e)
  process.exit(1)
})
