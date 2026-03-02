import base64
import json
import math
import os
from collections import defaultdict

import psycopg2
import requests

DB_URL = os.environ.get("DATABASE_URL")
if not DB_URL:
    raise SystemExit("DATABASE_URL is required")

API_BASE = os.environ.get("BACKEND_URL", "http://localhost:8000")
TOPK = int(os.environ.get("TOPK", "50"))
AUTH_TOKEN = os.environ.get("AUTH_TOKEN")
if not AUTH_TOKEN:
    raise SystemExit("AUTH_TOKEN is required")


def jwt_user_id(token: str) -> str | None:
    try:
        parts = token.split(".")
        if len(parts) != 3:
            return None
        payload_b64 = parts[1] + "==="
        payload = json.loads(base64.urlsafe_b64decode(payload_b64).decode("utf-8"))
        return payload.get("userId")
    except Exception:
        return None


def ndcg_at_k(rec_ids, relevant_ids, k):
    dcg = 0.0
    for idx, rid in enumerate(rec_ids[:k], start=1):
        rel = 1.0 if rid in relevant_ids else 0.0
        dcg += rel / math.log2(idx + 1)

    ideal_hits = min(len(relevant_ids), k)
    idcg = sum(1.0 / math.log2(i + 1) for i in range(1, ideal_hits + 1))
    return (dcg / idcg) if idcg > 0 else 0.0


def get_popularity_map(cur):
    cur.execute("SELECT title_id, cnt FROM popular_titles")
    rows = cur.fetchall()
    pop_map = {int(r[0]): float(r[1] or 0.0) for r in rows}
    total = sum(pop_map.values()) or 1.0
    return pop_map, total


def user_top_genres(cur, user_id, topn=5):
    cur.execute(
        """
        SELECT unnest(t.genres) AS g, COUNT(*) AS c
        FROM interactions i
        JOIN titles t ON t.id = i.title_id
        WHERE i.user_id = %s
          AND (i.watched = true OR i.rating >= 4 OR i.weight >= 3)
        GROUP BY g
        ORDER BY c DESC
        LIMIT %s
        """,
        (str(user_id), int(topn)),
    )
    return {r[0] for r in cur.fetchall() if r and r[0]}


def title_genres(cur, title_id):
    cur.execute("SELECT genres FROM titles WHERE id = %s", (int(title_id),))
    row = cur.fetchone()
    if not row or not row[0]:
        return set()
    return set(row[0])


def main():
    conn = psycopg2.connect(DB_URL)
    cur = conn.cursor()

    cur.execute(
        """
        SELECT user_id, title_id, ts
        FROM interactions
        WHERE watched = true OR rating >= 4 OR weight >= 3
        ORDER BY user_id, ts
        """
    )
    rows = cur.fetchall()

    by_user = defaultdict(list)
    for user_id, title_id, ts in rows:
        by_user[user_id].append((ts, title_id))

    users = [u for u in by_user if len(by_user[u]) >= 2]
    token_uid = jwt_user_id(AUTH_TOKEN)
    if token_uid:
        users = [u for u in users if str(u) == str(token_uid)]

    print("Token userId:", token_uid)
    print("Evaluating users:", [str(u) for u in users])

    pop_map, pop_total = get_popularity_map(cur)
    coverage = set()

    agg = {
        "precision": 0.0,
        "recall": 0.0,
        "ndcg": 0.0,
        "genre_match": 0.0,
        "novelty": 0.0,
        "users": 0,
    }

    for user in users:
        positives = [t for _, t in by_user[user]]
        holdout = {positives[-1]}
        top_genres = user_top_genres(cur, user, topn=5)

        resp = requests.get(
            f"{API_BASE}/api/recs/cf_user",
            params={"topK": TOPK},
            headers={"Authorization": f"Bearer {AUTH_TOKEN}"},
            timeout=30,
        )
        if not resp.ok:
            print("API error:", resp.status_code, resp.text[:200])
            continue

        items = resp.json().get("items", [])
        rec_ids = []
        for it in items:
            rid = it.get("title_id") if it.get("title_id") is not None else it.get("id")
            if rid is not None:
                rec_ids.append(int(rid))

        if not rec_ids:
            continue

        hits = len([rid for rid in rec_ids[:TOPK] if rid in holdout])
        precision = hits / max(1, TOPK)
        recall = hits / max(1, len(holdout))
        ndcg = ndcg_at_k(rec_ids, holdout, TOPK)

        matched = 0
        novelty_score = 0.0
        for rid in rec_ids[:TOPK]:
            coverage.add(rid)
            if title_genres(cur, rid) & top_genres:
                matched += 1
            pop = pop_map.get(rid, 0.0)
            p = (pop / pop_total) if pop_total > 0 else 0.0
            novelty_score += -math.log2(max(p, 1e-12))

        genre_match = matched / max(1, len(rec_ids[:TOPK]))
        novelty = novelty_score / max(1, len(rec_ids[:TOPK]))

        print(f"\nUser: {user}")
        print(f"Precision@{TOPK}: {precision:.3f}")
        print(f"Recall@{TOPK}: {recall:.3f}")
        print(f"NDCG@{TOPK}: {ndcg:.3f}")
        print(f"Genre-match@{TOPK}: {genre_match:.3f}")
        print(f"Novelty@{TOPK}: {novelty:.3f}")

        agg["precision"] += precision
        agg["recall"] += recall
        agg["ndcg"] += ndcg
        agg["genre_match"] += genre_match
        agg["novelty"] += novelty
        agg["users"] += 1

    n = agg["users"]
    print("\n===== OFFLINE EVALUATION SUMMARY =====")
    print(f"Users evaluated: {n}")
    if n:
        print(f"Precision@{TOPK}: {agg['precision']/n:.3f}")
        print(f"Recall@{TOPK}: {agg['recall']/n:.3f}")
        print(f"NDCG@{TOPK}: {agg['ndcg']/n:.3f}")
        print(f"Genre-match@{TOPK}: {agg['genre_match']/n:.3f}")
        print(f"Novelty@{TOPK}: {agg['novelty']/n:.3f}")
    else:
        print("No valid users to evaluate.")
    print(f"Coverage@{TOPK}: {len(coverage)} unique titles")

    cur.close()
    conn.close()


if __name__ == "__main__":
    main()

