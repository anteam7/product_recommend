import type { Metadata } from 'next'
import { SCENARIOS } from '@/lib/scenarios'
import ScenarioWorkspace from '@/components/scenarios/ScenarioWorkspace'

export const metadata: Metadata = { title: '팀 작업 시나리오 | 셀러 관리자' }

export default function ScenariosPage() {
  return <ScenarioWorkspace scenarios={SCENARIOS} />
}
