import { redirect } from 'next/navigation'

// personal 레포의 /admin 진입점은 위탁 발굴 대시보드로 직행.
// 본업 짐스캐너 대시보드(환율·admin-log 등)는 이 레포 정체성과 무관.
export default function AdminRoot() {
  redirect('/admin/trend-radar')
}
