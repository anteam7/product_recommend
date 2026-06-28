import WorkConsole from './WorkConsole'

export const dynamic = 'force-dynamic'

export default function WorkConsolePage() {
  return (
    <div className="space-y-4 p-4 max-w-2xl mx-auto">
      <header>
        <h1 className="text-xl font-bold">🛰️ 작업 콘솔</h1>
        <p className="text-sm text-gray-500 mt-1">
          어디서나 작업을 지시하면 로컬 에이전트가 자율 실행하고, 진행을 로그로 남기며, 결정이 필요하면 여기로 확인을 요청합니다.
        </p>
        <p className="text-[11px] text-gray-400 mt-1">
          ※ 실행기 <code>work-agent.mjs</code> 가 PC에 떠 있어야 처리됩니다. 위험·되돌릴 수 없는 행동(등록·가격변경·커밋 등)은 자동 에스컬레이션됩니다.
        </p>
      </header>
      <WorkConsole />
    </div>
  )
}
