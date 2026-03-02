import csv
import math
import os
from collections import defaultdict

import psycopg2
import requests
from psycopg2.extras import RealDictCursor

DATABASE_URL = os.environ.get("DATABASE_URL")
if not DATABASE_URL:
    raise SystemExit("DATABASE_URL is required")

BACKEND_URL = os.environ.get("BACKEND_URL", "http://localhost:8000")
TOPK = int(os.environ.get("TOPK", "30"))
OUT_CSV = os.path.join("data", "xgb_rerank_dataset.csv")


def get_conn():
    return psycopg2.connect(DATABASE_URL)


def fetch_popularity_map(conn):
    pop_map = defaultdict(int)
    with conn.cursor(cursor_factory=RealDictCursor) as cur:
        try:
            cur.execute("SELECT title_id, cnt FROM popular_titles;")
            for row in cur.fetchall():
                pop_map[row["title_id"]] = row["cnt"] or 0
        except Exception as e:
            print("Warning: could not read popular_titles:", e)
    return pop_map


def fetch_users_with_wishlist(conn, min_items=2):
    with conn.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute(
            """
            SELECT user_id, COUNT(*) AS c
            FROM wishlists
            WHERE source = 'app'
            GROUP BY user_id
            HAVING COUNT(*) >= %s;
            """,
            (min_items,),
        )
        rows = cur.fetchall()
    return [r["user_id"] for r in rows]


def fetch_user_wishlist(conn, user_id):
    with conn.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute(
            """
            SELECT w.title_id, t.name, t.year, t.genres
            FROM wishlists w
            JOIN titles t ON t.id = w.title_id
            WHERE w.user_id = %s AND w.source = 'app';
            """,
            (user_id,),
        )
        return cur.fetchall()


def genre_overlap(g1, g2):
    if not g1 or not g2:
        return 0
    return len(set(g1) & set(g2))


def build_dataset():
    os.makedirs("data", exist_ok=True)
    conn = get_conn()

    pop_map = fetch_popularity_map(conn)
    users = fetch_users_with_wishlist(conn, min_items=1)
    print(f"Found {len(users)} users with wishlist entries")

    rows = []
    for user_id in users:
        wishlist_items = fetch_user_wishlist(conn, user_id)
        if not wishlist_items:
            continue

        wishlist_ids = {w["title_id"] for w in wishlist_items}
        all_user_genres = set()
        for w in wishlist_items:
            if w["genres"]:
                all_user_genres.update(w["genres"])

        print(f"User {user_id} with {len(wishlist_ids)} wishlist titles")

        for w in wishlist_items:
            seed_title_id = w["title_id"]
            seed_name = w["name"]
            seed_year = w["year"]
            seed_genres = w["genres"] or []
            if not seed_name:
                continue

            try:
                resp = requests.get(
                    f"{BACKEND_URL}/api/recs/semantic",
                    params={"query": seed_name, "topK": TOPK},
                    timeout=10,
                )
                resp.raise_for_status()
            except Exception as e:
                print(f"Semantic call failed for '{seed_name}':", e)
                continue

            items = resp.json().get("items") or []
            for it in items:
                cand_id = it.get("title_id") or it.get("id")
                if not cand_id:
                    continue

                semantic_score = float(it.get("score") or 0.0)
                pop_cnt = pop_map.get(cand_id, 0)
                cand_year = it.get("year")
                cand_genres = it.get("genres") or []

                rows.append(
                    {
                        "user_id": str(user_id),
                        "seed_title_id": seed_title_id,
                        "cand_title_id": cand_id,
                        "semantic_score": semantic_score,
                        "log_popularity": math.log1p(pop_cnt),
                        "same_year": 1
                        if (seed_year and cand_year and seed_year == cand_year)
                        else 0,
                        "genre_overlap_seed": genre_overlap(seed_genres, cand_genres),
                        "genre_overlap_user": genre_overlap(
                            list(all_user_genres), cand_genres
                        ),
                        "in_user_wishlist": 1 if cand_id in wishlist_ids else 0,
                        "label": 1 if cand_id in wishlist_ids else 0,
                    }
                )

    conn.close()

    if not rows:
        print("No rows built - maybe not enough wishlist data.")
        return

    with open(OUT_CSV, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
        writer.writeheader()
        writer.writerows(rows)

    print(f"Wrote {len(rows)} rows to {OUT_CSV}")


if __name__ == "__main__":
    build_dataset()

