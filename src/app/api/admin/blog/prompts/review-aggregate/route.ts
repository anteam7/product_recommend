import { NextResponse, type NextRequest } from 'next/server'
import { createClient, isAdminEmail } from '@/lib/auth/server'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import type { ReviewEntry, ReviewFinding } from '@/lib/blog'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// 사람이 검수해서 프롬프트에 반영할 후보 데이터를 모아 보여준다.
// 두 소스: 수동 AI 검토(jimscanner_blog_post_reviews) + 파이프라인 자동 검토(blog_posts.review_history JSON 배열).
// 자동 반영은 절대 하지 않는다 — 출력은 사람의 다음 단계(suggest-improvement) 입력이 될 뿐.

type Period = '7d' | '30d' | '90d' | 'all'
type Source = 'manual' | 'pipeline' | 'both'

type IssueFreq = { issue: string; count: number }

type ManualPerspectiveSummary = {
  perspective: string
  total_reviews: number
  issues: IssueFreq[]
  suggestions: IssueFreq[]
}

type PipelineAxis = 'seo' | 'traffic_potential' | 'ctr_potential' | 'facts' | 'human_likeness'

type PipelineAxisSummary = {
  axis: PipelineAxis
  avg_score: number | null
  sample_count: number
  issues: IssueFreq[]
  suggestions: IssueFreq[]
}

function topN(map: Map<string, number>, n: number): IssueFreq[] {
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([issue, count]) => ({ issue, count }))
}

function tally(map: Map<string, number>, items: string[] | undefined) {
  if (!items) return
  for (const it of items) {
    if (typeof it !== 'string') continue
    const norm = it.trim()
    if (!norm) continue
    map.set(norm, (map.get(norm) ?? 0) + 1)
  }
}

async function requireAdmin() {
  const sb = await createClient()
  const {
    data: { user },
  } = await sb.auth.getUser()
  if (!user || !isAdminEmail(user.email)) return null
  return user
}

