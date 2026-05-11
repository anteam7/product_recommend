import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Forwarder, type ReviewSentiment } from '@/types'
import ForwarderCardLink from '@/components/analytics/ForwarderCardLink'
import ExternalLink from '@/components/analytics/ExternalLink'
import LastVerifiedBadge from '@/components/forwarder/LastVerifiedBadge'

interface ForwarderCardProps {
  forwarder: Forwarder
  minPrice?: number | null
  country?: string
  lastVerifiedAt?: string | null
  reviewSentiment?: ReviewSentiment | null
  reviewCount?: number | null
}

const SENTIMENT_BADGE: Record<ReviewSentiment, { bg: string; text: string; emoji: string; short: string }> = {
  '긍정 우세': { bg: 'bg-green-50', text: 'text-green-700', emoji: '🟢', short: '긍정' },
  '혼재': { bg: 'bg-amber-50', text: 'text-amber-700', emoji: '🟡', short: '혼재' },
  '부정 우세': { bg: 'bg-red-50', text: 'text-red-700', emoji: '🔴', short: '부정' },
  '데이터 없음': { bg: 'bg-gray-50', text: 'text-gray-500', emoji: '⚪️', short: '후기 부족' },
}

export default function ForwarderCard({ forwarder, minPrice, country, lastVerifiedAt, reviewSentiment, reviewCount }: ForwarderCardProps) {
  const sentimentBadge = reviewSentiment ? SENTIMENT_BADGE[reviewSentiment] : null
  const showReviewBadge = !!sentimentBadge && (reviewCount ?? 0) > 0
  return (
    <Card className="hover:shadow-lg transition-shadow h-full flex flex-col">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between">
          <CardTitle className="text-lg">
            <ForwarderCardLink
              slug={forwarder.slug}
              href={`/forwarders/${forwarder.slug}`}
              source="list_card_title"
              className="hover:text-blue-600 transition-colors"
            >
              {forwarder.name}
            </ForwarderCardLink>
          </CardTitle>
          {minPrice && (
            <div className="text-right">
              <p className="text-xs text-gray-500">{country} 최저</p>
              <p className="text-sm font-bold text-blue-600">{minPrice.toLocaleString()}원~</p>
            </div>
          )}
        </div>
      </CardHeader>

      <CardContent className="flex-1 space-y-3">
        <div className="flex flex-wrap items-center gap-1.5">
          {lastVerifiedAt && <LastVerifiedBadge at={lastVerifiedAt} size="xs" />}
          {showReviewBadge && (
            <span
              className={`inline-flex items-center gap-1 text-[11px] font-medium px-1.5 py-0.5 rounded ${sentimentBadge.bg} ${sentimentBadge.text}`}
              title={`외부 후기 ${reviewCount}건 — ${reviewSentiment}`}
            >
              <span>{sentimentBadge.emoji}</span>
              후기 {reviewCount} · {sentimentBadge.short}
            </span>
          )}
        </div>

        {forwarder.description && (
          <p className="text-sm text-gray-600 line-clamp-2">{forwarder.description}</p>
        )}

        {forwarder.pros && forwarder.pros.length > 0 && (
          <div>
            <p className="text-xs font-medium text-gray-500 mb-1">장점</p>
            <div className="flex flex-wrap gap-1">
              {forwarder.pros.slice(0, 3).map((pro, i) => (
                <Badge key={i} variant="secondary" className="text-xs bg-green-50 text-green-700">
                  {pro}
                </Badge>
              ))}
            </div>
          </div>
        )}

        {forwarder.features && forwarder.features.length > 0 && (
          <div>
            <p className="text-xs font-medium text-gray-500 mb-1">주요 기능</p>
            <div className="flex flex-wrap gap-1">
              {forwarder.features.slice(0, 2).map((feature, i) => (
                <Badge key={i} variant="outline" className="text-xs">
                  {feature}
                </Badge>
              ))}
            </div>
          </div>
        )}
      </CardContent>

      <CardFooter className="pt-3 gap-2">
        <Button variant="outline" size="sm" className="flex-1" asChild>
          <ForwarderCardLink
            slug={forwarder.slug}
            href={`/forwarders/${forwarder.slug}`}
            source="list_card_cta"
          >
            자세히 보기
          </ForwarderCardLink>
        </Button>
        {forwarder.website && (
          <Button variant="default" size="sm" className="flex-1 bg-blue-600 hover:bg-blue-700" asChild>
            <ExternalLink
              href={forwarder.website}
              context={forwarder.slug}
              source="list_card_external"
            >
              사이트 방문
            </ExternalLink>
          </Button>
        )}
      </CardFooter>
    </Card>
  )
}
