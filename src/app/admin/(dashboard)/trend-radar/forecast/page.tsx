"use client";

import { useEffect, useMemo, useState } from "react";

// ───────────────────────────────────────────────────────────────────────────
// 수요 궤적 예측 보드 — 점수 시계열 외삽 N일 피크 추정
// 실선=실측 + 점선=예측 + 음영=예측구간 스파크라인
// ───────────────────────────────────────────────────────────────────────────

type ForecastPoint = { t: number; y: number; lo?: number; hi?: number };

type ForecastItem = {
  productId: string;
  name: string;
  samples: number;
  confidence: number;
  lastObserved: number;
  predictedPeak: number;
  etaToPeak: number;
  direction: "up" | "down" | "flat";
  slope: number;
  intervalWidth: number;
  leadTime: number | null;
  sourceNow: boolean;
  history: ForecastPoint[];
  forecast: ForecastPoint[];
};

type ApiResp = {
  ok: boolean;
  horizon: number;
  count: number;
  items: ForecastItem[];
  error?: string;
};

const W = 160;
const H = 44;
const PAD = 3;

function Sparkline({ item }: { item: ForecastItem }) {
  const all: ForecastPoint[] = [...item.history, ...item.forecast];
  if (all.length === 0) return <svg width={W} height={H} />;

  const ts = all.map((p) => p.t);
  const ys = all.flatMap((p) => [p.y, p.lo ?? p.y, p.hi ?? p.y]);
  const minT = Math.min(...ts);
  const maxT = Math.max(...ts);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);

  const sx = (t: number) =>
    PAD + ((t - minT) / Math.max(1e-9, maxT - minT)) * (W - 2 * PAD);
  const sy = (y: number) =>
    H - PAD - ((y - minY) / Math.max(1e-9, maxY - minY)) * (H - 2 * PAD);

  const histPath = item.history
    .map((p, i) => `${i === 0 ? "M" : "L"}${sx(p.t)},${sy(p.y)}`)
    .join(" ");

  // 실측 마지막 → 예측 연결
  const bridge = item.history.length
    ? [item.history[item.history.length - 1], ...item.forecast]
    : item.forecast;
  const foreLine = bridge
    .map((p, i) => `${i === 0 ? "M" : "L"}${sx(p.t)},${sy(p.y)}`)
    .join(" ");

  // 음영 (예측구간): hi 위로, lo 아래로
  const bandTop = item.forecast.map((p) => `${sx(p.t)},${sy(p.hi ?? p.y)}`);
  const bandBot = item.forecast
    .slice()
    .reverse()
    .map((p) => `${sx(p.t)},${sy(p.lo ?? p.y)}`);
  const bandPath =
    item.forecast.length > 0
      ? `M${bandTop.join(" L")} L${bandBot.join(" L")} Z`
      : "";

  const color =
    item.direction === "up"
      ? "#16a34a"
      : item.direction === "down"
        ? "#dc2626"
        : "#6b7280";

  return (
    <svg width={W} height={H} className="overflow-visible">
      {bandPath && <path d={bandPath} fill={color} opacity={0.12} />}
      <path d={histPath} fill="none" stroke={color} strokeWidth={1.5} />
      <path
        d={foreLine}
        fill="none"
        stroke={color}
        strokeWidth={1.5}
        strokeDasharray="3 2"
        opacity={0.8}
      />
    </svg>
  );
}

function dirIcon(d: string) {
  if (d === "up") return "▲";
  if (d === "down") return "▼";
  return "▬";
}

