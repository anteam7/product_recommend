"""
트렌드 레이더 v4 — UMAP + HDBSCAN 임베딩 좌표 산출 (주1회).

입력: jimscanner_trends_products + jimscanner_trends_scores + jimscanner_trends_keywords
산출: jimscanner_trends_embeddings (product_id, vec_x, vec_y, vec_prev_x, vec_prev_y,
      cluster_id, cluster_label, cluster_momentum, signal_snapshot)

실행:
    pip install supabase sentence-transformers umap-learn hdbscan numpy
    SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
        python scripts/recompute-embeddings.py

설계:
  1. 모든 product 의 최신 score + 소스별 30d 언급량 + supplier 다양성 + 카테고리 임베딩
     을 묶어서 d 차원 시그널 벡터 생성.
  2. UMAP(n_components=2) 로 2D 좌표 떨굼.
  3. HDBSCAN 으로 자동 클러스터링.
  4. 7일 전 좌표는 직전 run 의 vec_x/vec_y 를 vec_prev_* 로 옮김.
  5. 클러스터 단위 LLM 1줄 라벨 — 토큰 절감을 위해 cluster size>=3 만 라벨링.
"""
from __future__ import annotations

import os
import sys
import json
from collections import defaultdict
from datetime import datetime, timedelta, timezone

try:
    import numpy as np
    from supabase import create_client
except ImportError as e:
    print(f"[fatal] 의존성 미설치: {e}\n  pip install supabase sentence-transformers umap-learn hdbscan numpy")
    sys.exit(1)


SUPABASE_URL = os.environ.get("SUPABASE_URL") or os.environ.get("NEXT_PUBLIC_SUPABASE_URL")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")

if not SUPABASE_URL or not SUPABASE_KEY:
    print("[fatal] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 환경변수 필요")
    sys.exit(1)

sb = create_client(SUPABASE_URL, SUPABASE_KEY)


def load_products():
    res = sb.table("jimscanner_trends_products").select(
        "id, canonical_name, category_top, category_mid, brand, description"
    ).limit(5000).execute()
    return res.data or []


def load_latest_scores():
    res = sb.table("jimscanner_trends_scores").select(
        "product_id, trend_score, commerce_score, supplier_score, competition_score, "
        "final_score, score_components, computed_at"
    ).order("computed_at", desc=True).limit(5000).execute()
    seen = set()
    latest = {}
    for r in res.data or []:
        pid = r["product_id"]
        if pid in seen:
            continue
        seen.add(pid)
        latest[pid] = r
    return latest


def load_scores_at(days_ago: int):
    """7일 전 시점의 final_score (모멘텀 Δ 계산용)."""
    cutoff_high = datetime.now(timezone.utc) - timedelta(days=days_ago)
    cutoff_low = cutoff_high - timedelta(days=2)  # ±2일 윈도우
    res = sb.table("jimscanner_trends_scores").select(
        "product_id, final_score, computed_at"
    ).gte("computed_at", cutoff_low.isoformat()).lte(
        "computed_at", cutoff_high.isoformat()
    ).limit(5000).execute()
    out = {}
    for r in res.data or []:
        out.setdefault(r["product_id"], r["final_score"])
    return out


def load_source_mentions():
    """30일 누적 소스별 언급량 (product 별)."""
    since = (datetime.now(timezone.utc) - timedelta(days=30)).isoformat()
    res = sb.table("jimscanner_trends_keywords").select(
        "product_id, source, collected_at"
    ).gte("collected_at", since).limit(20000).execute()
    counts: dict[str, dict[str, int]] = defaultdict(lambda: defaultdict(int))
    for r in res.data or []:
        if not r.get("product_id"):
            continue
        counts[r["product_id"]][r["source"]] += 1
    return counts


def load_prev_coords():
    """직전 run 좌표 — vec_prev_* 로 보존."""
    res = sb.table("jimscanner_trends_embeddings").select(
        "product_id, vec_x, vec_y"
    ).limit(5000).execute()
    return {r["product_id"]: (r["vec_x"], r["vec_y"]) for r in res.data or []}


SOURCES = [
    "82cook", "natepan", "ppomppu", "musinsa", "aliex",
    "naver_tvtime", "naver", "coupang", "ggsan", "danawa",
]


def build_vectors(products, scores, mentions):
    """
    d = 4 + len(SOURCES) + 1(가격대 proxy) + 1(supplier 다양성) + 8(카테고리 one-hot proxy)
    카테고리 의미임베딩은 sentence-transformers 가 있을 때만 우선 적용,
    없으면 one-hot 으로 폴백.
    """
    cats = sorted({(p.get("category_top") or "all") for p in products})
    cat_idx = {c: i for i, c in enumerate(cats)}

    embedder = None
    try:
        from sentence_transformers import SentenceTransformer
        embedder = SentenceTransformer("all-MiniLM-L6-v2")
    except Exception as e:
        print(f"[warn] sentence-transformers 미사용 (one-hot 폴백): {e}")

    texts = [
        " / ".join(filter(None, [p.get("canonical_name"), p.get("category_top"), p.get("category_mid"), p.get("brand")]))
        for p in products
    ]
    if embedder is not None:
        cat_vecs = embedder.encode(texts, show_progress_bar=False)
    else:
        cat_vecs = np.zeros((len(products), max(8, len(cats))), dtype=np.float32)
        for i, p in enumerate(products):
            cat_vecs[i, cat_idx.get(p.get("category_top") or "all", 0)] = 1.0

    feats = []
    pids = []
    snapshots = []
    for i, p in enumerate(products):
        pid = p["id"]
        s = scores.get(pid)
        if not s:
            continue
        comps = s.get("score_components") or {}
        # 4점수
        base = [
            float(s.get("trend_score") or 0),
            float(s.get("commerce_score") or 0),
            float(s.get("supplier_score") or 0),
            float(s.get("competition_score") or 0),
        ]
        # 소스별 언급량 (log 스케일)
        src = mentions.get(pid, {})
        src_vec = [float(np.log1p(src.get(s_, 0))) for s_ in SOURCES]
        # 가격대 proxy — commerce 컴포넌트에서 추출, 없으면 0
        price = float((comps.get("commerce") or {}).get("price_band") or 0)
        # supplier 다양성 — supplier 컴포넌트의 distinct count
        supplier_div = float((comps.get("supplier") or {}).get("distinct_count") or 0)

        vec = np.concatenate([
            np.array(base, dtype=np.float32),
            np.array(src_vec, dtype=np.float32),
            np.array([price, supplier_div], dtype=np.float32),
            np.array(cat_vecs[i], dtype=np.float32).flatten(),
        ])
        feats.append(vec)
        pids.append(pid)
        snapshots.append({
            "scores": base,
            "sources": src,
            "price_band": price,
            "supplier_diversity": supplier_div,
        })

    if not feats:
        return [], np.empty((0, 0)), []

    # 길이 정렬 (sentence-transformers 임베딩 길이가 batch 마다 동일하므로 OK)
    return pids, np.vstack(feats), snapshots


