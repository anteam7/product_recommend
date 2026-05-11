export type ForwarderContentStatus = 'draft' | 'published'

export type ListItem = {
  title: string
  description: string
}

export type FaqItem = {
  question: string
  answer: string
}

export type ForwarderContent = {
  forwarder_id: string
  status: ForwarderContentStatus
  overview: string | null
  strengths: ListItem[]
  weaknesses: ListItem[]
  service_features: ListItem[]
  pricing_notes: string | null
  recommended_for: string | null
  usage_tips: ListItem[]
  faq: FaqItem[]
  source_urls: string[]
  created_by: string | null
  reviewed_by: string | null
  created_at: string
  updated_at: string
  published_at: string | null
}

export type ForwarderContentInput = Partial<Omit<ForwarderContent,
  'forwarder_id' | 'created_at' | 'updated_at' | 'published_at' | 'status'
>>

export function countContentChars(c: Partial<ForwarderContent>): number {
  let total = 0
  const addText = (s?: string | null) => { if (s) total += s.length }
  const addList = (list?: ListItem[]) => {
    if (!list) return
    for (const item of list) {
      total += (item.title?.length ?? 0) + (item.description?.length ?? 0)
    }
  }
  const addFaq = (list?: FaqItem[]) => {
    if (!list) return
    for (const item of list) {
      total += (item.question?.length ?? 0) + (item.answer?.length ?? 0)
    }
  }
  addText(c.overview)
  addList(c.strengths)
  addList(c.weaknesses)
  addList(c.service_features)
  addText(c.pricing_notes)
  addText(c.recommended_for)
  addList(c.usage_tips)
  addFaq(c.faq)
  return total
}

export const MIN_CONTENT_CHARS = 1500

export function emptyContentInput(): ForwarderContentInput {
  return {
    overview: '',
    strengths: [],
    weaknesses: [],
    service_features: [],
    pricing_notes: '',
    recommended_for: '',
    usage_tips: [],
    faq: [],
    source_urls: [],
  }
}
