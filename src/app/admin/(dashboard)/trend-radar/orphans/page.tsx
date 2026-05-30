import { createClient } from "@/lib/supabase/server";
import { Card } from "@/components/ui/card";
import Link from "next/link";
import { PromoteButton } from "./_components/PromoteButton";

export const dynamic = "force-dynamic";

type SparkPoint = { d: string; c: number };

type OrphanRow = {
  keyword: string;
  occurrences: number;
  source_count: number;
  sources: string[] | null;
  velocity: number;
  top_intent: string | null;
  promotion_score: number;
  spark: SparkPoint[] | null;
  last_seen_at: string | null;
};

const DAYS = 30;

const SOURCE_LABEL: Record<string, string> = {
  naver_tvtime: "TV홈쇼핑",
  naver_shopping: "네이버쇼핑",
  naver_datalab: "데이터랩",
  google_trends: "구글",
  youtube: "유튜브",
};

function Sparkline({ data }: { data: SparkPoint[] }) {
  if (!data || data.length === 0) {
    return <span className="text-xs text-muted-foreground">—</span>;
  }
  const w = 96;
  const h = 24;
  const vals = data.map((p) => Number(p.c) || 0);
  const max = Math.max(...vals, 1);
  const n = vals.length;
  const pts = vals
    .map((v, i) => {
      const x = n === 1 ? w : (i / (n - 1)) * w;
      const y = h - (v / max) * (h - 2) - 1;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg width={w} height={h} className="overflow-visible">
      <polyline
        points={pts}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        className="text-emerald-500"
      />
    </svg>
  );
}

function whyMissed(row: OrphanRow): string {
  if (row.source_count <= 1) {
    return "단일 소스 수집 — 교차 검증 부족으로 canonicalization 미실행";
  }
  if (row.velocity > 0) {
    return "최근 급상승 — 매핑 룰/LLM 분류가 아직 못 따라잡음";
  }
  return "별칭(alias) 미생성 — product 집합에 한 번도 편입되지 않음";
}

export default async function OrphansPage() {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc(
    "jimscanner_orphan_keywords" as never,
    { days: DAYS, lim: 50 } as never,
  );

  const rows: OrphanRow[] = (data as OrphanRow[]) ?? [];
  const err = error?.message ?? null;

  return (
    <div className="space-y-6 p-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold">미발굴 키워드 승격 보드</h1>
          <p className="text-sm text-muted-foreground">
            canonical product 로 한 번도 매핑되지 않은 고수요 키워드 (최근 {DAYS}
            일, commercial/transactional). 승격하면 다음 recompute부터 4점수·기회
            사분면에 편입됩니다.
          </p>
        </div>
        <Link
          href="/admin/trend-radar"
          className="shrink-0 text-sm text-muted-foreground hover:underline"
        >
          ← 레이더
        </Link>
      </div>

      {err && (
        <Card className="border-red-300 bg-red-50 p-4 text-sm text-red-700">
          RPC 오류: {err}
        </Card>
      )}

      <div className="grid grid-cols-3 gap-4">
        <Card className="p-4">
          <div className="text-xs text-muted-foreground">미발굴 키워드</div>
          <div className="text-3xl font-bold text-rose-600">{rows.length}</div>
        </Card>
        <Card className="p-4">
          <div className="text-xs text-muted-foreground">상승세 (velocity&gt;0)</div>
          <div className="text-3xl font-bold text-emerald-600">
            {rows.filter((r) => Number(r.velocity) > 0).length}
          </div>
        </Card>
        <Card className="p-4">
          <div className="text-xs text-muted-foreground">다중 소스 교차</div>
          <div className="text-3xl font-bold text-amber-600">
            {rows.filter((r) => Number(r.source_count) > 1).length}
          </div>
        </Card>
      </div>

      <Card className="overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-left">
            <tr>
              <th className="px-4 py-2">키워드</th>
              <th className="px-4 py-2">추세</th>
              <th className="px-4 py-2">소스</th>
              <th className="px-4 py-2 text-right">등장</th>
              <th className="px-4 py-2 text-right">속도</th>
              <th className="px-4 py-2 text-right">승격점수</th>
              <th className="px-4 py-2">왜 누락됐나</th>
              <th className="px-4 py-2 text-right">액션</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && !err && (
              <tr>
                <td
                  colSpan={8}
                  className="px-4 py-8 text-center text-muted-foreground"
                >
                  미발굴 키워드가 없습니다. (모든 고수요 키워드가 매핑됨)
                </td>
              </tr>
            )}
            {rows.map((r) => (
              <tr key={r.keyword} className="border-t align-top">
                <td className="px-4 py-3 font-medium">
                  {r.keyword}
                  {r.top_intent && (
                    <span className="ml-2 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-600">
                      {r.top_intent}
                    </span>
                  )}
                </td>
                <td className="px-4 py-3 text-emerald-600">
                  <Sparkline data={r.spark ?? []} />
                </td>
                <td className="px-4 py-3">
                  <div className="flex flex-wrap gap-1">
                    {(r.sources ?? []).map((s) => (
                      <span
                        key={s}
                        className="rounded-full bg-indigo-50 px-2 py-0.5 text-[10px] font-medium text-indigo-700"
                      >
                        {SOURCE_LABEL[s] ?? s}
                      </span>
                    ))}
                  </div>
                </td>
                <td className="px-4 py-3 text-right tabular-nums">
                  {r.occurrences}
                </td>
                <td
                  className={
                    "px-4 py-3 text-right tabular-nums " +
                    (Number(r.velocity) > 0
                      ? "text-emerald-600"
                      : "text-muted-foreground")
                  }
                >
                  {Number(r.velocity) > 0 ? "+" : ""}
                  {Number(r.velocity).toFixed(2)}
                </td>
                <td className="px-4 py-3 text-right font-bold tabular-nums text-amber-700">
                  {Number(r.promotion_score).toFixed(1)}
                </td>
                <td className="px-4 py-3 text-xs text-muted-foreground">
                  {whyMissed(r)}
                </td>
                <td className="px-4 py-3 text-right">
                  <PromoteButton keyword={r.keyword} category={null} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
