'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import {
  type ForwarderContent,
  type ListItem,
  type FaqItem,
  countContentChars,
  MIN_CONTENT_CHARS,
} from '@/lib/forwarder-content'
import {
  type ForwarderInfoSource,
  type InfoSourceType,
  INFO_SOURCE_TYPES,
  INFO_SOURCE_TYPE_LABELS,
} from '@/lib/forwarder-info-sources'

type Props = {
  forwarderName: string
  forwarderSlug: string
  forwarderWebsite: string | null
  initial: ForwarderContent
  initialInfoSources: ForwarderInfoSource[]
}

type InfoSourceRow = {
  source_type: InfoSourceType
  url: string
  label: string
  notes: string
  display_order: number
  is_active: boolean
  last_fetched_at: string | null
  last_fetch_status: string | null
}

function toInfoSourceRows(list: ForwarderInfoSource[]): InfoSourceRow[] {
  return list.map((s) => ({
    source_type: s.source_type,
    url: s.url,
    label: s.label ?? '',
    notes: s.notes ?? '',
    display_order: s.display_order,
    is_active: s.is_active,
    last_fetched_at: s.last_fetched_at,
    last_fetch_status: s.last_fetch_status,
  }))
}

type FormState = {
  overview: string
  strengths: ListItem[]
  weaknesses: ListItem[]
  service_features: ListItem[]
  pricing_notes: string
  recommended_for: string
  usage_tips: ListItem[]
  faq: FaqItem[]
  source_urls: string[]
}

function toState(c: ForwarderContent): FormState {
  return {
    overview: c.overview ?? '',
    strengths: c.strengths ?? [],
    weaknesses: c.weaknesses ?? [],
    service_features: c.service_features ?? [],
    pricing_notes: c.pricing_notes ?? '',
    recommended_for: c.recommended_for ?? '',
    usage_tips: c.usage_tips ?? [],
    faq: c.faq ?? [],
    source_urls: c.source_urls ?? [],
  }
}

