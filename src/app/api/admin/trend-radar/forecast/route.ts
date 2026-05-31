import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/auth/admin-supabase";

export const dynamic = "force-dynamic";

// ───────────────────────────────────────────────────────────────────────────
// 수요 궤적 예측 보드 — 점수 시계열 외삽으로 N일 피크/ETA/예측구간 추정
//
// 누적된 jimscanner_trends_scores(computed_at 시계열)에 log-강건 선형회귀를
// 적합해 향후 horizon 일을 외삽한다. 표본이 얇은 상품은 베이지안 수축으로
// 기울기를 0 방향으로 당겨 ETA 신뢰도를 강등한다.
// jimscanner_trends_supplier.lead_time_days 와 교차해
// 'ETA_to_peak > lead_time' 이면 '지금 소싱' 플래그.
// ───────────────────────────────────────────────────────────────────────────

type ScoreRow = {
  product_id: string | number;
  computed_at: string;
  trend_score: number | null;
  final_score: number | null;
};

type Point = { t: number; y: number }; // t = days since first sample

type Fit = {
  slope: number; // log-space slope per day (수축 적용 후)
  rawSlope: number; // 수축 전 기울기
  intercept: number;
  residualStd: number; // log-space 잔차 표준편차 (변동성)
  n: number;
  confidence: number; // 0~1 (표본 두께 기반)
};

const HORIZON_DEFAULT = 10; // 외삽 일수 (7~14)
const SHRINK_K = 4; // 베이지안 수축 강도 (n/(n+k))
const MIN_SAMPLES = 3;

function toLog(y: number): number {
  // score 는 0 이상 가정. log1p 로 0 강건성 확보.
  return Math.log1p(Math.max(0, y));
}
function fromLog(v: number): number {
  return Math.expm1(v);
}

// log-space 단순 선형회귀 + 베이지안 수축
function fitLogLinear(points: Point[]): Fit | null {
  const n = points.length;
  if (n < MIN_SAMPLES) return null;

  const ys = points.map((p) => toLog(p.y));
  const ts = points.map((p) => p.t);
  const meanT = ts.reduce((a, b) => a + b, 0) / n;
  const meanY = ys.reduce((a, b) => a + b, 0) / n;

  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    const dt = ts[i] - meanT;
    sxx += dt * dt;
    sxy += dt * (ys[i] - meanY);
  }
  if (sxx === 0) return null;

  const rawSlope = sxy / sxx;
  const intercept = meanY - rawSlope * meanT;

  // 잔차 표준편차 (예측구간 폭)
  let ss = 0;
  for (let i = 0; i < n; i++) {
    const pred = intercept + rawSlope * ts[i];
    ss += (ys[i] - pred) ** 2;
  }
  const residualStd = Math.sqrt(ss / Math.max(1, n - 2));

  // 베이지안 수축: 표본이 얇을수록 기울기를 0 으로 당김 → ETA 신뢰도 강등
  const confidence = n / (n + SHRINK_K);
  const slope = rawSlope * confidence;

  return { slope, rawSlope, intercept, residualStd, n, confidence };
}

