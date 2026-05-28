#!/usr/bin/env node
/**
 * 와디즈·텀블벅 펀딩 성공 프로젝트 수집기 (KST 03:30 cron)
 *
 * - 마감된 프로젝트 메타(카테고리, 펀딩액, 달성률, 서포터수, 종료일)를 적재.
 * - 펀딩액 1억+ 또는 달성률 1000%+ → is_verified = true 마킹.
 * - 표가 jimscanner_crowdfunding_projects (supabase/crowdfunding.sql).
 *
 * 호출:
 *   node --env-file=.env.local scripts/wadiz-tumblbug-fetcher.mjs
 *
 * env:
 *   - NEXT_PUBLIC_SUPABASE_URL
 *   - SUPABASE_SERVICE_ROLE_KEY
 *
 * 주의:
 *   - 와디즈·텀블벅의 공개 listing/검색 API 를 호출하지만 두 사이트 모두
 *     로그인 없이 접근 가능한 공개 종료 프로젝트만 대상.
 *   - 응답 schema 가 바뀔 수 있어 try/catch + best-effort 파싱.
 *   - cron 무사고 우선 → 한 사이트 실패해도 다른 쪽은 계속.
 */

import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
  process.exit(1)
}

const sb = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false },
})

const VERIFY_AMOUNT_KRW = 100_000_000 // 1억
const VERIFY_RATE_PCT = 1000 // 1000%
const PAGE_LIMIT_PER_SOURCE = 5 // 한 회 호출에서 너무 많이 긁지 않도록

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'

function normalizeCategoryTop(raw) {
  if (!raw) return null
  const s = String(raw).toLowerCase()
  if (/(tech|디지털|가전|elec|모바일|음향|holo|drone|기기)/.test(s)) return 'digital'
  if (/(food|푸드|음식|간식|음료|beverage|coffee|tea)/.test(s)) return 'food'
  if (/(beauty|뷰티|코스메|cosme|skin|화장|메이크)/.test(s)) return 'beauty'
  if (/(fashion|패션|의류|시계|가방|쥬얼|jewel|shoe|악세)/.test(s)) return 'fashion'
  if (/(living|리빙|홈|home|주방|가구|침구|인테리어|문구|stationery)/.test(s)) return 'living'
  if (/(health|건강|운동|fitness|영양|보충)/.test(s)) return 'health'
  if (/(book|출판|publish|game|보드|toy|키덜트|취미|hobby|art|design|culture)/.test(s))
    return 'culture'
  return null
}

function verifyFlag({ funded_amount_krw, achievement_rate }) {
  const amt = funded_amount_krw >= VERIFY_AMOUNT_KRW
  const rate = (achievement_rate ?? 0) >= VERIFY_RATE_PCT
  if (amt && rate) return { is_verified: true, verified_reason: 'both' }
  if (amt) return { is_verified: true, verified_reason: 'amount_1e8' }
  if (rate) return { is_verified: true, verified_reason: 'rate_1000' }
  return { is_verified: false, verified_reason: null }
}

async function fetchJson(url, init = {}) {
  const res = await fetch(url, {
    ...init,
    headers: {
      'User-Agent': UA,
      Accept: 'application/json, text/plain, */*',
      'Accept-Language': 'ko-KR,ko;q=0.9,en;q=0.8',
      ...(init.headers ?? {}),
    },
  })
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`)
  const text = await res.text()
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`non-JSON response ${url}`)
  }
}

// ────────────────────────────────────────────────────────────
// 와디즈
// ────────────────────────────────────────────────────────────
async function fetchWadiz() {
  const rows = []
  // 와디즈 listing API (공개): order=recommend, status=end (종료)
  // schema 변동 가능 → best-effort.
  for (let page = 1; page <= PAGE_LIMIT_PER_SOURCE; page++) {
    const url = `https://service.wadiz.kr/api/funding/search?keyword=&order=recommend&endYn=Y&page=${page}&limit=30`
    try {
      const data = await fetchJson(url)
      const list = data?.data?.list ?? data?.list ?? []
      if (!Array.isArray(list) || list.length === 0) break
      for (const it of list) {
        const id = String(
          it.campaignId ?? it.projectId ?? it.id ?? it.campaign_id ?? '',
        )
        if (!id) continue
        const funded = Number(
          it.totalFundedAmount ?? it.fundingAmount ?? it.amount ?? 0,
        )
        const goal = Number(it.targetAmount ?? it.goalAmount ?? it.target ?? 0)
        const rate =
          Number(it.achievementRate ?? it.achievementRatio ?? it.rate ?? 0) ||
          (goal > 0 ? (funded / goal) * 100 : 0)
        const category = it.categoryName ?? it.category ?? null
        const project = {
          source: 'wadiz',
          source_project_id: id,
          title: it.title ?? it.campaignTitle ?? '(no title)',
          maker: it.makerName ?? it.makerId ?? null,
          category,
          category_top: normalizeCategoryTop(category),
          funded_amount_krw: Math.round(funded),
          goal_amount_krw: goal > 0 ? Math.round(goal) : null,
          achievement_rate: Math.round(rate * 10) / 10,
          supporter_count: Number(it.supporterCount ?? it.backerCount ?? 0) || null,
          started_at: it.startTime ?? it.startDate ?? null,
          ended_at: it.endTime ?? it.endDate ?? null,
          project_url: id ? `https://www.wadiz.kr/web/campaign/detail/${id}` : null,
          thumbnail_url: it.thumbnailUrl ?? it.mainImageUrl ?? null,
          raw: it,
        }
        if (!project.ended_at) continue
        rows.push(project)
      }
    } catch (err) {
      console.warn(`[wadiz] page=${page} fetch failed: ${err.message}`)
      break
    }
  }
  return rows
}

