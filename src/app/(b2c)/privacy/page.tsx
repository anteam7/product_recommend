import { Metadata } from 'next'
import { Badge } from '@/components/ui/badge'

export const metadata: Metadata = {
  title: '개인정보처리방침',
  description:
    '짐스캐너의 개인정보 수집·이용·보관·제3자 제공·위탁 현황과 이용자 권리를 안내합니다.',
  alternates: {
    canonical: 'https://jimscanner.co.kr/privacy',
  },
  robots: {
    index: true,
    follow: true,
  },
}

const EFFECTIVE_DATE = '2026년 4월 23일'

export default function PrivacyPage() {
  return (
    <div className="py-12 px-4">
      <div className="container mx-auto max-w-3xl">
        <div className="mb-10">
          <Badge className="mb-3">법적 고지</Badge>
          <h1 className="text-3xl sm:text-4xl font-bold text-gray-900 mb-3">
            개인정보처리방침
          </h1>
          <p className="text-sm text-gray-500">
            시행일: {EFFECTIVE_DATE}
          </p>
        </div>

        <div className="bg-blue-50 border border-blue-100 rounded-lg p-5 mb-10 text-sm text-blue-900 leading-relaxed">
          짐스캐너(이하 &ldquo;서비스&rdquo;)는 이용자의 개인정보를 소중하게 생각하며,{' '}
          <strong>「개인정보 보호법」</strong> 등 관련 법령을 준수합니다. 짐스캐너는 일반 이용자에게
          회원가입·로그인 기능을 요구하지 않으며(운영자 전용 관리 페이지는 별도 관리),
          서비스 이용 과정에서 수집하는 정보는 아래와 같이 최소한으로 제한됩니다.
        </div>

        {/* 1. 처리 목적 */}
        <section className="mb-10">
          <h2 className="text-xl font-bold text-gray-900 mb-3 pb-2 border-b">
            1. 개인정보의 처리 목적
          </h2>
          <p className="text-sm text-gray-600 leading-relaxed mb-3">
            짐스캐너는 다음의 목적을 위해 개인정보를 처리하며, 이 목적 외의 용도로는 이용하지 않습니다.
            처리 목적이 변경되는 경우에는 사전에 동의를 받거나 법령에 따라 필요한 조치를 이행합니다.
          </p>
          <ul className="list-disc list-inside text-sm text-gray-600 space-y-1.5 pl-2">
            <li>서비스 제공 및 이용 통계 분석</li>
            <li>이메일을 통한 문의·제보 응대 및 회신</li>
            <li>
              <strong>잘못된 정보 신고</strong> 접수·검토·정정 및 처리 결과 회신
            </li>
            <li>서비스 품질 개선 및 신규 기능 개발을 위한 이용 현황 분석</li>
            <li>
              제3자 광고 네트워크(Google AdSense 등)를 통한 <strong>맞춤형 광고 제공</strong> 및 광고 성과
              측정 <span className="text-xs text-gray-500">(도입 시점에 적용)</span>
            </li>
            <li>신고 어뷰즈·부정 이용 방지 및 보안 사고 대응</li>
          </ul>
        </section>

        {/* 2. 처리 항목 */}
        <section className="mb-10">
          <h2 className="text-xl font-bold text-gray-900 mb-3 pb-2 border-b">
            2. 수집하는 개인정보 항목 및 수집 방법
          </h2>
          <div className="space-y-4 text-sm text-gray-600 leading-relaxed">
            <div className="border rounded-lg p-4">
              <p className="font-semibold text-gray-900 mb-2">가. 자동 수집 항목 (이용 통계)</p>
              <ul className="list-disc list-inside space-y-1 pl-2">
                <li>IP 주소, 쿠키, 브라우저/기기 정보, 접속 일시, 접속 경로</li>
                <li>서비스 이용 기록(방문 페이지, 체류 시간, 클릭 이벤트 등)</li>
                <li>수집 방법: 웹사이트 접속 시 Google Analytics 4, Vercel Analytics를 통해 자동 수집</li>
              </ul>
            </div>
            <div className="border rounded-lg p-4">
              <p className="font-semibold text-gray-900 mb-2">
                나. 광고 관련 자동 수집 항목 <span className="text-xs text-gray-500 font-normal">(Google AdSense 등 제3자 광고 네트워크 도입 시)</span>
              </p>
              <ul className="list-disc list-inside space-y-1 pl-2">
                <li>광고 쿠키(DoubleClick 쿠키 포함), 광고 식별자</li>
                <li>광고 노출·클릭 이력, 대략적인 위치(국가·도시 수준), 관심사 추정 정보</li>
                <li>수집 방법: Google AdSense 태그 및 제3자 광고 네트워크의 쿠키</li>
              </ul>
              <p className="mt-2 text-xs text-gray-500">
                제3자 공급업체(Google 포함)는 쿠키를 사용하여 이용자의 과거 방문 기록에 기반한 광고를 게재할
                수 있습니다.
              </p>
            </div>
            <div className="border rounded-lg p-4">
              <p className="font-semibold text-gray-900 mb-2">다. 이용자가 직접 제공하는 항목 (문의·제보 시)</p>
              <ul className="list-disc list-inside space-y-1 pl-2">
                <li>이메일 주소, 문의 내용(선택적으로 이름 등)</li>
                <li>수집 방법: somonday@gmail.com으로의 이메일 수신</li>
              </ul>
            </div>
            <div id="reports" className="border rounded-lg p-4 scroll-mt-20">
              <p className="font-semibold text-gray-900 mb-2">
                라. 잘못된 정보 신고(서비스 내 폼) 제출 시
              </p>
              <ul className="list-disc list-inside space-y-1 pl-2">
                <li>
                  <strong>필수</strong>: 신고 대상(페이지 URL·항목), 문제 유형, 상세 설명
                </li>
                <li>
                  <strong>선택</strong>: 올바른 정보, 근거 URL, 처리 결과 회신용 이메일 주소
                </li>
                <li>
                  <strong>자동 수집</strong>: IP 주소, 브라우저(User-Agent) 정보, 제출 시각 —
                  스팸·어뷰즈 방지 및 레이트리밋 목적으로 한정 사용
                </li>
                <li>
                  수집 방법: 공개 페이지에 노출되는 신고 버튼을 통한 직접 입력
                </li>
                <li>
                  이메일은 수집·이용 동의를 체크한 경우에만 저장되며, 신고 처리 결과 회신 목적에만
                  사용됩니다.
                </li>
              </ul>
            </div>
            <p>
              짐스캐너는 회원가입 절차가 없으며, 이름·전화번호·주민등록번호 등 식별 정보를 별도로 수집하지
              않습니다.
            </p>
          </div>
        </section>

        {/* 3. 보유 기간 */}
        <section className="mb-10">
          <h2 className="text-xl font-bold text-gray-900 mb-3 pb-2 border-b">
            3. 개인정보의 보유 및 이용 기간
          </h2>
          <div className="overflow-x-auto">
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr className="bg-gray-50 border-b">
                  <th className="text-left px-3 py-2 font-semibold text-gray-900">구분</th>
                  <th className="text-left px-3 py-2 font-semibold text-gray-900">보유 기간</th>
                </tr>
              </thead>
              <tbody className="text-gray-600">
                <tr className="border-b">
                  <td className="px-3 py-2">접속 로그, 이용 통계 (GA4·Vercel)</td>
                  <td className="px-3 py-2">해당 서비스 정책에 따름 (GA4 기본 최대 14개월)</td>
                </tr>
                <tr className="border-b">
                  <td className="px-3 py-2">이메일 문의 기록</td>
                  <td className="px-3 py-2">처리 완료 후 1년 이내 파기</td>
                </tr>
                <tr className="border-b">
                  <td className="px-3 py-2">
                    신고 기록 — 이메일
                  </td>
                  <td className="px-3 py-2">
                    신고 처리 완료 후 90일 이내 파기
                  </td>
                </tr>
                <tr className="border-b">
                  <td className="px-3 py-2">
                    신고 기록 — IP·UA 등 접속 정보
                  </td>
                  <td className="px-3 py-2">
                    어뷰즈 이력 분석 위해 최대 1년 보관 후 파기 (차단 IP는 별도 최대 3년)
                  </td>
                </tr>
                <tr className="border-b">
                  <td className="px-3 py-2">
                    신고 기록 — 대상·내용·처리 결과
                  </td>
                  <td className="px-3 py-2">
                    서비스 정보 이력 관리 목적으로 영구 보관(식별정보는 상단 기준으로 분리 파기)
                  </td>
                </tr>
                <tr>
                  <td className="px-3 py-2">법령상 보관 의무 정보</td>
                  <td className="px-3 py-2">관련 법령에 규정된 기간</td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>

        {/* 4. 제3자 제공 */}
        <section className="mb-10">
          <h2 className="text-xl font-bold text-gray-900 mb-3 pb-2 border-b">
            4. 개인정보의 제3자 제공
          </h2>
          <p className="text-sm text-gray-600 leading-relaxed">
            짐스캐너는 이용자의 개인정보를 <strong className="text-gray-900">원칙적으로 외부에 제공하지
            않습니다.</strong> 다만, 아래의 경우는 예외로 합니다.
          </p>
          <ul className="list-disc list-inside text-sm text-gray-600 space-y-1.5 pl-2 mt-3">
            <li>이용자가 사전에 동의한 경우</li>
            <li>법령의 규정에 의거하거나, 수사 기관의 요구가 있는 경우</li>
          </ul>
        </section>

        {/* 5. 처리 위탁 */}
        <section className="mb-10">
          <h2 className="text-xl font-bold text-gray-900 mb-3 pb-2 border-b">
            5. 개인정보 처리 위탁
          </h2>
          <p className="text-sm text-gray-600 leading-relaxed mb-3">
            짐스캐너는 원활한 서비스 제공을 위해 아래의 업체에 개인정보 처리를 위탁하고 있습니다.
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr className="bg-gray-50 border-b">
                  <th className="text-left px-3 py-2 font-semibold text-gray-900">수탁업체</th>
                  <th className="text-left px-3 py-2 font-semibold text-gray-900">위탁 업무</th>
                </tr>
              </thead>
              <tbody className="text-gray-600">
                <tr className="border-b">
                  <td className="px-3 py-2">Vercel Inc.</td>
                  <td className="px-3 py-2">웹 호스팅, 서버 로그 처리, Vercel Analytics</td>
                </tr>
                <tr className="border-b">
                  <td className="px-3 py-2">Google LLC</td>
                  <td className="px-3 py-2">
                    Google Analytics 4, Search Console 통계 (Google AdSense 도입 시 광고 게재·성과 측정 추가 예정)
                  </td>
                </tr>
                <tr className="border-b">
                  <td className="px-3 py-2">Supabase Inc. (서울 리전)</td>
                  <td className="px-3 py-2">요금 데이터베이스 호스팅</td>
                </tr>
                <tr>
                  <td className="px-3 py-2">네이버 금융</td>
                  <td className="px-3 py-2">
                    매매기준율 환율 데이터 조회 (개인정보 미전송 — 서버 간 공개 페이지 조회)
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <p className="text-xs text-gray-500 mt-3 leading-relaxed">
            Vercel·Google의 서버는 미국 등 해외에 위치할 수 있으며, 이용자 정보가 인터넷 회선을 통해 국외로
            이전될 수 있습니다.
          </p>
        </section>

        {/* 6. 쿠키 */}
        <section className="mb-10">
          <h2 className="text-xl font-bold text-gray-900 mb-3 pb-2 border-b">
            6. 쿠키(Cookie)의 운용
          </h2>
          <div className="space-y-3 text-sm text-gray-600 leading-relaxed">
            <p>
              짐스캐너는 서비스 이용 통계 수집을 위해 쿠키를 사용합니다. 쿠키는 웹사이트 서버가 이용자의
              브라우저에 전송하는 소량의 정보이며, 이용자의 하드디스크에 저장됩니다.
            </p>
            <p>
              이용자는 브라우저 설정에서 쿠키 저장을 거부할 수 있습니다. 다만, 쿠키 저장을 거부할 경우 일부
              서비스 기능의 이용에 제약이 있을 수 있습니다.
            </p>
            <div className="bg-gray-50 rounded-lg p-4 text-xs">
              <p className="font-medium text-gray-900 mb-1">쿠키 설정 방법</p>
              <ul className="space-y-1 text-gray-600">
                <li>Chrome: 설정 &gt; 개인정보 및 보안 &gt; 쿠키 및 기타 사이트 데이터</li>
                <li>Safari: 환경설정 &gt; 개인정보 보호 &gt; 쿠키 및 웹사이트 데이터</li>
                <li>Edge: 설정 &gt; 쿠키 및 사이트 권한 &gt; 쿠키 및 저장된 데이터 관리</li>
              </ul>
            </div>
            <div className="bg-gray-50 rounded-lg p-4 text-xs space-y-1">
              <p className="font-medium text-gray-900 mb-1">맞춤형 광고 거부(Opt-out) 방법</p>
              <ul className="space-y-1 text-gray-600">
                <li>
                  Google 광고 설정:{' '}
                  <a
                    href="https://adssettings.google.com"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-blue-600 hover:underline"
                  >
                    adssettings.google.com
                  </a>
                </li>
                <li>
                  제3자 광고 네트워크 일괄 거부 (미국·유럽 사업자 대부분):{' '}
                  <a
                    href="https://optout.aboutads.info/"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-blue-600 hover:underline"
                  >
                    optout.aboutads.info
                  </a>
                </li>
                <li>
                  Network Advertising Initiative:{' '}
                  <a
                    href="https://optout.networkadvertising.org/"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-blue-600 hover:underline"
                  >
                    optout.networkadvertising.org
                  </a>
                </li>
              </ul>
            </div>
          </div>
        </section>

        {/* 7. 이용자 권리 */}
        <section className="mb-10">
          <h2 className="text-xl font-bold text-gray-900 mb-3 pb-2 border-b">
            7. 이용자의 권리와 행사 방법
          </h2>
          <p className="text-sm text-gray-600 leading-relaxed mb-3">
            이용자는 짐스캐너에 대해 언제든지 다음과 같은 권리를 행사할 수 있습니다.
          </p>
          <ul className="list-disc list-inside text-sm text-gray-600 space-y-1.5 pl-2">
            <li>개인정보 열람 요구</li>
            <li>오류 정정 요구</li>
            <li>삭제 요구</li>
            <li>처리 정지 요구</li>
          </ul>
          <p className="text-sm text-gray-600 leading-relaxed mt-3">
            권리 행사는 아래 개인정보 보호책임자에게 서면, 전자우편 등으로 요청하실 수 있으며, 짐스캐너는
            이에 대해 지체 없이 조치하겠습니다.
          </p>
        </section>

        {/* 8. 파기 */}
        <section className="mb-10">
          <h2 className="text-xl font-bold text-gray-900 mb-3 pb-2 border-b">
            8. 개인정보의 파기
          </h2>
          <p className="text-sm text-gray-600 leading-relaxed">
            짐스캐너는 개인정보의 보유 기간이 경과하거나 처리 목적이 달성된 경우 지체 없이 해당 정보를
            파기합니다. 전자적 파일 형태는 복구·재생이 불가능한 방법으로 영구 삭제하며, 종이 문서는 분쇄하거나
            소각 처리합니다.
          </p>
        </section>

        {/* 9. 안전성 확보 조치 */}
        <section className="mb-10">
          <h2 className="text-xl font-bold text-gray-900 mb-3 pb-2 border-b">
            9. 개인정보의 안전성 확보 조치
          </h2>
          <ul className="list-disc list-inside text-sm text-gray-600 space-y-1.5 pl-2">
            <li>HTTPS 전 구간 암호화 통신</li>
            <li>관리자 계정 접근 권한 최소화 (현재 운영자 1인)</li>
            <li>외부 위탁 서비스(Supabase·Vercel·Google)의 보안 인증 정책 준수</li>
          </ul>
        </section>

        {/* 10. 보호책임자 */}
        <section className="mb-10">
          <h2 className="text-xl font-bold text-gray-900 mb-3 pb-2 border-b">
            10. 개인정보 보호책임자
          </h2>
          <div className="bg-blue-50 border border-blue-100 rounded-lg p-5 text-sm text-gray-700">
            <p className="font-semibold text-gray-900 mb-2">개인정보 보호책임자</p>
            <ul className="space-y-1">
              <li>구분: 짐스캐너 운영자</li>
              <li>
                이메일:{' '}
                <a
                  href="mailto:somonday@gmail.com"
                  className="text-blue-600 hover:underline font-medium"
                >
                  somonday@gmail.com
                </a>
              </li>
            </ul>
            <p className="text-xs text-gray-500 mt-3 leading-relaxed">
              개인정보 관련 문의, 불만 처리, 피해 구제 등에 관한 사항을 위 이메일로 연락해 주시면 지체 없이
              답변·처리해 드리겠습니다.
            </p>
          </div>
        </section>

        {/* 11. 권익 침해 구제 */}
        <section className="mb-10">
          <h2 className="text-xl font-bold text-gray-900 mb-3 pb-2 border-b">
            11. 권익 침해 구제 방법
          </h2>
          <p className="text-sm text-gray-600 leading-relaxed mb-3">
            개인정보 침해에 대한 신고나 상담이 필요한 경우 아래 기관에 문의하실 수 있습니다.
          </p>
          <ul className="list-disc list-inside text-sm text-gray-600 space-y-1.5 pl-2">
            <li>개인정보침해신고센터 (privacy.kisa.or.kr / 국번없이 118)</li>
            <li>개인정보분쟁조정위원회 (kopico.go.kr / 1833-6972)</li>
            <li>대검찰청 사이버수사과 (spo.go.kr / 국번없이 1301)</li>
            <li>경찰청 사이버수사국 (ecrm.police.go.kr / 국번없이 182)</li>
          </ul>
        </section>

        {/* 12. 변경 고지 */}
        <section className="mb-10">
          <h2 className="text-xl font-bold text-gray-900 mb-3 pb-2 border-b">
            12. 개인정보처리방침의 변경
          </h2>
          <p className="text-sm text-gray-600 leading-relaxed">
            본 개인정보처리방침은 시행일로부터 적용되며, 법령 및 방침에 따른 변경 내용의 추가·삭제·수정이 있는
            경우에는 변경 사항 시행 최소 7일 전부터 공지합니다.
          </p>
        </section>

        {/* 변경 이력 */}
        <section className="mb-10">
          <h2 className="text-xl font-bold text-gray-900 mb-3 pb-2 border-b">
            개인정보처리방침 변경 이력
          </h2>
          <div className="overflow-x-auto">
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr className="bg-gray-50 border-b">
                  <th className="text-left px-3 py-2 font-semibold text-gray-900">버전</th>
                  <th className="text-left px-3 py-2 font-semibold text-gray-900">시행일</th>
                  <th className="text-left px-3 py-2 font-semibold text-gray-900">주요 변경 내용</th>
                </tr>
              </thead>
              <tbody className="text-gray-600">
                <tr className="border-b">
                  <td className="px-3 py-2">v1.1</td>
                  <td className="px-3 py-2">2026년 4월 23일</td>
                  <td className="px-3 py-2">
                    사용자 신고 기능 도입에 따라 수집 항목·보유 기간·이용 목적 추가
                  </td>
                </tr>
                <tr>
                  <td className="px-3 py-2">v1.0</td>
                  <td className="px-3 py-2">2026년 4월 19일</td>
                  <td className="px-3 py-2">최초 제정</td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>

        <div className="bg-gray-50 border border-gray-200 rounded-lg p-5 text-sm text-gray-600 mt-12">
          <p className="font-semibold text-gray-900 mb-1">시행일자</p>
          <p>본 방침은 <strong>{EFFECTIVE_DATE}</strong>부터 시행됩니다.</p>
        </div>
      </div>
    </div>
  )
}