function buildPoints(rows: ScoreRow[]): { pts: Point[]; firstMs: number } | null {
  const clean = rows
    .map((r) => {
      const y = r.final_score ?? r.trend_score;
      const ts = Date.parse(r.computed_at);
      return y == null || Number.isNaN(ts) ? null : { ms: ts, y: Number(y) };
    })
    .filter((x): x is { ms: number; y: number } => x !== null)
    .sort((a, b) => a.ms - b.ms);

  if (clean.length < MIN_SAMPLES) return null;
  const firstMs = clean[0].ms;
  const pts = clean.map((c) => ({
    t: (c.ms - firstMs) / 86_400_000,
    y: c.y,
  }));
  return { pts, firstMs };
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const horizon = Math.min(
    21,
    Math.max(3, Number(url.searchParams.get("horizon")) || HORIZON_DEFAULT),
  );

  let supabase;
  try {
    supabase = createAdminClient();
  } catch {
    return NextResponse.json(
      { ok: false, error: "supabase env missing", items: [] },
      { status: 200 },
    );
  }

  // 1) score 이력 (헬퍼 뷰) — 뷰 미적용 시 원본 테이블로 폴백
  let rows: ScoreRow[] = [];
  const viewRes = await (supabase as any)
    .from("jimscanner_trends_score_history")
    .select("product_id, computed_at, trend_score, final_score")
    .limit(20000);

  if (viewRes.error || !viewRes.data) {
    const fallback = await (supabase as any)
      .from("jimscanner_trends_scores")
      .select("product_id, computed_at, trend_score, final_score")
      .not("product_id", "is", null)
      .limit(20000);
    rows = (fallback.data as ScoreRow[]) ?? [];
  } else {
    rows = viewRes.data as ScoreRow[];
  }

  // 2) 공급사 lead_time (선택)
  const leadByProduct = new Map<string, number>();
  const supRes = await (supabase as any)
    .from("jimscanner_trends_supplier")
    .select("product_id, lead_time_days")
    .limit(20000);
  if (supRes && !supRes.error && Array.isArray(supRes.data)) {
    for (const s of supRes.data as Array<{
      product_id: string | number;
      lead_time_days: number | null;
    }>) {
      if (s.lead_time_days != null) {
        leadByProduct.set(String(s.product_id), Number(s.lead_time_days));
      }
    }
  }

  // 3) product 명/키워드 (선택, 베스트에포트)
  const nameByProduct = new Map<string, string>();
  for (const table of ["jimscanner_trends_products", "jimscanner_trends_keywords"]) {
    const nRes = await (supabase as any)
      .from(table)
      .select("product_id, keyword, title, name")
      .limit(20000);
    if (nRes && !nRes.error && Array.isArray(nRes.data)) {
      for (const r of nRes.data as any[]) {
        const key = String(r.product_id);
        if (!nameByProduct.has(key)) {
          const label = r.title || r.name || r.keyword;
          if (label) nameByProduct.set(key, String(label));
        }
      }
    }
  }

  // 그룹핑
  const byProduct = new Map<string, ScoreRow[]>();
  for (const r of rows) {
    const key = String(r.product_id);
    const arr = byProduct.get(key) ?? [];
    arr.push(r);
    byProduct.set(key, arr);
  }

  const items: any[] = [];
  for (const [productId, prRows] of byProduct.entries()) {
    const built = buildPoints(prRows);
    if (!built) continue;
    const { pts } = built;
    const fit = fitLogLinear(pts);
    if (!fit) continue;

    const lastT = pts[pts.length - 1].t;
    const lastObserved = pts[pts.length - 1].y;

    // 외삽 (점선)
    const forecast: { t: number; y: number; lo: number; hi: number }[] = [];
    const z = 1.28; // ~80% 예측구간
    for (let d = 1; d <= horizon; d++) {
      const t = lastT + d;
      const logY = fit.intercept + fit.slope * t;
      const y = Math.max(0, fromLog(logY));
      // 구간: 잔차 std 가 외삽 거리에 따라 누적 확대
      const band = fit.residualStd * z * Math.sqrt(1 + d / Math.max(1, fit.n));
      const lo = Math.max(0, fromLog(logY - band));
      const hi = Math.max(0, fromLog(logY + band));
      forecast.push({ t, y, lo, hi });
    }

    // 예측 피크: 실측 최근값 포함 외삽 구간 최대
    const allFuture = [{ t: lastT, y: lastObserved }, ...forecast];
    let peak = allFuture[0];
    for (const f of allFuture) if (f.y > peak.y) peak = f;
    const etaToPeak = Math.round((peak.t - lastT) * 10) / 10; // days

    // 기울기 방향
    const direction =
      fit.slope > 0.01 ? "up" : fit.slope < -0.01 ? "down" : "flat";

    // 예측구간 폭 (변동성) — 마지막 외삽 시점 기준 상대폭
    const lastF = forecast[forecast.length - 1];
    const intervalWidth =
      lastF && lastF.y > 0 ? (lastF.hi - lastF.lo) / lastF.y : 0;

    const leadTime = leadByProduct.get(productId) ?? null;
    // '지금 소싱': 피크까지 ETA 가 리드타임보다 짧거나 같으면 (피크 전 도착 불가 → 지금 소싱)
    const sourceNow =
      leadTime != null && etaToPeak > 0 ? etaToPeak <= leadTime : false;

    const predictedPeak = Math.round(peak.y * 100) / 100;

    items.push({
      productId,
      name: nameByProduct.get(productId) ?? productId,
      samples: fit.n,
      confidence: Math.round(fit.confidence * 100) / 100,
      lastObserved: Math.round(lastObserved * 100) / 100,
      predictedPeak,
      etaToPeak,
      direction,
      slope: Math.round(fit.rawSlope * 1000) / 1000,
      intervalWidth: Math.round(intervalWidth * 100) / 100,
      leadTime,
      sourceNow,
      // 스파크라인용 시계열 (정규화는 클라이언트에서)
      history: pts.map((p) => ({ t: Math.round(p.t * 10) / 10, y: p.y })),
      forecast: forecast.map((f) => ({
        t: Math.round(f.t * 10) / 10,
        y: Math.round(f.y * 100) / 100,
        lo: Math.round(f.lo * 100) / 100,
        hi: Math.round(f.hi * 100) / 100,
      })),
    });
  }

  // 정렬: 지금 소싱 우선 → 예측 피크 높은 순
  items.sort((a, b) => {
    if (a.sourceNow !== b.sourceNow) return a.sourceNow ? -1 : 1;
    return b.predictedPeak - a.predictedPeak;
  });

  return NextResponse.json({ ok: true, horizon, count: items.length, items });
}
