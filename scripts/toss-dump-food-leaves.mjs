#!/usr/bin/env node
/**
 * 토스쇼핑 식품(50995) 카테고리 트리 전체를 BFS 로 받아 leaf 목록을 캐시한다 → scripts/lib/toss-food-leaves.json
 *   node scripts/toss-dump-food-leaves.mjs            # 전체(건강식품 59787 포함)
 * 결과: [{ id, name, path, parentId, level }] — toss-register.mjs CAT_RULES / 카테고리 불일치 반려 자동 재등록(추천 경로 → id) 에 사용.
 */
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { tossCategoryChildren } from './lib/toss-api.mjs'
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = { id: 50995, name: '식품', path: '식품' }
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
writeFileSync(path.join(__dirname, 'lib', 'toss-food-leaves.json'), JSON.stringify(leaves, null, 1))
console.log(`완료: leaf ${leaves.length}개, API ${calls}회 → scripts/lib/toss-food-leaves.json`)