def reduce_and_cluster(X):
    try:
        import umap
        import hdbscan
    except ImportError as e:
        print(f"[fatal] umap-learn / hdbscan 미설치: {e}")
        sys.exit(1)

    if len(X) < 5:
        # 데이터 너무 적음 — 단순 평면 배치
        coords = np.zeros((len(X), 2))
        for i in range(len(X)):
            coords[i] = [i, i]
        labels = np.array([-1] * len(X))
        return coords, labels

    reducer = umap.UMAP(n_components=2, n_neighbors=min(15, max(2, len(X) - 1)), min_dist=0.1, metric="euclidean", random_state=42)
    coords = reducer.fit_transform(X)

    clusterer = hdbscan.HDBSCAN(min_cluster_size=max(3, len(X) // 30), min_samples=2)
    labels = clusterer.fit_predict(coords)
    return coords, labels


def label_clusters(pids, products_by_id, labels):
    """클러스터 단위 한 줄 라벨 (LLM 호출은 옵션 — 없으면 대표 SKU 이름 사용)."""
    cluster_members: dict[int, list[str]] = defaultdict(list)
    for pid, lab in zip(pids, labels):
        cluster_members[int(lab)].append(pid)

    out: dict[int, str] = {}
    for cid, members in cluster_members.items():
        if cid == -1 or len(members) < 2:
            out[cid] = ""
            continue
        names = [products_by_id[m]["canonical_name"] for m in members[:5] if m in products_by_id]
        out[cid] = " · ".join(names[:3]) if names else f"cluster {cid}"
    return out


def compute_momentum(pids, labels, latest_scores, week_ago_scores):
    """cluster_momentum = 구성 SKU final_score 7d Δ 평균."""
    delta_by_cluster: dict[int, list[float]] = defaultdict(list)
    for pid, lab in zip(pids, labels):
        latest = (latest_scores.get(pid) or {}).get("final_score") or 0
        prev = week_ago_scores.get(pid) or latest
        delta_by_cluster[int(lab)].append(float(latest) - float(prev))
    return {cid: float(np.mean(v)) if v else 0.0 for cid, v in delta_by_cluster.items()}


def upsert_rows(rows):
    if not rows:
        print("[info] upsert 대상 없음")
        return
    BATCH = 200
    for i in range(0, len(rows), BATCH):
        chunk = rows[i:i + BATCH]
        sb.table("jimscanner_trends_embeddings").upsert(chunk, on_conflict="product_id").execute()
        print(f"  upsert {i + len(chunk)}/{len(rows)}")


def main():
    print("[1/6] load products + scores + mentions ...")
    products = load_products()
    products_by_id = {p["id"]: p for p in products}
    latest = load_latest_scores()
    week_ago = load_scores_at(days_ago=7)
    mentions = load_source_mentions()
    prev_coords = load_prev_coords()

    print(f"  products={len(products)} latest_scores={len(latest)} mentions_pids={len(mentions)} prev_coords={len(prev_coords)}")

    print("[2/6] build signal vectors ...")
    pids, X, snapshots = build_vectors(products, latest, mentions)
    print(f"  vectors n={len(pids)} d={X.shape[1] if len(pids) else 0}")

    print("[3/6] UMAP + HDBSCAN ...")
    coords, labels = reduce_and_cluster(X)

    print("[4/6] label clusters ...")
    cluster_labels = label_clusters(pids, products_by_id, labels)

    print("[5/6] compute cluster momentum (final_score 7d Δ) ...")
    momentum = compute_momentum(pids, labels, latest, week_ago)

    print("[6/6] upsert embeddings ...")
    now_iso = datetime.now(timezone.utc).isoformat()
    rows = []
    for i, pid in enumerate(pids):
        prev = prev_coords.get(pid)
        rows.append({
            "product_id": pid,
            "vec_x": float(coords[i][0]),
            "vec_y": float(coords[i][1]),
            "vec_prev_x": float(prev[0]) if prev else None,
            "vec_prev_y": float(prev[1]) if prev else None,
            "cluster_id": int(labels[i]),
            "cluster_label": cluster_labels.get(int(labels[i]), ""),
            "cluster_momentum": momentum.get(int(labels[i]), 0.0),
            "signal_snapshot": snapshots[i],
            "computed_at": now_iso,
        })
    upsert_rows(rows)
    print("[done] embeddings recompute 완료.")


if __name__ == "__main__":
    main()
