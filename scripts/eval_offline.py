import base64
import hashlib
import hmac
import json
import math
import os
from collections import Counter, defaultdict

import psycopg2
import requests
from psycopg2.extras import RealDictCursor

DB_URL = os.environ.get("DATABASE_URL")
if not DB_URL:
    raise SystemExit("DATABASE_URL is required")

API_BASE = os.environ.get("BACKEND_URL", "http://localhost:8000").rstrip("/")
RECS_PATH = os.environ.get("RECS_PATH", "/api/recs/cf_user")
REQUEST_TIMEOUT = int(os.environ.get("REQUEST_TIMEOUT_SEC", "120"))
HOLDOUT_COUNT = max(1, int(os.environ.get("HOLDOUT_COUNT", "3")))
TOPK = max(1, int(os.environ.get("TOPK", "100")))
METRIC_KS = sorted(
    {
        int(value)
        for value in os.environ.get("METRIC_KS", "10,20,50,100").split(",")
        if str(value).strip().isdigit() and int(value) > 0
    }
)
if not METRIC_KS:
    METRIC_KS = [10, 20, 50, 100]
TOPK = max(TOPK, max(METRIC_KS))
MIN_HISTORY = max(HOLDOUT_COUNT + 1, int(os.environ.get("MIN_HISTORY", str(HOLDOUT_COUNT + 1))))
MAX_EVAL_USERS = max(0, int(os.environ.get("MAX_EVAL_USERS", "0")))

AUTH_TOKEN = os.environ.get("AUTH_TOKEN")
EVAL_EMAIL = os.environ.get("EVAL_EMAIL")
EVAL_PASSWORD = os.environ.get("EVAL_PASSWORD")
JWT_SECRET = os.environ.get("JWT_SECRET")
EVAL_ALL_USERS = os.environ.get("EVAL_ALL_USERS", "0") == "1"


