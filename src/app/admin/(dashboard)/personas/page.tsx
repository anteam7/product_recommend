import type { Metadata } from 'next'
import { PERSONAS } from '@/lib/personas'
import PersonaWorkspace from '@/components/personas/PersonaWorkspace'

export const metadata: Metadata = { title: '팀 페르소나 | 셀러 관리자' }

export default function PersonasPage() {
  return <PersonaWorkspace personas={PERSONAS} />
}
