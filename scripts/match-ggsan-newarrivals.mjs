#!/usr/bin/env node
/**
 * 도매 신규입고 × 트렌드 시드 first-mover 매칭 잡.
 *
 * 1) jimscanner_ggsan_backfill_first_seen() — NULL/잘못된 first_seen_at 보정
 * 2) jimscanner_ggsan_newarrival_match() RPC 호출 — 신규 SKU 중
 *    여러 source 에서 가속 시그널이 잡힌 first-mover 후보 추출
 * 3) 결과를 raw_payload.newarrival_match 에 저장 (어드민 보드용 캐시)
 *
 * Usage:
 *   node scripts/match-ggsan-newarrivals.mjs              # 14일 기본
 *   node scripts/match-ggsan-newarrivals.mjs --days 30
 *   node scripts/match-ggsan-newarrivals.mjs --days 7 --min-sources 3
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { createClient } from '@supabase/supabase-js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

function loadEnv() {
  const envPath = path.join(__dirname, '..', '.env.local')
  return Object.fromEntries(
    readFileSync(envPath, 'utf8')
      .split(/\r?\n/)
      .filter((l) => l && !l.startsWith('#') && l.includes('='))
      .map((l) => {
        const i = l.indexOf('=')
        let v = l.slice(i + 1).trim()
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
          v = v.slice(1, -1)
        }
        return [l.slice(0, i).trim(), v]
      }),
  )
}

function parseArgs(argv) {
  const out = { days: 14, minSources: 2, maxCompetitors: 3, minSim: 0.2, dryRun: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--days') out.days = parseInt(argv[++i], 10)
    else if (a === '--min-sources') out.minSources = parseInt(argv[++i], 10)
    else if (a === '--max-competitors') out.maxCompetitors = parseInt(argv[++i], 10)
    else if (a === '--min-sim') out.minSim = parseFloat(argv[++i])
    else if (a === '--dry-run') out.dryRun = true
  }
  return out
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const env = loadEnv()
  const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  console.log('=== ggsan 신규입고 × 트렌드 first-mover 매칭 잡 ===')
  console.log('args:', args)

  // 1) backfill
  console.log('\n[1/3] first_seen_at backfill...')
  const { data: backfilled, error: bfErr } = await sb.rpc('jimscanner_ggsan_backfill_first_seen')
  if (bfErr) {
    console.warn('  ⚠ backfill RPC 실패:', bfErr.message, '— 마이그레이션 미적용 가능성')
  } else {
    console.log(`  ✓ ${backfilled ?? 0} rows backfilled`)
  }

  // 2) RPC 호출
  console.log('\n[2/3] newarrival_match RPC...')
  const { data: rows, error: rpcErr } = await sb.rpc('jimscanner_ggsan_newarrival_match', {
    days_back: args.days,
    match_window_days: args.days,
    min_sim: args.minSim,
    min_sources: args.minSources,
    max_competitors: args.maxCompetitors,
    result_limit: 500,
  })
  if (rpcErr) {
    console.error('  ✗ RPC 실패:', rpcErr.message)
    process.exit(1)
  }
  const list = rows ?? []
  console.log(`  ✓ ${list.length} first-mover 후보`)

  if (list.length === 0) {
    console.log('\n결과 없음. 윈도우/임계값을 완화하거나 시그널 누적을 기다리세요.')
    return
  }

  // 상위 20건 미리보기
  console.log('\n[preview top 20]')
  console.log(
    'goods_no    | age | src | comp | sim   | score   | top_keyword                   | title'.padEnd(140, ' '),
  )
  console.log('-'.repeat(140))
  for (const r of list.slice(0, 20)) {
    console.log(
      [
        r.goods_no,
        String(r.age_days).padStart(3),
        String(r.source_count).padStart(3),
        String(r.competitor_sku_count).padStart(4),
        Number(r.best_sim).toFixed(3),
        Number(r.golden_score).toFixed(2).padStart(7),
        (r.top_keyword ?? '').slice(0, 30).padEnd(30),
        (r.title ?? '').slice(0, 40),
      ].join(' | '),
    )
  }

  if (args.dryRun) {
    console.log('\n[3/3] dry-run — 캐시 저장 생략')
    return
  }

  // 3) raw_payload.newarrival_match 캐시 갱신
  console.log('\n[3/3] raw_payload 캐시 저장...')
  const stamp = new Date().toISOString()
  let saved = 0
  for (const r of list) {
    const { data: cur } = await sb
      .from('jimscanner_ggsan_products')
      .select('raw_payload')
      .eq('goods_no', r.goods_no)
      .maybeSingle()
    const next = {
      ...(cur?.raw_payload || {}),
      newarrival_match: {
        scored_at: stamp,
        params: {
          days_back: args.days,
          min_sim: args.minSim,
          min_sources: args.minSources,
          max_competitors: args.maxCompetitors,
        },
        age_days: r.age_days,
        top_keyword: r.top_keyword,
        best_sim: Number(r.best_sim),
        source_count: r.source_count,
        sources: r.sources,
        match_count: r.match_count,
        competitor_sku_count: r.competitor_sku_count,
        golden_score: Number(r.golden_score),
      },
    }
    const { error: upErr } = await sb
      .from('jimscanner_ggsan_products')
      .update({ raw_payload: next })
      .eq('goods_no', r.goods_no)
    if (upErr) {
      console.warn(`  ⚠ ${r.goods_no} update 실패: ${upErr.message}`)
    } else {
      saved++
    }
  }
  console.log(`  ✓ ${saved}/${list.length} 캐시 저장`)
  console.log('\n완료. /admin/trend-radar/ggsan/new-arrivals 에서 확인.')
}

main().catch((e) => {
  console.error('FATAL:', e)
  process.exit(1)
})
