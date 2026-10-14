#!/usr/bin/env node
/**
 * 토스쇼핑 카테고리 트리를 BFS 로 받아 leaf 목록을 캐시한다 → scripts/lib/toss-<name>-leaves.json
 *   node scripts/toss-dump-food-leaves.mjs                              # 식품(50995) → toss-food-leaves.json (건강식품 59787 포함)
 *   node scripts/toss-dump-food-leaves.mjs --root=50997 --name=beauty   # 뷰티(50997) → toss-beauty-leaves.json (2026-10-14 화장품스토리 토스 등록)
 * 결과: [{ id, name, path, parentId, level }] — toss-register.mjs CAT_RULES / 카테고리 불일치 반려 자동 재등록(추천 경로 → id) 에 사용.
 */
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { tossCategoryChildren } from './lib/toss-api.mjs'
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.split('=').slice(1).join('=') : d }
const ROOTS = { food: { id: 50995, name: '식품' }, beauty: { id: 50997, name: '뷰티' } }
const NAME = arg('name', 'food'), rootId = parseInt(arg('root', ''), 10) || ROOTS[NAME]?.id
if (!rootId) { console.error('--root=<id> 또는 --name=food|beauty'); process.exit(1) }
const ROOT = { id: rootId, name: ROOTS[NAME]?.name || String(rootId), path: ROOTS[NAME]?.name || String(rootId) }
const OUT = `toss-${NAME}-leaves.json`
const queue = [ROOT], leaves = [], seen = new Set([ROOT.id])
let calls = 0
while (queue.length) {
  const cur = queue.shift()
  const r = await tossCategoryChildren(cur.id); calls++
  if (!r.ok) { console.error('children 실패', cur.id, JSON.stringify(r.error).slice(0, 120)); continue }
  const items = r.data?.items ?? []
  for (const c of items) {
    if (seen.has(c.id)) continue; seen.add(c.id)
    const node = { id: c.id, name: c.name, path: `${cur.path} > ${c.name}`, parentId: c.parentId, level: c.level }
    if (c.isLeaf) leaves.push(node); else queue.push(node)
  }
  if (calls % 50 === 0) console.log(`  ${calls} calls, leaves ${leaves.length}, queue ${queue.length}`)
}
leaves.sort((a, b) => a.path.localeCompare(b.path, 'ko'))
writeFileSync(path.join(__dirname, 'lib', OUT), JSON.stringify(leaves, null, 1))
console.log(`완료: leaf ${leaves.length}개, API ${calls}회 → scripts/lib/${OUT}`)