export default function ContentEditor({
  forwarderName,
  forwarderSlug,
  forwarderWebsite,
  initial,
  initialInfoSources,
}: Props) {
  const router = useRouter()
  const [state, setState] = useState<FormState>(toState(initial))
  const [status, setStatus] = useState(initial.status)
  const [publishedAt, setPublishedAt] = useState(initial.published_at)
  const [updatedAt, setUpdatedAt] = useState(initial.updated_at)
  const [message, setMessage] = useState<{ type: 'success' | 'error' | 'info'; text: string } | null>(null)
  const [pending, startTransition] = useTransition()
  const [generating, setGenerating] = useState(false)
  const [infoSources, setInfoSources] = useState<InfoSourceRow[]>(toInfoSourceRows(initialInfoSources))
  const [infoSourcesSaving, setInfoSourcesSaving] = useState(false)
  const [infoSourcesMessage, setInfoSourcesMessage] = useState<{ type: 'success' | 'error' | 'info'; text: string } | null>(null)

  const chars = countContentChars(state)
  const tooShort = chars < MIN_CONTENT_CHARS

  function updateList<K extends 'strengths' | 'weaknesses' | 'service_features' | 'usage_tips'>(
    key: K,
    updater: (list: ListItem[]) => ListItem[],
  ) {
    setState((s) => ({ ...s, [key]: updater(s[key]) }))
  }

  function updateFaq(list: FaqItem[]) {
    setState((s) => ({ ...s, faq: list }))
  }

  async function apiCall(endpoint: string, body?: unknown) {
    const res = await fetch(`/api/admin/content/${forwarderSlug}/${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(data.error ?? `${endpoint} 실패`)
    return data
  }

  async function handleSave() {
    setMessage(null)
    try {
      const data = await apiCall('save', state)
      setStatus(data.content.status)
      setUpdatedAt(data.content.updated_at)
      setMessage({ type: 'success', text: '저장되었습니다 (드래프트)' })
    } catch (err) {
      setMessage({ type: 'error', text: err instanceof Error ? err.message : '오류' })
    }
  }

  async function handlePublish() {
    if (!confirm('지금 발행하면 프론트 페이지에 즉시 반영됩니다. 진행할까요?')) return
    setMessage(null)
    try {
      const data = await apiCall('publish', state)
      setStatus('published')
      setPublishedAt(data.content.published_at)
      setUpdatedAt(data.content.updated_at)
      setMessage({ type: 'success', text: '발행 완료 — 프론트에 반영되었습니다' })
      startTransition(() => router.refresh())
    } catch (err) {
      setMessage({ type: 'error', text: err instanceof Error ? err.message : '오류' })
    }
  }

  async function handleUnpublish() {
    if (!confirm('발행을 취소하면 프론트에서 콘텐츠가 숨겨집니다. 계속할까요?')) return
    setMessage(null)
    try {
      await apiCall('unpublish')
      setStatus('draft')
      setPublishedAt(null)
      setMessage({ type: 'info', text: '발행 취소됨 (드래프트 상태)' })
      startTransition(() => router.refresh())
    } catch (err) {
      setMessage({ type: 'error', text: err instanceof Error ? err.message : '오류' })
    }
  }

  async function handleSaveInfoSources() {
    setInfoSourcesMessage(null)
    setInfoSourcesSaving(true)
    try {
      const res = await fetch(`/api/admin/content/${forwarderSlug}/info-sources`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sources: infoSources }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error ?? '저장 실패')
      setInfoSources(toInfoSourceRows(data.sources ?? []))
      setInfoSourcesMessage({ type: 'success', text: `${(data.sources ?? []).length}개 저장됨` })
    } catch (err) {
      setInfoSourcesMessage({ type: 'error', text: err instanceof Error ? err.message : '오류' })
    } finally {
      setInfoSourcesSaving(false)
    }
  }

  async function handleGenerate() {
    if (
      state.overview &&
      !confirm('이미 내용이 있습니다. AI 초안으로 덮어쓰시겠어요? (취소 후 수동으로 덮어쓰는 게 안전합니다)')
    )
      return

    setGenerating(true)
    setMessage({ type: 'info', text: 'AI가 공식 사이트를 읽고 초안을 작성 중입니다 (최대 1분)…' })
    try {
      const data = await apiCall('generate-draft', { sourceUrl: forwarderWebsite })
      setState(toState(data.content))
      setStatus(data.content.status)
      setUpdatedAt(data.content.updated_at)
      setMessage({ type: 'success', text: 'AI 초안이 생성되었습니다. 내용을 검토·수정하고 발행해 주세요.' })
    } catch (err) {
      setMessage({ type: 'error', text: err instanceof Error ? err.message : '초안 생성 실패' })
    } finally {
      setGenerating(false)
    }
  }

  return (
    <div className="space-y-6">
      {/* 상단 상태 바 */}
      <div className="flex items-center justify-between flex-wrap gap-3 bg-white border rounded-lg p-4">
        <div className="flex items-center gap-3">
          <Badge className={status === 'published' ? 'bg-green-600' : 'bg-amber-500'}>
            {status === 'published' ? '발행됨' : '드래프트'}
          </Badge>
          <span className={`text-sm ${tooShort ? 'text-amber-600' : 'text-gray-600'}`}>
            {chars.toLocaleString()}자
            {tooShort && ` · 최소 ${MIN_CONTENT_CHARS.toLocaleString()}자 권장`}
          </span>
          {publishedAt && (
            <span className="text-xs text-gray-500">
              발행 {new Date(publishedAt).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })}
            </span>
          )}
          {updatedAt && (
            <span className="text-xs text-gray-500">
              수정 {new Date(updatedAt).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <Button
            variant="outline"
            size="sm"
            onClick={handleGenerate}
            disabled={generating || pending}
          >
            {generating ? '생성 중…' : '✨ AI 초안 생성'}
          </Button>
          <Button variant="outline" size="sm" onClick={handleSave} disabled={pending}>
            저장
          </Button>
          {status === 'published' ? (
            <Button
              size="sm"
              className="bg-red-600 hover:bg-red-700"
              onClick={handleUnpublish}
              disabled={pending}
            >
              발행 취소
            </Button>
          ) : (
            <Button
              size="sm"
              className="bg-green-600 hover:bg-green-700"
              onClick={handlePublish}
              disabled={pending}
            >
              발행
            </Button>
          )}
        </div>
      </div>

      {message && (
        <div
          className={`rounded-md px-4 py-2 text-sm border ${
            message.type === 'success'
              ? 'bg-green-50 border-green-100 text-green-700'
              : message.type === 'error'
                ? 'bg-red-50 border-red-100 text-red-700'
                : 'bg-blue-50 border-blue-100 text-blue-700'
          }`}
        >
          {message.text}
        </div>
      )}

      {/* 개요 */}
      <Section title="회사 소개 (Overview)" hint="설립, 본사, 규모, 핵심 서비스. 500~1000자 권장.">
        <textarea
          rows={6}
          value={state.overview}
          onChange={(e) => setState({ ...state, overview: e.target.value })}
          className="w-full border rounded-md p-3 text-sm font-sans leading-relaxed"
          placeholder={`${forwarderName}의 회사 소개를 작성하세요...`}
        />
      </Section>

      {/* 강점 */}
      <ListSection
        title="강점"
        hint="3~5개 정도. 각 항목에 제목과 2~3문장 설명."
        items={state.strengths}
        onChange={(list) => updateList('strengths', () => list)}
        colorHint="green"
      />

      {/* 약점 */}
      <ListSection
        title="약점 / 주의점"
        hint="2~3개 정도. 사용자가 알아야 할 단점이나 주의사항."
        items={state.weaknesses}
        onChange={(list) => updateList('weaknesses', () => list)}
        colorHint="red"
      />

      {/* 서비스 특징 */}
      <ListSection
        title="서비스 특징"
        hint="합포장, 검수, 재포장, 특수 서비스 등"
        items={state.service_features}
        onChange={(list) => updateList('service_features', () => list)}
      />

      {/* 요금 노트 */}
      <Section title="요금 체계 안내" hint="회원 등급, 할인 구조, 추가 수수료 등">
        <textarea
          rows={4}
          value={state.pricing_notes}
          onChange={(e) => setState({ ...state, pricing_notes: e.target.value })}
          className="w-full border rounded-md p-3 text-sm font-sans leading-relaxed"
          placeholder="요금 체계의 특징을 설명하세요..."
        />
      </Section>

      {/* 추천 대상 */}
      <Section title="이 배대지는 어떤 분에게?" hint="초보/고수, 소량/대량, 특정 쇼핑몰 유저 등">
        <textarea
          rows={3}
          value={state.recommended_for}
          onChange={(e) => setState({ ...state, recommended_for: e.target.value })}
          className="w-full border rounded-md p-3 text-sm font-sans leading-relaxed"
          placeholder="어떤 사용자 유형에게 적합한지..."
        />
      </Section>

      {/* 이용 팁 */}
      <ListSection
        title="이용 팁"
        hint="이 배대지를 활용하는 실전 노하우 3~5개"
        items={state.usage_tips}
        onChange={(list) => updateList('usage_tips', () => list)}
      />

      {/* FAQ */}
      <Section title={`${forwarderName} 특유 FAQ`} hint="이 배대지에만 해당되는 3~5개 Q&A">
        <FaqEditor items={state.faq} onChange={updateFaq} />
      </Section>

      {/* 출처 URL */}
      <Section title="참고한 출처 URL" hint="AI가 초안 생성에 사용한 페이지 목록">
        <SourceUrlsEditor
          urls={state.source_urls}
          onChange={(urls) => setState({ ...state, source_urls: urls })}
        />
      </Section>

      {/* 외부 정보 소스 — 파싱 파이프라인 입력 */}
      <section className="bg-white border rounded-lg p-5">
        <div className="flex items-start justify-between gap-3 mb-3 flex-wrap">
          <div>
            <h2 className="text-base font-semibold text-gray-900">외부 정보 소스</h2>
            <p className="text-xs text-gray-500 mt-1">
              배송비·부가서비스·공지사항·FAQ 페이지 URL을 타입별로 등록합니다. 향후 자동 페치/파싱의 입력으로 사용됩니다.
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={handleSaveInfoSources}
            disabled={infoSourcesSaving}
          >
            {infoSourcesSaving ? '저장 중…' : '소스 저장'}
          </Button>
        </div>

        {infoSourcesMessage && (
          <div
            className={`rounded-md px-3 py-2 text-xs border mb-3 ${
              infoSourcesMessage.type === 'success'
                ? 'bg-green-50 border-green-100 text-green-700'
                : infoSourcesMessage.type === 'error'
                  ? 'bg-red-50 border-red-100 text-red-700'
                  : 'bg-blue-50 border-blue-100 text-blue-700'
            }`}
          >
            {infoSourcesMessage.text}
          </div>
        )}

        <InfoSourcesEditor sources={infoSources} onChange={setInfoSources} />
      </section>
    </div>
  )
}

function InfoSourcesEditor({
  sources,
  onChange,
}: {
  sources: InfoSourceRow[]
  onChange: (next: InfoSourceRow[]) => void
}) {
  function update(i: number, patch: Partial<InfoSourceRow>) {
    const next = [...sources]
    next[i] = { ...next[i], ...patch }
    onChange(next)
  }

  function add(type: InfoSourceType) {
    onChange([
      ...sources,
      {
        source_type: type,
        url: '',
        label: '',
        notes: '',
        display_order: sources.filter((s) => s.source_type === type).length,
        is_active: true,
        last_fetched_at: null,
        last_fetch_status: null,
      },
    ])
  }

  function remove(i: number) {
    const item = sources[i]
    if (!confirm(`소스 "${item.url || '(URL 없음)'}" 를 목록에서 제거합니다. 저장하기 전엔 DB에 반영되지 않습니다.`)) return
    onChange(sources.filter((_, j) => j !== i))
  }

  return (
    <div className="space-y-3">
      {sources.length === 0 && (
        <p className="text-xs text-gray-400 italic">아직 등록된 소스가 없습니다. 아래 버튼으로 추가하세요.</p>
      )}
      {sources.map((s, i) => (
        <div key={i} className={`border rounded-md p-3 space-y-2 ${!s.is_active ? 'bg-gray-50 opacity-60' : ''}`}>
          <div className="flex items-center gap-2 flex-wrap">
            <select
              value={s.source_type}
              onChange={(e) => update(i, { source_type: e.target.value as InfoSourceType })}
              className="border rounded-md px-2 py-1 text-xs"
            >
              {INFO_SOURCE_TYPES.map((t) => (
                <option key={t} value={t}>
                  {INFO_SOURCE_TYPE_LABELS[t]}
                </option>
              ))}
            </select>
            <Input
              value={s.label}
              placeholder="라벨 (예: 미국 항공, CA 센터)"
              onChange={(e) => update(i, { label: e.target.value })}
              className="flex-1 min-w-[160px]"
            />
            <input
              type="number"
              value={s.display_order}
              onChange={(e) => update(i, { display_order: Number(e.target.value) || 0 })}
              className="border rounded-md px-2 py-1 text-xs w-16"
              title="정렬 순서"
            />
            <label className="text-xs text-gray-600 flex items-center gap-1 cursor-pointer">
              <input
                type="checkbox"
                checked={s.is_active}
                onChange={(e) => update(i, { is_active: e.target.checked })}
              />
              활성
            </label>
            <button
              type="button"
              className="text-xs text-red-600 hover:underline"
              onClick={() => remove(i)}
            >
              삭제
            </button>
          </div>
          <Input
            value={s.url}
            placeholder="https://..."
            onChange={(e) => update(i, { url: e.target.value })}
          />
          <textarea
            rows={2}
            value={s.notes}
            placeholder="파서 힌트 (예: 탭으로 국가 구분, JS 렌더 필요, 셀렉트박스로 센터 선택)"
            onChange={(e) => update(i, { notes: e.target.value })}
            className="w-full border rounded-md p-2 text-xs font-sans"
          />
          {(s.last_fetched_at || s.last_fetch_status) && (
            <p className="text-[11px] text-gray-500">
              {s.last_fetched_at && (
                <>마지막 페치 {new Date(s.last_fetched_at).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })}</>
              )}
              {s.last_fetch_status && <> · 상태 {s.last_fetch_status}</>}
            </p>
          )}
        </div>
      ))}
      <div className="flex flex-wrap gap-2 pt-2">
        {INFO_SOURCE_TYPES.map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => add(t)}
            className="text-xs text-blue-600 hover:underline"
          >
            + {INFO_SOURCE_TYPE_LABELS[t]} 추가
          </button>
        ))}
      </div>
    </div>
  )
}

function Section({
  title,
  hint,
  children,
}: {
  title: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <section className="bg-white border rounded-lg p-5">
      <h2 className="text-base font-semibold text-gray-900 mb-1">{title}</h2>
      {hint && <p className="text-xs text-gray-500 mb-3">{hint}</p>}
      {children}
    </section>
  )
}

function ListSection({
  title,
  hint,
  items,
  onChange,
  colorHint,
}: {
  title: string
  hint?: string
  items: ListItem[]
  onChange: (list: ListItem[]) => void
  colorHint?: 'green' | 'red'
}) {
  const badgeColor =
    colorHint === 'green'
      ? 'bg-green-100 text-green-700'
      : colorHint === 'red'
        ? 'bg-red-100 text-red-700'
        : 'bg-gray-100 text-gray-700'

  return (
    <Section title={title} hint={hint}>
      <div className="space-y-3">
        {items.map((item, i) => (
          <div key={i} className="border rounded-md p-3 space-y-2 relative group">
            <div className={`inline-block text-xs px-2 py-0.5 rounded-full ${badgeColor}`}>
              #{i + 1}
            </div>
            <Input
              value={item.title}
              placeholder="제목"
              onChange={(e) => {
                const next = [...items]
                next[i] = { ...item, title: e.target.value }
                onChange(next)
              }}
            />
            <textarea
              rows={2}
              value={item.description}
              placeholder="설명"
              onChange={(e) => {
                const next = [...items]
                next[i] = { ...item, description: e.target.value }
                onChange(next)
              }}
              className="w-full border rounded-md p-2 text-sm font-sans"
            />
            <button
              type="button"
              className="text-xs text-red-600 hover:underline"
              onClick={() => {
                if (!confirm(`항목 "${item.title || '(제목 없음)'}" 를 삭제합니다. 저장 후엔 되돌릴 수 없습니다.`)) return
                onChange(items.filter((_, j) => j !== i))
              }}
            >
              삭제
            </button>
          </div>
        ))}
        <button
          type="button"
          onClick={() => onChange([...items, { title: '', description: '' }])}
          className="text-sm text-blue-600 hover:underline"
        >
          + 항목 추가
        </button>
      </div>
    </Section>
  )
}

function FaqEditor({ items, onChange }: { items: FaqItem[]; onChange: (list: FaqItem[]) => void }) {
  return (
    <div className="space-y-3">
      {items.map((item, i) => (
        <div key={i} className="border rounded-md p-3 space-y-2">
          <Input
            value={item.question}
            placeholder="질문"
            onChange={(e) => {
              const next = [...items]
              next[i] = { ...item, question: e.target.value }
              onChange(next)
            }}
          />
          <textarea
            rows={3}
            value={item.answer}
            placeholder="답변"
            onChange={(e) => {
              const next = [...items]
              next[i] = { ...item, answer: e.target.value }
              onChange(next)
            }}
            className="w-full border rounded-md p-2 text-sm font-sans"
          />
          <button
            type="button"
            className="text-xs text-red-600 hover:underline"
            onClick={() => {
              if (!confirm(`Q&A "${item.question || '(질문 없음)'}" 를 삭제합니다. 저장 후엔 되돌릴 수 없습니다.`)) return
              onChange(items.filter((_, j) => j !== i))
            }}
          >
            삭제
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={() => onChange([...items, { question: '', answer: '' }])}
        className="text-sm text-blue-600 hover:underline"
      >
        + Q&A 추가
      </button>
    </div>
  )
}

function SourceUrlsEditor({
  urls,
  onChange,
}: {
  urls: string[]
  onChange: (urls: string[]) => void
}) {
  return (
    <div className="space-y-2">
      {urls.map((url, i) => (
        <div key={i} className="flex items-center gap-2">
          <Input
            value={url}
            onChange={(e) => {
              const next = [...urls]
              next[i] = e.target.value
              onChange(next)
            }}
            placeholder="https://..."
          />
          <button
            type="button"
            className="text-xs text-red-600 hover:underline whitespace-nowrap"
            onClick={() => {
              if (!confirm(`참고 URL "${url || '(비어있음)'}" 를 삭제합니다.`)) return
              onChange(urls.filter((_, j) => j !== i))
            }}
          >
            삭제
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={() => onChange([...urls, ''])}
        className="text-sm text-blue-600 hover:underline"
      >
        + URL 추가
      </button>
    </div>
  )
}
