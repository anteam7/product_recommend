import { Metadata } from 'next'
import Link from 'next/link'
import { Badge } from '@/components/ui/badge'

export const metadata: Metadata = {
  title: '이용약관',
  description:
    '짐스캐너 서비스 이용에 관한 약관입니다. 서비스 제공 범위, 이용자의 의무, 책임 제한, 면책 사항 등을 안내합니다.',
  alternates: {
    canonical: 'https://jimscanner.co.kr/terms',
  },
  robots: {
    index: true,
    follow: true,
  },
}

const EFFECTIVE_DATE = '2026년 4월 19일'

export default function TermsPage() {
  return (
    <div className="py-12 px-4">
      <div className="container mx-auto max-w-3xl">
        <div className="mb-10">
          <Badge className="mb-3">법적 고지</Badge>
          <h1 className="text-3xl sm:text-4xl font-bold text-gray-900 mb-3">이용약관</h1>
          <p className="text-sm text-gray-500">시행일: {EFFECTIVE_DATE}</p>
        </div>

        <div className="bg-blue-50 border border-blue-100 rounded-lg p-5 mb-10 text-sm text-blue-900 leading-relaxed">
          본 약관은 짐스캐너(이하 &ldquo;서비스&rdquo;)가 제공하는 배송대행지(배대지) 요금 비교 정보 서비스의
          이용 조건과 절차, 이용자와 운영자 간의 권리·의무 및 책임 사항을 규정합니다. 짐스캐너는{' '}
          <strong>정보 제공 서비스</strong>이며, 배송대행 서비스를 직접 제공하지 않습니다.
        </div>

        {/* 1. 목적 */}
        <section className="mb-10">
          <h2 className="text-xl font-bold text-gray-900 mb-3 pb-2 border-b">
            제1조 (목적)
          </h2>
          <p className="text-sm text-gray-600 leading-relaxed">
            본 약관은 이용자가 짐스캐너가 제공하는 배대지 요금 비교 정보 서비스를 이용함에 있어 이용자와
            운영자의 권리·의무 및 책임 사항, 기타 필요한 사항을 규정함을 목적으로 합니다.
          </p>
        </section>

        {/* 2. 용어 정의 */}
        <section className="mb-10">
          <h2 className="text-xl font-bold text-gray-900 mb-3 pb-2 border-b">
            제2조 (용어의 정의)
          </h2>
          <p className="text-sm text-gray-600 leading-relaxed mb-3">
            본 약관에서 사용하는 용어의 정의는 다음과 같습니다.
          </p>
          <ol className="text-sm text-gray-600 space-y-2 pl-2">
            <li>
              <strong className="text-gray-900">1. &ldquo;서비스&rdquo;</strong>란 짐스캐너(
              <Link href="/" className="text-blue-600 hover:underline">www.jimscanner.co.kr</Link>
              )가 제공하는 배송대행지 요금 비교, 계산, 가이드 등 모든 정보 제공 서비스를 의미합니다.
            </li>
            <li>
              <strong className="text-gray-900">2. &ldquo;이용자&rdquo;</strong>란 본 약관에 따라 서비스에
              접속하여 이를 이용하는 모든 개인 및 법인을 의미합니다.
            </li>
            <li>
              <strong className="text-gray-900">3. &ldquo;배대지&rdquo;</strong>란 해외 현지에 위치하여 상품을
              수령하고 국내로 배송해 주는 제3의 배송대행 사업자를 의미합니다.
            </li>
            <li>
              <strong className="text-gray-900">4. &ldquo;요금 정보&rdquo;</strong>란 서비스가 제공하는 각
              배대지의 배송비 및 부대 요금에 관한 비교 데이터를 의미합니다.
            </li>
          </ol>
        </section>

        {/* 3. 약관 효력 */}
        <section className="mb-10">
          <h2 className="text-xl font-bold text-gray-900 mb-3 pb-2 border-b">
            제3조 (약관의 효력 및 변경)
          </h2>
          <ol className="text-sm text-gray-600 space-y-2 pl-2 leading-relaxed">
            <li>
              1. 본 약관은 서비스 내 공지를 통해 이용자에게 공시함으로써 효력이 발생합니다.
            </li>
            <li>
              2. 운영자는 관련 법령을 위배하지 않는 범위 내에서 본 약관을 개정할 수 있으며, 개정된 약관은
              적용일자 7일 전부터 서비스 내에 공지합니다. 다만, 이용자에게 불리한 변경의 경우에는 30일 전에
              공지합니다.
            </li>
            <li>
              3. 이용자가 변경된 약관에 동의하지 않을 경우 서비스 이용을 중단할 수 있으며, 변경된 약관의
              효력 발생일 이후에도 서비스를 계속 이용하는 경우 약관의 변경에 동의한 것으로 간주합니다.
            </li>
          </ol>
        </section>

        {/* 4. 서비스 제공 */}
        <section className="mb-10">
          <h2 className="text-xl font-bold text-gray-900 mb-3 pb-2 border-b">
            제4조 (서비스의 제공)
          </h2>
          <p className="text-sm text-gray-600 leading-relaxed mb-3">
            짐스캐너가 제공하는 서비스는 다음과 같습니다.
          </p>
          <ul className="list-disc list-inside text-sm text-gray-600 space-y-1.5 pl-2">
            <li>국가별(미국·일본·중국 등) 배대지 요금 비교 및 순위 정보</li>
            <li>무게·부피 기반 배송비 자동 계산 기능</li>
            <li>배대지별 상세 정보 및 특징 요약</li>
            <li>해외직구·통관·절세에 관한 가이드 콘텐츠</li>
            <li>기타 운영자가 필요하다고 판단하는 부가 정보 서비스</li>
          </ul>
        </section>

        {/* 5. 서비스 이용 */}
        <section className="mb-10">
          <h2 className="text-xl font-bold text-gray-900 mb-3 pb-2 border-b">
            제5조 (서비스의 이용)
          </h2>
          <ol className="text-sm text-gray-600 space-y-2 pl-2 leading-relaxed">
            <li>
              1. 짐스캐너는 별도의 회원가입 절차 없이 누구나 무료로 이용할 수 있는 공개 서비스입니다.
            </li>
            <li>
              2. 서비스 이용 시간은 연중무휴, 1일 24시간을 원칙으로 합니다. 다만, 정기 점검·긴급 조치가 필요한
              경우에는 일시적으로 중단될 수 있습니다.
            </li>
            <li>
              3. 운영자는 사전 공지 없이 서비스의 내용을 변경하거나 중단할 수 있으며, 이로 인한 이용자의
              불편에 대해 본 약관 제9조의 책임 제한 범위 내에서 책임을 집니다.
            </li>
          </ol>
        </section>

        {/* 6. 이용자 의무 */}
        <section className="mb-10">
          <h2 className="text-xl font-bold text-gray-900 mb-3 pb-2 border-b">
            제6조 (이용자의 의무)
          </h2>
          <p className="text-sm text-gray-600 leading-relaxed mb-3">
            이용자는 다음 각 호에 해당하는 행위를 하여서는 안 됩니다.
          </p>
          <ul className="list-disc list-inside text-sm text-gray-600 space-y-1.5 pl-2">
            <li>서비스의 정상적인 운영을 방해하는 행위</li>
            <li>서비스에 게시된 정보를 허위로 변조하거나 무단 복제·배포하는 행위</li>
            <li>자동화된 수단(크롤러, 봇 등)으로 과도한 트래픽을 발생시키는 행위</li>
            <li>타인의 권리를 침해하거나 법령을 위반하는 행위</li>
            <li>기타 공공질서 및 미풍양속에 반하는 행위</li>
          </ul>
        </section>

        {/* 7. 지적재산권 */}
        <section className="mb-10">
          <h2 className="text-xl font-bold text-gray-900 mb-3 pb-2 border-b">
            제7조 (지적재산권)
          </h2>
          <ol className="text-sm text-gray-600 space-y-2 pl-2 leading-relaxed">
            <li>
              1. 서비스에 포함된 콘텐츠(텍스트, 그래픽, 로고, 데이터베이스 등)의 저작권 및 지적재산권은
              짐스캐너 운영자에게 귀속됩니다. 단, 각 배대지의 상호·로고·공식 요금표는 해당 사업자의 재산이며,
              짐스캐너는 이를 정보 비교 목적으로 인용·가공하여 사용합니다.
            </li>
            <li>
              2. 이용자는 서비스를 통해 얻은 정보를 운영자의 사전 승낙 없이 영리 목적으로 복제·전송·출판·배포
              등의 방법으로 이용할 수 없습니다.
            </li>
            <li>
              3. 개인적·비영리적 용도의 열람과 참고는 자유롭게 허용됩니다.
            </li>
          </ol>
        </section>

        {/* 8. 정보 정확성과 면책 */}
        <section className="mb-10">
          <h2 className="text-xl font-bold text-gray-900 mb-3 pb-2 border-b">
            제8조 (정보의 정확성 및 면책)
          </h2>
          <div className="space-y-3 text-sm text-gray-600 leading-relaxed">
            <p>
              짐스캐너는 각 배대지가 공식적으로 공개한 요금표를 기준으로 정보를 수집·정리하여 제공합니다.
              다만, 다음과 같은 한계가 있음을 명확히 고지합니다.
            </p>
            <ul className="list-disc list-inside space-y-1.5 pl-2">
              <li>요금 정보는 수집 시점의 데이터이며, 각 배대지의 내부 사정·프로모션·환율 변동에 따라 실제 요금과 차이가 있을 수 있습니다.</li>
              <li>회원 등급, 쿠폰, 시즌 할인 등은 각 배대지별 정책에 따라 별도 적용되어 표시 금액과 다를 수 있습니다.</li>
              <li>환율은 주기적으로 갱신되나, 실시간 환율과 완전히 일치하지 않을 수 있습니다.</li>
            </ul>
            <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 text-amber-900">
              <strong>최종 요금·서비스 조건은 반드시 각 배대지 공식 사이트에서 확인</strong>하시기 바랍니다.
              짐스캐너는 표시된 정보와 실제 요금의 차이로 발생하는 어떠한 손실에 대해서도 책임지지 않습니다.
            </div>
          </div>
        </section>

        {/* 9. 책임 제한 */}
        <section className="mb-10">
          <h2 className="text-xl font-bold text-gray-900 mb-3 pb-2 border-b">
            제9조 (책임 제한)
          </h2>
          <p className="text-sm text-gray-600 leading-relaxed mb-3">
            짐스캐너는 다음 각 호의 사항에 대해 책임을 지지 않습니다.
          </p>
          <ol className="text-sm text-gray-600 space-y-2 pl-2 leading-relaxed">
            <li>
              1. 짐스캐너는 배송대행 서비스를 직접 제공하지 않습니다. 실제 배송 계약은{' '}
              <strong className="text-gray-900">이용자와 해당 배대지 사업자 간에 체결</strong>되며,
              배송 과정에서 발생하는 사고, 분실, 파손, 지연, 통관 문제 등에 대해 짐스캐너는 책임지지
              않습니다.
            </li>
            <li>
              2. 짐스캐너는 특정 배대지와 독점 계약이나 제휴 관계를 맺고 있지 않으며, 서비스에 표시된 순위는
              수집된 공개 요금 데이터에 기반한 참고용 정보입니다. 이용자의 개별 조건에 따른 최적 선택을
              보장하지 않습니다.
            </li>
            <li>
              3. 천재지변, 전쟁, 서비스 제공자의 귀책사유가 없는 네트워크 장애, 해킹, 기타 불가항력으로
              인하여 서비스를 제공할 수 없는 경우 책임이 면제됩니다.
            </li>
            <li>
              4. 이용자가 서비스에서 얻은 정보를 기반으로 결정한 선택 및 행위의 결과에 대해 짐스캐너는
              책임지지 않습니다.
            </li>
            <li>
              5. 외부 링크(배대지 공식 사이트 등)를 통해 접속한 외부 서비스의 콘텐츠 및 약관은 짐스캐너의
              관리 범위를 벗어나며, 이에 대한 책임을 지지 않습니다.
            </li>
          </ol>
        </section>

        {/* 10. 개인정보 */}
        <section className="mb-10">
          <h2 className="text-xl font-bold text-gray-900 mb-3 pb-2 border-b">
            제10조 (개인정보의 보호)
          </h2>
          <p className="text-sm text-gray-600 leading-relaxed">
            짐스캐너는 이용자의 개인정보를 중요하게 생각하며, 관련 법령에 따라 보호합니다. 개인정보의 수집,
            이용, 보관, 파기에 관한 구체적인 사항은{' '}
            <Link href="/privacy" className="text-blue-600 hover:underline font-medium">
              개인정보처리방침
            </Link>
            을 참고해 주시기 바랍니다.
          </p>
        </section>

        {/* 11. 광고 및 제휴 */}
        <section className="mb-10">
          <h2 className="text-xl font-bold text-gray-900 mb-3 pb-2 border-b">
            제11조 (광고 및 제휴)
          </h2>
          <ol className="text-sm text-gray-600 space-y-2 pl-2 leading-relaxed">
            <li>
              1. 짐스캐너는 현재 특정 배대지와 독점 계약이나 제휴 관계를 맺고 있지 않으며, 순위는 오직 공개된
              요금 데이터에 기반합니다.
            </li>
            <li>
              2. 향후 제휴 마케팅(어필리에이트) 프로그램을 도입하는 경우, 해당 사실을 서비스 내에 명확히
              표시하며 제휴 여부가 순위·비교 결과에 영향을 미치지 않도록 운영합니다.
            </li>
          </ol>
        </section>

        {/* 12. 분쟁 해결 */}
        <section className="mb-10">
          <h2 className="text-xl font-bold text-gray-900 mb-3 pb-2 border-b">
            제12조 (분쟁의 해결)
          </h2>
          <ol className="text-sm text-gray-600 space-y-2 pl-2 leading-relaxed">
            <li>
              1. 서비스 이용과 관련하여 이용자와 운영자 간에 발생한 분쟁은 상호 협의를 통해 원만하게 해결함을
              원칙으로 합니다.
            </li>
            <li>
              2. 협의가 이루어지지 않을 경우, 본 약관은 대한민국 법령에 따라 규율되며, 분쟁에 관한 소는
              민사소송법상의 관할법원에 제기합니다.
            </li>
          </ol>
        </section>

        {/* 13. 문의 */}
        <section className="mb-10">
          <h2 className="text-xl font-bold text-gray-900 mb-3 pb-2 border-b">
            제13조 (문의 및 연락처)
          </h2>
          <div className="bg-blue-50 border border-blue-100 rounded-lg p-5 text-sm text-gray-700">
            <p className="text-gray-700 mb-2 leading-relaxed">
              본 약관과 관련한 문의, 의견, 오류 제보, 제휴 문의 등은 아래로 연락해 주시기 바랍니다.
            </p>
            <ul className="space-y-1">
              <li>운영: 짐스캐너 (1인 개발 독립 서비스)</li>
              <li>
                이메일:{' '}
                <a
                  href="mailto:somonday@gmail.com"
                  className="text-blue-600 hover:underline font-medium"
                >
                  somonday@gmail.com
                </a>
              </li>
              <li>
                웹사이트:{' '}
                <Link href="/" className="text-blue-600 hover:underline">
                  www.jimscanner.co.kr
                </Link>
              </li>
            </ul>
          </div>
        </section>

        <div className="bg-gray-50 border border-gray-200 rounded-lg p-5 text-sm text-gray-600 mt-12">
          <p className="font-semibold text-gray-900 mb-1">부칙</p>
          <p>본 약관은 <strong>{EFFECTIVE_DATE}</strong>부터 시행됩니다.</p>
        </div>
      </div>
    </div>
  )
}
