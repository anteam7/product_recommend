/**
 * 토스쇼핑 식품 카테고리 leaf 캐시 헬퍼 — scripts/toss-dump-food-leaves.mjs 가 만든 lib/toss-food-leaves.json(1,280 leaf) 사용.
 *   resolveLeafByPath('식품 > 장/소스 > 식용유/오일/참기름 > 올리브유 > 엑스트라버진') → { id, path } | null
 *   parseRecommendedCategory(rejectReasons) → '식품 > …' | null   (검수 반려 "카테고리 불일치" 메시지의 추천 경로)
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
let _leaves = null
export function loadFoodLeaves() {
  if (!_leaves) _leaves = JSON.parse(readFileSync(path.join(__dirname, 'toss-food-leaves.json'), 'utf8'))
  return _leaves
}
const norm = (s) => String(s || '').replace(/\s*>\s*/g, ' > ').replace(/\s+/g, ' ').trim()

/**
 * 경로 전체 일치 → 추천 경로가 leaf 경로의 앞부분인 경우(토스 메시지가 leaf 이름을 줄여 쓸 때: "올리브유 > 엑스트라버진" vs
 * leaf "… > 엑스트라버진 올리브유") → 세그먼트 경계(" > ")를 지킨 뒤 2단 일치. 후보가 정확히 1개일 때만 반환.
 */
export function resolveLeafByPath(p) {
  const want = norm(p)
  if (!want) return null
  const leaves = loadFoodLeaves()
  const exact = leaves.find((l) => norm(l.path) === want)
  if (exact) return exact
  const segs = want.split(' > ')
  // 1) 부모 경로는 정확히 같고 leaf 이름만 앞부분이 일치 ("엑스트라버진" ⊂ "엑스트라버진 올리브유")
  if (segs.length >= 2) {
    const parent = segs.slice(0, -1).join(' > '), lastSeg = segs[segs.length - 1]
    const byLeafPrefix = leaves.filter((l) => { const n = norm(l.path); const cut = n.lastIndexOf(' > '); return cut > 0 && n.slice(0, cut) === parent && n.slice(cut + 3).startsWith(lastSeg) })
    if (byLeafPrefix.length === 1) return byLeafPrefix[0]
  }
  // 2) 추천 경로가 중간 카테고리(leaf 아님)인데 그 아래 leaf 가 하나뿐인 경우 — 세그먼트 경계(" > ")를 지킨 prefix
  const byAncestor = leaves.filter((l) => norm(l.path).startsWith(want + ' > '))
  if (byAncestor.length === 1) return byAncestor[0]
  // 3) 상위 경로 표기가 다를 때 — 마지막 2단만 경계를 지켜 일치
  const tail = segs.slice(-2).join(' > ')
  const byTail = leaves.filter((l) => { const n = norm(l.path); return n === tail || n.endsWith(' > ' + tail) })
  return byTail.length === 1 ? byTail[0] : null
}

/** 반려 사유 배열에서 "추천 카테고리: 식품 > … " 경로를 꺼낸다 (카테고리 불일치 반려 전용) */
export function parseRecommendedCategory(reasons) {
  for (const r of Array.isArray(reasons) ? reasons : []) {
    const text = `${r?.title ?? ''} ${r?.message ?? ''}`
    if (!/카테고리/.test(text)) continue
    const m = /추천 카테고리\s*:\s*([^\n]+)/.exec(text)
    if (m) return norm(m[1].replace(/[.。]\s*$/, ''))
  }
  return null
}
