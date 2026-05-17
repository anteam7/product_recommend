#!/usr/bin/env node
/**
 * cluster-visual-twins.mjs — 임베딩 cosine ≥ 0.88 connected component 로
 *   cross-source visual twin 클러스터 ID 부여.
 *
 * 입력: jimscanner_sku_image_embeddings (embedding 채워진 row 전부)
 * 출력: jimscanner_visual_twin_clusters 행 생성/갱신 + embeddings.cluster_id 채움
 *
 * 사용법:
 *   node --env-file=.env.local scripts/cluster-visual-twins.mjs
 *   node --env-file=.env.local scripts/cluster-visual-twins.mjs --threshold=0.9
 *
 * 알고리즘:
 *   1) 모든 embedding 로드 (memory: 768 * 4byte * N — N=10k 면 ~30MB OK)
 *   2) 각 row 마다 pgvector RPC (또는 in-memory cosine) 로 sim ≥ threshold 이웃 수집
 *   3) Union-Find 로 connected component
 *   4) 클러스터별 representative / source_count / price 범위 갱신
 */

import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing.')
  process.exit(1)
}

const sb = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } })

const args = process.argv.slice(2)
const thresholdArg = args.find((a) => a.startsWith('--threshold='))
const THRESHOLD = thresholdArg ? parseFloat(thresholdArg.split('=')[1]) : 0.88

function parseVector(v) {
  if (Array.isArray(v)) return v
  if (typeof v === 'string') {
    // pgvector text format: "[0.1,0.2,...]"
    const inner = v.replace(/^\[/, '').replace(/\]$/, '')
    return inner.split(',').map(Number)
  }
  return null
}

function cosine(a, b) {
  let dot = 0
  let na = 0
  let nb = 0
  const len = Math.min(a.length, b.length)
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb)
  return denom === 0 ? 0 : dot / denom
}

class UnionFind {
  constructor(n) {
    this.parent = Array.from({ length: n }, (_, i) => i)
  }
  find(x) {
    while (this.parent[x] !== x) {
      this.parent[x] = this.parent[this.parent[x]]
      x = this.parent[x]
    }
    return x
  }
  union(a, b) {
    const ra = this.find(a)
    const rb = this.find(b)
    if (ra !== rb) this.parent[ra] = rb
  }
}

async function loadEmbeddings() {
  // 페이지네이션 (10k 까지는 한방, 그 이상은 chunk)
  const PAGE = 1000
  let from = 0
  const all = []
  while (true) {
    const { data, error } = await sb
      .from('jimscanner_sku_image_embeddings')
      .select('id, source, source_sku_id, image_url, title, price_krw, embedding')
      .not('embedding', 'is', null)
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1)
    if (error) throw new Error(`load: ${error.message}`)
    if (!data || data.length === 0) break
    for (const r of data) {
      const vec = parseVector(r.embedding)
      if (!vec || vec.length === 0) continue
      all.push({
        id: r.id,
        source: r.source,
        source_sku_id: r.source_sku_id,
        image_url: r.image_url,
        title: r.title,
        price_krw: r.price_krw,
        vec,
      })
    }
    if (data.length < PAGE) break
    from += PAGE
  }
  return all
}

async function main() {
  console.log(`[${new Date().toISOString()}] cluster-visual-twins threshold=${THRESHOLD}`)
  const rows = await loadEmbeddings()
  console.log(`  loaded ${rows.length} embeddings`)
  if (rows.length < 2) {
    console.log('  not enough data, exit')
    return
  }

  const uf = new UnionFind(rows.length)
  let edges = 0
  // O(N^2) — N=2~3k 까진 ok. 더 커지면 pgvector RPC 로 ANN 호출하도록 교체.
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      if (rows[i].source === rows[j].source && rows[i].source_sku_id === rows[j].source_sku_id) continue
      const c = cosine(rows[i].vec, rows[j].vec)
      if (c >= THRESHOLD) {
        uf.union(i, j)
        edges++
      }
    }
  }
  console.log(`  edges=${edges}`)

  // 그룹핑
  const groups = new Map()
  for (let i = 0; i < rows.length; i++) {
    const root = uf.find(i)
    if (!groups.has(root)) groups.set(root, [])
    groups.get(root).push(i)
  }

  // 크기 ≥ 2 클러스터만 저장 (single-member 는 cluster_id 없음)
  const multi = [...groups.values()].filter((g) => g.length >= 2)
  console.log(`  clusters >=2 members: ${multi.length}`)

  for (const memberIdx of multi) {
    const members = memberIdx.map((i) => rows[i])
    const sources = new Set(members.map((m) => m.source))
    const ggsanMember = members.find((m) => m.source === 'ggsan')
    const rep = ggsanMember ?? members[0]
    const prices = members.map((m) => m.price_krw).filter((p) => typeof p === 'number' && p > 0)
    let minCos = 1
    for (let i = 0; i < members.length; i++) {
      for (let j = i + 1; j < members.length; j++) {
        const c = cosine(members[i].vec, members[j].vec)
        if (c < minCos) minCos = c
      }
    }

    const clusterRow = {
      representative_image_url: rep.image_url,
      representative_title: rep.title,
      member_count: members.length,
      source_count: sources.size,
      min_cosine: Number(minCos.toFixed(4)),
      has_ggsan: sources.has('ggsan'),
      has_aliex: sources.has('aliex_best'),
      has_musinsa: sources.has('musinsa_best'),
      has_danawa: sources.has('danawa_main'),
      has_domeggook: sources.has('domeggook_main'),
      min_price_krw: prices.length ? Math.min(...prices) : null,
      max_price_krw: prices.length ? Math.max(...prices) : null,
      updated_at: new Date().toISOString(),
    }

    const { data: inserted, error: insErr } = await sb
      .from('jimscanner_visual_twin_clusters')
      .insert(clusterRow)
      .select('cluster_id')
      .single()
    if (insErr) {
      console.warn(`  cluster insert fail: ${insErr.message}`)
      continue
    }
    const clusterId = inserted.cluster_id

    const ids = members.map((m) => m.id)
    const { error: updErr } = await sb
      .from('jimscanner_sku_image_embeddings')
      .update({ cluster_id: clusterId })
      .in('id', ids)
    if (updErr) {
      console.warn(`  member update fail: ${updErr.message}`)
    }
  }

  console.log(`[${new Date().toISOString()}] cluster done`)
}

await main().catch((e) => {
  console.error(e instanceof Error ? e.stack : e)
  process.exit(1)
})