export async function POST(request: NextRequest) {
  const user = await requireAdmin()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = (await request.json().catch(() => ({}))) as {
    period?: unknown
    perspectives?: unknown
    applied_only?: unknown
    sources?: unknown
    exclude_already_derived?: unknown
    top_n?: unknown
  }

  const period: Period =
    body.period === '7d' || body.period === '30d' || body.period === '90d' || body.period === 'all'
      ? body.period
      : '30d'
  const perspectivesFilter = Array.isArray(body.perspectives)
    ? (body.perspectives as unknown[])
        .filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
        .map((p) => p.trim())
    : []
  const appliedOnly = body.applied_only !== false
  const sources: Source =
    body.sources === 'manual' || body.sources === 'pipeline' ? body.sources : 'both'
  const excludeDerived = body.exclude_already_derived !== false
  const topN_ = Math.min(Math.max(typeof body.top_n === 'number' ? body.top_n : 15, 5), 30)

  const sinceIso =
    period === 'all'
      ? null
      : new Date(
          Date.now() - { '7d': 7, '30d': 30, '90d': 90 }[period] * 86400_000,
        ).toISOString()

  const admin = createAdminClient()

  // 이미 어느 prompt 버전에라도 반영된 review id 합집합
  const alreadyDerived = new Set<string>()
  if (excludeDerived) {
    const { data: prompts } = await admin
      .from('jimscanner_blog_generation_prompts')
      .select('derived_from_review_ids')
    for (const p of (prompts ?? []) as { derived_from_review_ids: string[] | null }[]) {
      for (const id of p.derived_from_review_ids ?? []) alreadyDerived.add(id)
    }
  }

  // ───────────── 수동 검토 집계 ─────────────
  const manualSummaries: ManualPerspectiveSummary[] = []
  const manualUsedIds: string[] = []

  if (sources === 'manual' || sources === 'both') {
    let q = admin
      .from('jimscanner_blog_post_reviews')
      .select('id, created_at, perspectives, findings, applied, reverted_at')
      .order('created_at', { ascending: false })
    if (sinceIso) q = q.gte('created_at', sinceIso)
    if (appliedOnly) q = q.eq('applied', true).is('reverted_at', null)

    const { data: rows } = await q
    type Row = {
      id: string
      findings: ReviewFinding[] | null
    }
    const filtered = ((rows ?? []) as Row[]).filter((r) => !alreadyDerived.has(r.id))

    type Bucket = {
      issuesMap: Map<string, number>
      sugMap: Map<string, number>
      count: number
    }
    const byPerspective = new Map<string, Bucket>()
    for (const r of filtered) {
      manualUsedIds.push(r.id)
      const findings = (r.findings ?? []) as ReviewFinding[]
      for (const f of findings) {
        if (!f || typeof f.perspective !== 'string') continue
        if (perspectivesFilter.length > 0 && !perspectivesFilter.includes(f.perspective)) continue
        let bucket = byPerspective.get(f.perspective)
        if (!bucket) {
          bucket = { issuesMap: new Map(), sugMap: new Map(), count: 0 }
          byPerspective.set(f.perspective, bucket)
        }
        bucket.count++
        tally(bucket.issuesMap, f.issues)
        tally(bucket.sugMap, f.suggestions)
      }
    }
    for (const [persp, b] of byPerspective) {
      manualSummaries.push({
        perspective: persp,
        total_reviews: b.count,
        issues: topN(b.issuesMap, topN_),
        suggestions: topN(b.sugMap, topN_),
      })
    }
    manualSummaries.sort((a, b) => b.total_reviews - a.total_reviews)
  }

  // ───────────── 파이프라인 검토 집계 ─────────────
  const pipelineSummaries: PipelineAxisSummary[] = []
  let pipelineSampleCount = 0

  if (sources === 'pipeline' || sources === 'both') {
    const { data: posts } = await admin
      .from('jimscanner_blog_posts')
      .select('slug, review_history')
      .not('review_history', 'is', null)

    const axes: PipelineAxis[] = [
      'seo',
      'traffic_potential',
      'ctr_potential',
      'facts',
      'human_likeness',
    ]

    type Acc = {
      axis: PipelineAxis
      sumScore: number
      countScore: number
      issuesMap: Map<string, number>
      sugMap: Map<string, number>
    }
    const accMap = new Map<PipelineAxis, Acc>()
    for (const a of axes)
      accMap.set(a, { axis: a, sumScore: 0, countScore: 0, issuesMap: new Map(), sugMap: new Map() })

    for (const post of (posts ?? []) as { review_history: ReviewEntry[] | null }[]) {
      const history = post.review_history ?? []
      for (const entry of history) {
        if (!entry || typeof entry !== 'object') continue
        if (sinceIso && typeof entry.tick_at === 'string' && entry.tick_at < sinceIso) continue
        pipelineSampleCount++

        if (entry.scores) {
          for (const a of axes) {
            const score = entry.scores[a]
            if (typeof score === 'number' && Number.isFinite(score)) {
              const acc = accMap.get(a)!
              acc.sumScore += score
              acc.countScore++
            }
          }
        }
        if (entry.seo) {
          tally(accMap.get('seo')!.issuesMap, entry.seo.issues)
          tally(accMap.get('seo')!.sugMap, entry.seo.suggestions)
        }
        if (entry.traffic_potential) {
          tally(accMap.get('traffic_potential')!.issuesMap, entry.traffic_potential.issues)
          tally(accMap.get('traffic_potential')!.sugMap, entry.traffic_potential.suggestions)
        }
        if (entry.ctr_potential) {
          tally(accMap.get('ctr_potential')!.sugMap, entry.ctr_potential.suggestions)
        }
        if (entry.facts) {
          tally(accMap.get('facts')!.sugMap, entry.facts.suggestions)
          if (Array.isArray(entry.facts.incorrect_claims)) {
            for (const c of entry.facts.incorrect_claims) {
              if (c && typeof c.quote === 'string') {
                const k = c.quote.trim()
                if (k) {
                  const m = accMap.get('facts')!.issuesMap
                  m.set(k, (m.get(k) ?? 0) + 1)
                }
              }
            }
          }
        }
        if (entry.human_likeness) {
          tally(accMap.get('human_likeness')!.issuesMap, entry.human_likeness.ai_patterns_found)
          tally(accMap.get('human_likeness')!.sugMap, entry.human_likeness.suggestions)
        }
      }
    }

    for (const a of axes) {
      const acc = accMap.get(a)!
      pipelineSummaries.push({
        axis: a,
        avg_score: acc.countScore > 0 ? +(acc.sumScore / acc.countScore).toFixed(2) : null,
        sample_count: acc.countScore,
        issues: topN(acc.issuesMap, topN_),
        suggestions: topN(acc.sugMap, topN_),
      })
    }
  }

  return NextResponse.json({
    filters: {
      period,
      perspectives: perspectivesFilter,
      applied_only: appliedOnly,
      sources,
      exclude_already_derived: excludeDerived,
      top_n: topN_,
    },
    manual: {
      perspectives: manualSummaries,
      used_review_ids: manualUsedIds,
      total_reviews: manualUsedIds.length,
    },
    pipeline: {
      axes: pipelineSummaries,
      sample_count: pipelineSampleCount,
    },
  })
}
