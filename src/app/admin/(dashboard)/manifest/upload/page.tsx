import type { Metadata } from 'next'
import UploadForm from './UploadForm'

export const metadata: Metadata = {
  title: '매니페스트 업로드 | 관리자',
  robots: { index: false, follow: false },
}

export const dynamic = 'force-dynamic'

export default function Page() {
  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-bold">매니페스트 업로드</h1>
        <p className="mt-1 text-sm text-gray-600">
          ACI 통관 매니페스트 엑셀을 업로드하면 PII 컬럼을 자동 제거하고{' '}
          <code className="rounded bg-gray-100 px-1">jimscanner_manifest_items</code> 에 적재합니다.
          적재 후 카테고리·브랜드별 무게 분포가 자동 재집계됩니다.
        </p>
      </header>

      <div className="rounded-lg border bg-amber-50 p-4 text-sm text-amber-900">
        <p className="font-semibold">⚠️ 주의사항</p>
        <ul className="mt-2 ml-4 list-disc space-y-1">
          <li>
            <strong>한 파일 = 한 국가 / 한 운송수단 / 한 창고</strong>. 여러 국가가 섞인 파일은
            먼저 분리해서 업로드해 주세요.
          </li>
          <li>권장: <strong>5,000행 / 5MB 미만</strong>. 보통 1주치 분량.</li>
          <li>
            PII 컬럼 (수취인·주민번호·주소·전화번호·메모·송장번호 평문) 은 <strong>읽지도 저장하지도 않습니다</strong>.
            송장번호는 SHA256 해시로만 그룹화됩니다.
          </li>
          <li>같은 파일을 다시 업로드해도 자동으로 중복 제거됩니다 (해시 dedup).</li>
        </ul>
      </div>

      <UploadForm />
    </div>
  )
}