def b64url_encode(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode("utf-8").rstrip("=")


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


def sign_eval_token(user_id: str, email: str | None = None) -> str:
    if not JWT_SECRET:
        raise SystemExit("JWT_SECRET is required to generate evaluation tokens")

    header = {"alg": "HS256", "typ": "JWT"}
    payload = {"userId": str(user_id), "email": email or f"eval+{user_id}@moviemix.local"}

    header_b64 = b64url_encode(json.dumps(header, separators=(",", ":")).encode("utf-8"))
    payload_b64 = b64url_encode(json.dumps(payload, separators=(",", ":")).encode("utf-8"))
    signing_input = f"{header_b64}.{payload_b64}".encode("utf-8")
    sig = hmac.new(JWT_SECRET.encode("utf-8"), signing_input, hashlib.sha256).digest()
    return f"{header_b64}.{payload_b64}.{b64url_encode(sig)}"


def resolve_auth_token() -> str | None:
    if AUTH_TOKEN:
        return AUTH_TOKEN

    if EVAL_EMAIL and EVAL_PASSWORD:
        resp = requests.post(
            f"{API_BASE}/api/auth/login",
            json={"email": EVAL_EMAIL, "password": EVAL_PASSWORD},
            timeout=REQUEST_TIMEOUT,
        )
        if not resp.ok:
            raise SystemExit(f"Login failed: {resp.status_code} {resp.text[:200]}")
        token = resp.json().get("token")
        if token:
            return token

    if JWT_SECRET:
        return None

    raise SystemExit("AUTH_TOKEN, EVAL_EMAIL/EVAL_PASSWORD, or JWT_SECRET is required")


def normalize_genres(genres):
    if not isinstance(genres, list):
        return []
    return [str(g).strip().lower() for g in genres if str(g).strip()]


def ndcg_at_k(rec_ids, relevant_ids, k):
    dcg = 0.0
    for idx, rid in enumerate(rec_ids[:k], start=1):
        rel = 1.0 if rid in relevant_ids else 0.0
        dcg += rel / math.log2(idx + 1)

    ideal_hits = min(len(relevant_ids), k)
    idcg = sum(1.0 / math.log2(i + 1) for i in range(1, ideal_hits + 1))
    return (dcg / idcg) if idcg > 0 else 0.0


def hit_rate_at_k(rec_ids, relevant_ids, k):
    return 1.0 if any(rid in relevant_ids for rid in rec_ids[:k]) else 0.0


def precision_at_k(rec_ids, relevant_ids, k):
    rec_slice = rec_ids[:k]
    if not rec_slice:
        return 0.0
    hits = sum(1 for rid in rec_slice if rid in relevant_ids)
    return hits / len(rec_slice)


def recall_at_k(rec_ids, relevant_ids, k):
    if not relevant_ids:
        return 0.0
    hits = sum(1 for rid in rec_ids[:k] if rid in relevant_ids)
    return hits / len(relevant_ids)


def mrr_at_k(rec_ids, relevant_ids, k):
    for idx, rid in enumerate(rec_ids[:k], start=1):
        if rid in relevant_ids:
            return 1.0 / idx
    return 0.0


def get_popularity_map(cur):
    cur.execute("SELECT title_id, cnt FROM popular_titles")
    rows = cur.fetchall()
    pop_map = {int(r[0]): float(r[1] or 0.0) for r in rows}
    total = sum(pop_map.values()) or 1.0
    return pop_map, total


def fetch_positive_histories(conn):
    sql = """
    WITH user_titles AS (
      SELECT
        user_id,
        title_id,
        MAX(last_ts) AS last_ts,
        SUM(signal)::float AS signal,
        BOOL_OR(in_wishlist) AS in_wishlist,
        BOOL_OR(watched) AS watched,
        MAX(rating) AS rating
      FROM (
        SELECT
          i.user_id,
          i.title_id,
          i.ts AS last_ts,
          GREATEST(COALESCE(i.weight, 0), 0)
            + CASE WHEN i.watched THEN 3 ELSE 0 END
            + CASE WHEN COALESCE(i.rating, 0) >= 4 THEN i.rating ELSE 0 END AS signal,
          FALSE AS in_wishlist,
          COALESCE(i.watched, FALSE) AS watched,
          i.rating AS rating
        FROM interactions i
        WHERE i.title_id IS NOT NULL
          AND (i.watched = TRUE OR i.rating >= 4 OR i.weight >= 1)

        UNION ALL

        SELECT
          w.user_id,
          w.title_id,
          w.ts AS last_ts,
          3.0 AS signal,
          TRUE AS in_wishlist,
          FALSE AS watched,
          NULL::double precision AS rating
        FROM wishlists w
      ) src
      GROUP BY user_id, title_id
    )
    SELECT
      ut.user_id,
      ut.title_id,
      ut.last_ts,
      ut.signal,
      ut.in_wishlist,
      ut.watched,
      ut.rating,
      t.name,
      t.year,
      t.genres,
      COALESCE(pt.cnt, 0)::float AS popularity_count
    FROM user_titles ut
    JOIN titles t ON t.id = ut.title_id
    LEFT JOIN popular_titles pt ON pt.title_id = ut.title_id
    ORDER BY ut.user_id, ut.last_ts ASC, ut.signal ASC, ut.title_id ASC
    """

    by_user = defaultdict(list)
    with conn.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute(sql)
        for row in cur.fetchall():
            by_user[str(row["user_id"])].append(dict(row))
    return by_user


def top_genres_from_rows(rows, topn=5):
    counts = Counter()
    for row in rows or []:
        counts.update(normalize_genres(row.get("genres")))
    return {genre for genre, _ in counts.most_common(topn)}


def fetch_title_genres_map(cur, title_ids):
    ids = sorted({int(title_id) for title_id in title_ids if title_id is not None})
    if not ids:
        return {}

    cur.execute("SELECT id, genres FROM titles WHERE id = ANY(%s::int[])", (ids,))
    return {
        int(row[0]): set(normalize_genres(row[1] or []))
        for row in cur.fetchall()
        if row and row[0] is not None
    }


def fetch_holdout_snapshot(conn, user_id, holdout_ids):
    with conn.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute(
            """
            SELECT user_id, title_id, source, ts
            FROM wishlists
            WHERE user_id = %s AND title_id = ANY(%s::int[])
            ORDER BY ts ASC, title_id ASC, source ASC
            """,
            (str(user_id), sorted(holdout_ids)),
        )
        wishlist_rows = [dict(row) for row in cur.fetchall()]

        cur.execute(
            """
            SELECT user_id, title_id, rating, watched, weight, ts
            FROM interactions
            WHERE user_id = %s AND title_id = ANY(%s::int[])
            ORDER BY ts ASC, title_id ASC
            """,
            (str(user_id), sorted(holdout_ids)),
        )
        interaction_rows = [dict(row) for row in cur.fetchall()]

    return wishlist_rows, interaction_rows


def hide_holdout(conn, user_id, holdout_ids):
    with conn.cursor() as cur:
        cur.execute(
            "DELETE FROM wishlists WHERE user_id = %s AND title_id = ANY(%s::int[])",
            (str(user_id), sorted(holdout_ids)),
        )
        cur.execute(
            "DELETE FROM interactions WHERE user_id = %s AND title_id = ANY(%s::int[])",
            (str(user_id), sorted(holdout_ids)),
        )
    conn.commit()


def restore_holdout(conn, wishlist_rows, interaction_rows):
    with conn.cursor() as cur:
        for row in interaction_rows:
            cur.execute(
                """
                INSERT INTO interactions (user_id, title_id, rating, watched, weight, ts)
                VALUES (%s, %s, %s, %s, %s, %s)
                ON CONFLICT (user_id, title_id)
                DO UPDATE SET
                  rating = EXCLUDED.rating,
                  watched = EXCLUDED.watched,
                  weight = EXCLUDED.weight,
                  ts = EXCLUDED.ts
                """,
                (
                    row["user_id"],
                    row["title_id"],
                    row["rating"],
                    row["watched"],
                    row["weight"],
                    row["ts"],
                ),
            )

        for row in wishlist_rows:
            cur.execute(
                """
                INSERT INTO wishlists (user_id, title_id, source, ts)
                VALUES (%s, %s, %s, %s)
                ON CONFLICT (user_id, title_id, source)
                DO UPDATE SET ts = EXCLUDED.ts
                """,
                (
                    row["user_id"],
                    row["title_id"],
                    row["source"],
                    row["ts"],
                ),
            )
    conn.commit()


def fetch_recommendations(token):
    resp = requests.get(
        f"{API_BASE}{RECS_PATH}",
        params={"topK": TOPK},
        headers={"Authorization": f"Bearer {token}"},
        timeout=REQUEST_TIMEOUT,
    )
    if not resp.ok:
        raise RuntimeError(f"API error: {resp.status_code} {resp.text[:200]}")
    return resp.json().get("items", [])


def metric_summary(rec_ids, relevant_ids):
    out = {}
    for k in METRIC_KS:
        out[f"precision@{k}"] = precision_at_k(rec_ids, relevant_ids, k)
        out[f"recall@{k}"] = recall_at_k(rec_ids, relevant_ids, k)
        out[f"ndcg@{k}"] = ndcg_at_k(rec_ids, relevant_ids, k)
        out[f"hit_rate@{k}"] = hit_rate_at_k(rec_ids, relevant_ids, k)
        out[f"mrr@{k}"] = mrr_at_k(rec_ids, relevant_ids, k)
    return out


def main():
    token = resolve_auth_token()
    token_uid = jwt_user_id(token) if token else None

    conn = psycopg2.connect(DB_URL)
    histories = fetch_positive_histories(conn)
    users = [user_id for user_id, rows in histories.items() if len(rows) >= MIN_HISTORY]
    users = sorted(users)

    if token_uid and not EVAL_ALL_USERS:
        users = [user_id for user_id in users if str(user_id) == str(token_uid)]
    elif MAX_EVAL_USERS > 0:
        users = users[:MAX_EVAL_USERS]

    if not users:
        raise SystemExit(
            f"No users with at least {MIN_HISTORY} positive titles were found for evaluation."
        )

    with conn.cursor() as cur:
        pop_map, pop_total = get_popularity_map(cur)

    print("Evaluating users:", [str(user_id) for user_id in users])
    print("Holdout count:", HOLDOUT_COUNT)
    print("TopK:", TOPK)
    print("Metric Ks:", METRIC_KS)
    print("Max eval users:", MAX_EVAL_USERS or "all")

    coverage = set()
    aggregates = defaultdict(float)
    evaluated = 0

    for user_id in users:
        rows = histories[str(user_id)]
        holdout_rows = rows[-HOLDOUT_COUNT:]
        train_rows = rows[:-HOLDOUT_COUNT]
        if not train_rows:
            print(f"\nUser: {user_id}\nSkipping: not enough remaining history after holdout.")
            continue

        holdout_ids = {int(row["title_id"]) for row in holdout_rows}
        holdout_titles = [
            f"{row['name']} ({row['year']})" if row.get("year") else str(row["name"])
            for row in holdout_rows
        ]
        top_genres = top_genres_from_rows(train_rows, topn=5)

        wishlist_rows, interaction_rows = fetch_holdout_snapshot(conn, user_id, holdout_ids)
        if not wishlist_rows and not interaction_rows:
            print(f"\nUser: {user_id}\nSkipping: could not snapshot holdout rows.")
            continue

        hide_holdout(conn, user_id, holdout_ids)
        try:
            user_token = token or sign_eval_token(user_id)
            items = fetch_recommendations(user_token)
        finally:
            restore_holdout(conn, wishlist_rows, interaction_rows)

        rec_ids = []
        title_lookup = {}
        for item in items:
            rid = item.get("title_id") if item.get("title_id") is not None else item.get("id")
            if rid is None:
                continue
            rid = int(rid)
            rec_ids.append(rid)
            title_lookup[rid] = item.get("title") or item.get("name") or str(rid)

        if not rec_ids:
            print(f"\nUser: {user_id}\nSkipping: recommender returned no ids.")
            continue

        metrics = metric_summary(rec_ids, holdout_ids)
        hit_positions = [
            (idx, rid, title_lookup.get(rid, str(rid)))
            for idx, rid in enumerate(rec_ids, start=1)
            if rid in holdout_ids
        ]

        with conn.cursor() as cur:
            genre_map = fetch_title_genres_map(cur, rec_ids[:TOPK])

        matched = 0
        novelty_score = 0.0
        for rid in rec_ids[:TOPK]:
            coverage.add(rid)
            if genre_map.get(rid, set()) & top_genres:
                matched += 1
            pop = pop_map.get(rid, 0.0)
            p = (pop / pop_total) if pop_total > 0 else 0.0
            novelty_score += -math.log2(max(p, 1e-12))

        genre_match = matched / max(1, len(rec_ids[:TOPK]))
        novelty = novelty_score / max(1, len(rec_ids[:TOPK]))

        print(f"\nUser: {user_id}")
        print("Holdout titles:", holdout_titles)
        print("Hit positions:", hit_positions if hit_positions else "none")
        for k in METRIC_KS:
            print(
                f"Precision@{k}: {metrics[f'precision@{k}']:.3f} | "
                f"Recall@{k}: {metrics[f'recall@{k}']:.3f} | "
                f"NDCG@{k}: {metrics[f'ndcg@{k}']:.3f} | "
                f"HitRate@{k}: {metrics[f'hit_rate@{k}']:.3f} | "
                f"MRR@{k}: {metrics[f'mrr@{k}']:.3f}"
            )
        print(f"Genre-match@{TOPK}: {genre_match:.3f}")
        print(f"Novelty@{TOPK}: {novelty:.3f}")

        for key, value in metrics.items():
            aggregates[key] += value
        aggregates["genre_match"] += genre_match
        aggregates["novelty"] += novelty
        evaluated += 1

    print("\n===== OFFLINE EVALUATION SUMMARY =====")
    print(f"Users evaluated: {evaluated}")
    if evaluated:
        for k in METRIC_KS:
            print(f"Precision@{k}: {aggregates[f'precision@{k}'] / evaluated:.3f}")
            print(f"Recall@{k}: {aggregates[f'recall@{k}'] / evaluated:.3f}")
            print(f"NDCG@{k}: {aggregates[f'ndcg@{k}'] / evaluated:.3f}")
            print(f"HitRate@{k}: {aggregates[f'hit_rate@{k}'] / evaluated:.3f}")
            print(f"MRR@{k}: {aggregates[f'mrr@{k}'] / evaluated:.3f}")
        print(f"Genre-match@{TOPK}: {aggregates['genre_match'] / evaluated:.3f}")
        print(f"Novelty@{TOPK}: {aggregates['novelty'] / evaluated:.3f}")
    else:
        print("No valid users to evaluate.")
    print(f"Coverage@{TOPK}: {len(coverage)} unique titles")

    conn.close()


if __name__ == "__main__":
    main()