// ────────────────────────────────────────────────────────────
// 텀블벅
// ────────────────────────────────────────────────────────────
async function fetchTumblbug() {
  const rows = []
  for (let page = 1; page <= PAGE_LIMIT_PER_SOURCE; page++) {
    // 텀블벅 explore-projects API (공개): status=successful, page-based
    const url = `https://tumblbug.com/api/v3/discover/projects?status=successful&order=funded&page=${page}&per_page=30`
    try {
      const data = await fetchJson(url)
      const list = data?.projects ?? data?.data ?? data?.list ?? []
      if (!Array.isArray(list) || list.length === 0) break
      for (const it of list) {
        const id = String(it.id ?? it.projectId ?? it.short_url ?? '')
        if (!id) continue
        const funded = Number(it.funded_amount ?? it.fundedAmount ?? 0)
        const goal = Number(it.goal_amount ?? it.goalAmount ?? 0)
        const rate =
          Number(it.percent ?? it.achievement_rate ?? 0) ||
          (goal > 0 ? (funded / goal) * 100 : 0)
        const category = it.category_name ?? it.category?.name ?? it.category ?? null
        const project = {
          source: 'tumblbug',
          source_project_id: id,
          title: it.title ?? it.name ?? '(no title)',
          maker: it.creator?.name ?? it.user?.name ?? null,
          category,
          category_top: normalizeCategoryTop(category),
          funded_amount_krw: Math.round(funded),
          goal_amount_krw: goal > 0 ? Math.round(goal) : null,
          achievement_rate: Math.round(rate * 10) / 10,
          supporter_count: Number(it.supporter_count ?? it.backers_count ?? 0) || null,
          started_at: it.started_at ?? it.start_date ?? null,
          ended_at: it.ended_at ?? it.end_date ?? it.deadline ?? null,
          project_url: it.short_url
            ? `https://tumblbug.com/${it.short_url}`
            : `https://tumblbug.com/projects/${id}`,
          thumbnail_url: it.thumbnail_url ?? it.image_url ?? null,
          raw: it,
        }
        if (!project.ended_at) continue
        rows.push(project)
      }
    } catch (err) {
      console.warn(`[tumblbug] page=${page} fetch failed: ${err.message}`)
      break
    }
  }
  return rows
}

async function upsertRows(rows) {
  if (rows.length === 0) return 0
  const decorated = rows.map((r) => ({ ...r, ...verifyFlag(r) }))
  const { error } = await sb
    .from('jimscanner_crowdfunding_projects')
    .upsert(decorated, { onConflict: 'source,source_project_id' })
  if (error) {
    console.error('upsert failed', error)
    return 0
  }
  return decorated.length
}

async function logRun({ status, fetched, inserted, durationMs, errorMessage }) {
  await sb.from('jimscanner_trends_runs').insert({
    source: 'crowdfunding',
    status,
    fetched_count: fetched,
    inserted_count: inserted,
    duration_ms: durationMs,
    error_message: errorMessage ?? null,
    triggered_by: 'cli',
    finished_at: new Date().toISOString(),
  })
}

async function main() {
  const t0 = Date.now()
  let fetched = 0
  let inserted = 0
  let status = 'ok'
  let errorMessage = null
  try {
    const [wadizRows, tumblbugRows] = await Promise.all([fetchWadiz(), fetchTumblbug()])
    fetched = wadizRows.length + tumblbugRows.length
    inserted = await upsertRows([...wadizRows, ...tumblbugRows])
    if (fetched === 0) status = 'partial'
    console.log(
      `[crowdfunding] fetched=${fetched} inserted=${inserted} wadiz=${wadizRows.length} tumblbug=${tumblbugRows.length}`,
    )
  } catch (err) {
    status = 'error'
    errorMessage = err?.message ?? String(err)
    console.error('[crowdfunding] fatal', err)
  } finally {
    await logRun({
      status,
      fetched,
      inserted,
      durationMs: Date.now() - t0,
      errorMessage,
    })
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