export default function ForecastPage() {
  const [data, setData] = useState<ApiResp | null>(null);
  const [loading, setLoading] = useState(true);
  const [horizon, setHorizon] = useState(10);

  useEffect(() => {
    setLoading(true);
    fetch(`/api/admin/trend-radar/forecast?horizon=${horizon}`)
      .then((r) => r.json())
      .then((j: ApiResp) => setData(j))
      .catch(() => setData({ ok: false, horizon, count: 0, items: [] }))
      .finally(() => setLoading(false));
  }, [horizon]);

  const items = useMemo(() => data?.items ?? [], [data]);
  const sourceNowCount = items.filter((i) => i.sourceNow).length;

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold">수요 궤적 예측 보드</h1>
          <p className="text-sm text-muted-foreground mt-1">
            누적 점수 시계열을 log-강건 회귀로 외삽해 향후 {horizon}일 피크·도달
            ETA·예측구간을 추정합니다. 표본이 얇은 상품은 베이지안 수축으로 ETA
            신뢰도를 강등합니다.
          </p>
        </div>
        <div className="flex items-center gap-2 text-sm">
          <label htmlFor="horizon" className="text-muted-foreground">
            외삽 기간
          </label>
          <select
            id="horizon"
            value={horizon}
            onChange={(e) => setHorizon(Number(e.target.value))}
            className="border rounded px-2 py-1 bg-background"
          >
            {[7, 10, 14, 21].map((h) => (
              <option key={h} value={h}>
                {h}일
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="flex gap-4 text-sm">
        <div className="rounded-lg border px-4 py-3">
          <div className="text-muted-foreground">예측 상품</div>
          <div className="text-xl font-semibold">{items.length}</div>
        </div>
        <div className="rounded-lg border px-4 py-3">
          <div className="text-muted-foreground">지금 소싱 플래그</div>
          <div className="text-xl font-semibold text-amber-600">
            {sourceNowCount}
          </div>
        </div>
      </div>

      {loading ? (
        <div className="text-sm text-muted-foreground">예측 적합 중…</div>
      ) : !data?.ok ? (
        <div className="text-sm text-red-600">
          데이터를 불러오지 못했습니다{data?.error ? ` (${data.error})` : ""}.
          score 시계열/헬퍼 뷰가 적용됐는지 확인하세요.
        </div>
      ) : items.length === 0 ? (
        <div className="text-sm text-muted-foreground">
          외삽 가능한 표본(상품당 3점 이상)이 아직 없습니다.
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="border-b text-left text-muted-foreground">
                <th className="py-2 pr-3">상품</th>
                <th className="py-2 pr-3">궤적</th>
                <th className="py-2 pr-3 text-right">예측 피크</th>
                <th className="py-2 pr-3 text-right">피크 ETA</th>
                <th className="py-2 pr-3 text-center">방향</th>
                <th className="py-2 pr-3 text-right">구간폭</th>
                <th className="py-2 pr-3 text-right">리드타임</th>
                <th className="py-2 pr-3 text-right">표본/신뢰</th>
                <th className="py-2 pr-3">소싱</th>
              </tr>
            </thead>
            <tbody>
              {items.map((it) => (
                <tr key={it.productId} className="border-b hover:bg-muted/40">
                  <td className="py-2 pr-3 max-w-[220px] truncate" title={it.name}>
                    {it.name}
                  </td>
                  <td className="py-2 pr-3">
                    <Sparkline item={it} />
                  </td>
                  <td className="py-2 pr-3 text-right font-medium">
                    {it.predictedPeak}
                  </td>
                  <td className="py-2 pr-3 text-right">
                    {it.etaToPeak > 0 ? `${it.etaToPeak}일` : "—"}
                  </td>
                  <td
                    className="py-2 pr-3 text-center"
                    style={{
                      color:
                        it.direction === "up"
                          ? "#16a34a"
                          : it.direction === "down"
                            ? "#dc2626"
                            : "#6b7280",
                    }}
                  >
                    {dirIcon(it.direction)}
                  </td>
                  <td className="py-2 pr-3 text-right text-muted-foreground">
                    ±{Math.round(it.intervalWidth * 100)}%
                  </td>
                  <td className="py-2 pr-3 text-right text-muted-foreground">
                    {it.leadTime != null ? `${it.leadTime}일` : "—"}
                  </td>
                  <td className="py-2 pr-3 text-right text-muted-foreground">
                    {it.samples} · {Math.round(it.confidence * 100)}%
                  </td>
                  <td className="py-2 pr-3">
                    {it.sourceNow ? (
                      <span className="inline-block rounded bg-amber-100 text-amber-800 px-2 py-0.5 text-xs font-medium">
                        지금 소싱
                      </span>
                    ) : (
                      <span className="text-xs text-muted-foreground">대기</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="text-xs text-muted-foreground">
        실선 = 실측, 점선 = 외삽 예측, 음영 = ~80% 예측구간. ETA ≤ 리드타임이면
        피크 전 입고가 불가하므로 &apos;지금 소싱&apos; 으로 플래그됩니다.
      </p>
    </div>
  );
}
