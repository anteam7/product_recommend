// ─────────────────────────────────────────────────────────────
// 속성(수식어) 모멘텀 추출기 — _extract-modifiers.mjs (2026-06-03)
// ─────────────────────────────────────────────────────────────
// 트렌드 코퍼스(jimscanner_trends_aliases.alias + jimscanner_trends_products.canonical_name)에서
// 기능/형태 '수식어 토큰'(무선·접이식·대용량·충전식 등)을 룰 기반으로 추출,
// 최근 7일 vs 이전 7일 등장 비율(momentum_7d)을 계산해
// jimscanner_trends_modifiers 에 시계열 스냅샷으로 적재한다.
//
// 실행:  node scripts/_extract-modifiers.mjs
// (LLM 보강은 후속 — 현재는 결정적 룰 사전만으로 충분히 신호가 나옴)
// ─────────────────────────────────────────────────────────────
import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'

const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8')
    .split(/\r?\n/)
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => {
      const i = l.indexOf('=')
      let v = l.slice(i + 1).trim()
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
      return [l.slice(0, i).trim(), v]
    })
)
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY)

// ── 수식어(속성) 룰 사전 ──────────────────────────────────────
// canonical_form ← [표면형 동의어]. 토큰화가 아니라 표면형 매칭으로 한국어 어절 분해 회피.
const MODIFIER_RULES = [
  { canon: '무선', surfaces: ['무선', '코드리스', 'wireless'] },
  { canon: '충전식', surfaces: ['충전식', '충전', 'usb충전', '배터리'] },
  { canon: '접이식', surfaces: ['접이식', '폴딩', '폴더블', '접는', '접이'] },
  { canon: '대용량', surfaces: ['대용량', '초대용량', '특대'] },
  { canon: '미니', surfaces: ['미니', '소형', '초소형', '미니멀'] },
  { canon: '휴대용', surfaces: ['휴대용', '포터블', '휴대'] },
  { canon: '저소음', surfaces: ['저소음', '무소음', '정숙'] },
  { canon: '1인용', surfaces: ['1인용', '1인', '싱글', '혼자'] },
  { canon: '가열식', surfaces: ['가열식', '가열'] },
  { canon: '자동', surfaces: ['자동', '전자동', '오토'] },
  { canon: '방수', surfaces: ['방수', '생활방수', 'ip68', 'ip67'] },
  { canon: '고속', surfaces: ['고속', '급속', '쾌속'] },
  { canon: '초경량', surfaces: ['초경량', '경량', '가벼운'] },
  { canon: '대형', surfaces: ['대형', '와이드', '광폭'] },
  { canon: '무드등', surfaces: ['무드등', '조명', 'led'] },
  { canon: '온열', surfaces: ['온열', '발열', '히팅', '난방'] },
  { canon: '냉온', surfaces: ['냉온', '냉온풍', '쿨링'] },
  { canon: '항균', surfaces: ['항균', '살균', '제균', 'uv살균'] },
  { canon: '프리미엄', surfaces: ['프리미엄', '고급', '명품'] },
  { canon: '다용도', surfaces: ['다용도', '멀티', '다기능'] },
]

const CAT_FALLBACK = null // base_category 는 product.category_top 로 결정

function detectModifiers(text) {
  if (!text) return []
  const lower = String(text).toLowerCase().replace(/\s+/g, '')
  const hits = []
  for (const rule of MODIFIER_RULES) {
    if (rule.surfaces.some((s) => lower.includes(s.toLowerCase().replace(/\s+/g, '')))) {
      hits.push(rule.canon)
    }
  }
  return hits
}

const DAY = 24 * 60 * 60 * 1000

async function main() {
  // 1) 코퍼스 로드 — alias + product canonical
  const { data: prods, error: pe } = await sb
    .from('jimscanner_trends_products')
    .select('id, canonical_name, category_top, first_seen_at, last_seen_at')
  if (pe) throw pe
  const prodById = new Map((prods ?? []).map((p) => [p.id, p]))

  const { data: aliases, error: ae } = await sb
    .from('jimscanner_trends_aliases')
    .select('product_id, alias, created_at')
  if (ae) throw ae

  // 2) 코퍼스 = product 자체 + alias. 각 항목에 (text, productId, ts)
  const corpus = []
  for (const p of prods ?? []) {
    corpus.push({ text: p.canonical_name, productId: p.id, ts: p.last_seen_at, cat: p.category_top })
  }
  for (const a of aliases ?? []) {
    const p = prodById.get(a.product_id)
    corpus.push({ text: a.alias, productId: a.product_id, ts: a.created_at, cat: p?.category_top ?? null })
  }

  // 3) 수식어별 집계
  const now = Date.now()
  const win7 = now - 7 * DAY
  const win14 = now - 14 * DAY

  // key = `${canon}|||${cat}`
  const agg = new Map()
  for (const item of corpus) {
    const mods = detectModifiers(item.text)
    if (mods.length === 0) continue
    const t = item.ts ? new Date(item.ts).getTime() : 0
    for (const canon of mods) {
      const cat = item.cat ?? null
      const key = `${canon}|||${cat ?? ''}`
      let e = agg.get(key)
      if (!e) {
        e = { modifier: canon, base_category: cat, total: 0, recent7: 0, prev7: 0, products: new Set() }
        agg.set(key, e)
      }
      e.total += 1
      e.products.add(item.productId)
      if (t >= win7) e.recent7 += 1
      else if (t >= win14) e.prev7 += 1
    }
  }

  // 4) row 빌드
  const rows = []
  for (const e of agg.values()) {
    const momentum = e.prev7 > 0 ? e.recent7 / e.prev7 : e.recent7 > 0 ? 2.0 : 0
    rows.push({
      modifier: e.modifier,
      base_category: e.base_category,
      occurrence_count: e.total,
      momentum_7d: Number(momentum.toFixed(3)),
      sample_product_ids: [...e.products].slice(0, 20),
    })
  }

  if (rows.length === 0) {
    console.log('수식어 매칭 0건 — 코퍼스 부족 또는 룰 미스. 종료.')
    process.exit(0)
  }

  const { error: ie } = await sb.from('jimscanner_trends_modifiers').insert(rows)
  if (ie) throw ie

  rows.sort((a, b) => b.momentum_7d - a.momentum_7d)
  console.log(`✓ ${rows.length}개 수식어 스냅샷 적재`)
  for (const r of rows.slice(0, 12)) {
    console.log(`  ${r.modifier.padEnd(8)} [${r.base_category ?? 'all'}]  n=${r.occurrence_count}  m7d=${r.momentum_7d}`)
  }
  process.exit(0)
}

main().catch((e) => {
  console.error('실패:', e.message ?? e)
  process.exit(1)
})
