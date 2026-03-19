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
TOPK = int(os.environ.get("TOPK", "50"))
MAX_SEEDS = int(os.environ.get("MAX_SEEDS", "3"))
MAX_FUTURE_POSITIVES = int(os.environ.get("MAX_FUTURE_POSITIVES", "3"))
MAX_NEGATIVES_PER_QUERY = int(os.environ.get("MAX_NEGATIVES_PER_QUERY", "80"))
MAX_CUTOFFS_PER_USER = int(os.environ.get("MAX_CUTOFFS_PER_USER", "15"))
USER_EMAIL_LIKE = os.environ.get("USER_EMAIL_LIKE", "").strip()
OUT_CSV = os.path.join("data", "xgb_rerank_dataset.csv")
POSITIVE_SIGNAL_TEMP_TABLE = "tmp_xgb_positive_signals"
SEMANTIC_CACHE = {}
TITLE_META_CACHE = None

FEATURE_COLUMNS = [
    "semantic_score",
    "log_popularity",
    "same_year",
    "genre_overlap_seed",
    "genre_overlap_user",
    "in_user_wishlist",
    "user_user_cf",
    "user_user_supporters",
    "source_semantic",
    "source_popular",
    "source_neighbor",
    "seen_by_user",
    "novelty_score",
]


def get_conn():
    return psycopg2.connect(DATABASE_URL)


def prepare_positive_signal_table(conn):
    with conn.cursor() as cur:
        cur.execute(f"DROP TABLE IF EXISTS {POSITIVE_SIGNAL_TEMP_TABLE}")
        cur.execute(
            f"""
            CREATE TEMP TABLE {POSITIVE_SIGNAL_TEMP_TABLE} AS
            SELECT
              user_id,
              title_id,
              SUM(signal)::float AS strength
            FROM (
              SELECT
                i.user_id,
                i.title_id,
                GREATEST(COALESCE(i.weight, 0), 0)
                  + CASE WHEN i.watched THEN 3 ELSE 0 END
                  + CASE WHEN COALESCE(i.rating, 0) >= 4 THEN i.rating ELSE 0 END AS signal
              FROM interactions i
              WHERE i.title_id IS NOT NULL
                AND (i.watched = TRUE OR i.rating >= 4 OR i.weight >= 1)

              UNION ALL

              SELECT
                w.user_id,
                w.title_id,
                3.0 AS signal
              FROM wishlists w
            ) src
            GROUP BY user_id, title_id
            """
        )
        cur.execute(
            f"CREATE INDEX {POSITIVE_SIGNAL_TEMP_TABLE}_title_user_idx "
            f"ON {POSITIVE_SIGNAL_TEMP_TABLE} (title_id, user_id)"
        )
        cur.execute(
            f"CREATE INDEX {POSITIVE_SIGNAL_TEMP_TABLE}_user_title_idx "
            f"ON {POSITIVE_SIGNAL_TEMP_TABLE} (user_id, title_id)"
        )
        cur.execute(f"ANALYZE {POSITIVE_SIGNAL_TEMP_TABLE}")
    conn.commit()


def to_float(value, fallback=0.0):
    try:
        num = float(value)
        if math.isfinite(num):
            return num
    except Exception:
        pass
    return fallback


def normalize_genres(genres):
    if not isinstance(genres, list):
        return []
    return [str(g).strip().lower() for g in genres if str(g).strip()]


def genre_jaccard(left, right):
    a = set(normalize_genres(left))
    b = set(normalize_genres(right))
    if not a or not b:
        return 0.0
    return len(a & b) / len(a | b)


def novelty_from_popularity(popularity_count):
    return 1.0 / math.log2(to_float(popularity_count, 0.0) + 2.0)


def log_cf_score(value):
    return math.log1p(max(to_float(value, 0.0), 0.0))


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
    ORDER BY ut.user_id, ut.last_ts ASC, ut.signal ASC
    """
    by_user = defaultdict(list)
    with conn.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute(sql)
        for row in cur.fetchall():
            by_user[str(row["user_id"])].append(dict(row))
    return by_user


def filter_histories_by_email(conn, histories_by_user):
    if not USER_EMAIL_LIKE:
        return histories_by_user

    user_ids = list(histories_by_user.keys())
    if not user_ids:
        return histories_by_user

    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT id::text
            FROM users
            WHERE id::text = ANY(%s::text[])
              AND email ILIKE %s
            """,
            (user_ids, USER_EMAIL_LIKE),
        )
        allowed_ids = {str(row[0]) for row in cur.fetchall()}

    return {user_id: rows for user_id, rows in histories_by_user.items() if user_id in allowed_ids}


def sampled_cutoffs(entry_count):
    total_cutoffs = max(0, int(entry_count) - 1)
    if total_cutoffs <= 0:
        return []

    all_cutoffs = list(range(1, total_cutoffs + 1))
    if MAX_CUTOFFS_PER_USER <= 0 or total_cutoffs <= MAX_CUTOFFS_PER_USER:
        return all_cutoffs

    sampled = {1, total_cutoffs}
    for idx in range(MAX_CUTOFFS_PER_USER):
        cutoff = 1 + round(idx * (total_cutoffs - 1) / max(1, MAX_CUTOFFS_PER_USER - 1))
        sampled.add(min(total_cutoffs, max(1, cutoff)))

    # Keep the tail dense so "recent favorites" are still represented.
    recent_start = max(1, total_cutoffs - 4)
    sampled.update(range(recent_start, total_cutoffs + 1))
    return sorted(sampled)


def fetch_title_rows_by_ids(conn, title_ids):
    global TITLE_META_CACHE

    unique_ids = sorted(
        {
            int(tid)
            for tid in (title_ids or [])
            if tid is not None and str(tid).strip()
        }
    )
    if not unique_ids:
        return {}

    if TITLE_META_CACHE is None:
        sql = """
        SELECT
          t.id,
          t.name,
          t.year,
          t.genres,
          COALESCE(pt.cnt, 0)::float AS popularity_count
        FROM titles t
        LEFT JOIN popular_titles pt ON pt.title_id = t.id
        """
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(sql)
            TITLE_META_CACHE = {int(row["id"]): dict(row) for row in cur.fetchall()}

    return {
        title_id: TITLE_META_CACHE[title_id]
        for title_id in unique_ids
        if title_id in TITLE_META_CACHE
    }


def fetch_popular_candidates(conn, limit):
    sql = """
    SELECT
      t.id AS title_id,
      t.name AS title,
      t.year,
      t.genres,
      COALESCE(pt.cnt, 0)::float AS popularity_count
    FROM titles t
    LEFT JOIN popular_titles pt ON pt.title_id = t.id
    ORDER BY COALESCE(pt.cnt, 0) DESC, t.popularity DESC NULLS LAST, t.id ASC
    LIMIT %s
    """
    with conn.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute(sql, (limit,))
        return [
            {
                **dict(row),
                "source_popular": 1,
            }
            for row in cur.fetchall()
        ]


def fetch_semantic_candidates(conn, seed_rows, target):
    seeds = list(seed_rows or [])[-MAX_SEEDS:]
    if not seeds:
        return []

    collected = {}
    for seed in seeds:
        title = str(seed.get("name") or seed.get("title") or "").strip()
        seed_id = int(seed.get("title_id") or seed.get("id") or 0)
        if not title:
            continue

        cache_key = title.lower()
        cached_items = SEMANTIC_CACHE.get(cache_key)
        if cached_items is None:
            try:
                resp = requests.get(
                    f"{BACKEND_URL}/api/recs/semantic",
                    params={"query": title, "topK": max(target * 2, 40)},
                    timeout=30,
                )
                resp.raise_for_status()
                cached_items = list(resp.json().get("items") or [])
            except Exception as exc:
                print(f"[xgb-dataset] semantic fetch failed for '{title}': {exc}")
                cached_items = []
            SEMANTIC_CACHE[cache_key] = cached_items

        for item in cached_items:
            cand_id = int(item.get("title_id") or item.get("id") or 0)
            if cand_id <= 0 or cand_id == seed_id:
                continue

            row = collected.setdefault(
                cand_id,
                {
                    "title_id": cand_id,
                    "semantic_score": 0.0,
                    "source_semantic": 0,
                },
            )
            row["semantic_score"] = max(
                row["semantic_score"],
                to_float(item.get("score") or item.get("similarity"), 0.0),
            )
            row["source_semantic"] = 1

    meta_by_id = fetch_title_rows_by_ids(conn, collected.keys())
    out = []
    for cand_id, item in collected.items():
        meta = meta_by_id.get(cand_id)
        if not meta:
            continue
        out.append(
            {
                "title_id": cand_id,
                "title": meta.get("name"),
                "year": meta.get("year"),
                "genres": meta.get("genres"),
                "popularity_count": to_float(meta.get("popularity_count"), 0.0),
                "semantic_score": to_float(item["semantic_score"], 0.0),
                "source_semantic": 1,
            }
        )
    return out


def fetch_user_user_candidates(conn, user_id, history_ids, limit):
    unique_ids = sorted({int(tid) for tid in (history_ids or []) if tid})
    if not unique_ids:
        return []

    sql = """
    WITH my_titles AS (
      SELECT UNNEST(%s::int[]) AS title_id
    ),
    neighbors AS (
      SELECT
        ps.user_id,
        COUNT(*)::int AS overlap_items,
        SUM(ps.strength)::float AS overlap_strength
      FROM tmp_xgb_positive_signals ps
      JOIN my_titles mt ON mt.title_id = ps.title_id
      WHERE ps.user_id <> %s
      GROUP BY ps.user_id
      HAVING COUNT(*) >= 1
      ORDER BY overlap_strength DESC, overlap_items DESC
      LIMIT 50
    ),
    neighbor_titles AS (
      SELECT
        ps.title_id,
        SUM(n.overlap_strength * ps.strength)::float AS cf_score,
        COUNT(DISTINCT ps.user_id)::int AS supporter_count
      FROM tmp_xgb_positive_signals ps
      JOIN neighbors n ON n.user_id = ps.user_id
      LEFT JOIN my_titles mt ON mt.title_id = ps.title_id
      WHERE mt.title_id IS NULL
      GROUP BY ps.title_id
      ORDER BY cf_score DESC, supporter_count DESC
      LIMIT %s
    )
    SELECT
      t.id AS title_id,
      t.name AS title,
      t.year,
      t.genres,
      COALESCE(pt.cnt, 0)::float AS popularity_count,
      nt.cf_score,
      nt.supporter_count
    FROM neighbor_titles nt
    JOIN titles t ON t.id = nt.title_id
    LEFT JOIN popular_titles pt ON pt.title_id = nt.title_id
    ORDER BY nt.cf_score DESC, nt.supporter_count DESC
    LIMIT %s
    """
    with conn.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute(sql, (unique_ids, user_id, limit, limit))
        rows = cur.fetchall()

    return [
        {
            **dict(row),
            "user_user_cf": log_cf_score(row["cf_score"]),
            "user_user_supporters": math.log1p(to_float(row["supporter_count"], 0.0)),
            "source_neighbor": 1,
        }
        for row in rows
    ]


def merge_candidates(candidates, seed_rows, user_genres, wishlist_ids, seen_ids):
    by_id = {}

    for raw in candidates:
        cand_id = int(raw.get("title_id") or raw.get("id") or 0)
        if cand_id <= 0:
            continue

        item = by_id.setdefault(
            cand_id,
            {
                "title_id": cand_id,
                "title": None,
                "year": None,
                "genres": [],
                "popularity_count": 0.0,
                "semantic_score": 0.0,
                "user_user_cf": 0.0,
                "user_user_supporters": 0.0,
                "source_semantic": 0,
                "source_popular": 0,
                "source_neighbor": 0,
            },
        )

        item["title"] = item["title"] or raw.get("title") or raw.get("name")
        item["year"] = item["year"] if item["year"] is not None else raw.get("year")
        item["genres"] = item["genres"] or raw.get("genres") or []
        item["popularity_count"] = max(
            item["popularity_count"], to_float(raw.get("popularity_count"), 0.0)
        )
        item["semantic_score"] = max(
            item["semantic_score"], to_float(raw.get("semantic_score"), 0.0)
        )
        item["user_user_cf"] = max(
            item["user_user_cf"], to_float(raw.get("user_user_cf"), 0.0)
        )
        item["user_user_supporters"] = max(
            item["user_user_supporters"],
            to_float(raw.get("user_user_supporters"), 0.0),
        )
        item["source_semantic"] = 1 if (item["source_semantic"] or raw.get("source_semantic")) else 0
        item["source_popular"] = 1 if (item["source_popular"] or raw.get("source_popular")) else 0
        item["source_neighbor"] = 1 if (item["source_neighbor"] or raw.get("source_neighbor")) else 0

    rows = []
    for item in by_id.values():
        genre_overlap_seed = 0.0
        if seed_rows:
            genre_overlap_seed = max(
                [genre_jaccard(item["genres"], seed.get("genres") or []) for seed in seed_rows]
                + [0.0]
            )

        same_year = 0
        for seed in seed_rows:
            if seed.get("year") and item.get("year") and int(seed["year"]) == int(item["year"]):
                same_year = 1
                break

        rows.append(
            {
                **item,
                "log_popularity": math.log1p(to_float(item["popularity_count"], 0.0)),
                "same_year": same_year,
                "genre_overlap_seed": genre_overlap_seed,
                "genre_overlap_user": genre_jaccard(item["genres"], user_genres),
                "in_user_wishlist": 1 if item["title_id"] in wishlist_ids else 0,
                "seen_by_user": 1 if item["title_id"] in seen_ids else 0,
                "novelty_score": novelty_from_popularity(item["popularity_count"]),
            }
        )
    return rows


def candidate_rank_score(row):
    return (
        to_float(row.get("semantic_score"), 0.0) * 1.0
        + to_float(row.get("user_user_cf"), 0.0) * 0.35
        + to_float(row.get("genre_overlap_seed"), 0.0) * 0.25
        + to_float(row.get("genre_overlap_user"), 0.0) * 0.2
        + to_float(row.get("log_popularity"), 0.0) * 0.08
        + to_float(row.get("source_neighbor"), 0.0) * 0.05
        + to_float(row.get("source_semantic"), 0.0) * 0.03
        - to_float(row.get("seen_by_user"), 0.0) * 0.08
    )


def positive_label_from_signal(signal):
    s = max(to_float(signal, 0.0), 0.0)
    if s >= 7:
        return 3.0
    if s >= 4:
        return 2.0
    return 1.0


def build_dataset():
    os.makedirs("data", exist_ok=True)
    conn = get_conn()
    prepare_positive_signal_table(conn)

    histories_by_user = filter_histories_by_email(conn, fetch_positive_histories(conn))
    popular_candidates = fetch_popular_candidates(conn, TOPK * 2)
    total_users = len(histories_by_user)
    print(f"[xgb-dataset] users with positive history: {total_users}")

    rows = []
    query_count = 0
    users_used = 0
    positives_total = 0

    for user_id, entries in histories_by_user.items():
        if len(entries) < 3:
            continue

        users_used += 1
        for cutoff in sampled_cutoffs(len(entries)):
            history = entries[:cutoff]
            future = entries[cutoff : cutoff + MAX_FUTURE_POSITIVES]
            if not history or not future:
                continue

            history_ids = [int(row["title_id"]) for row in history]
            seed_rows = history[-MAX_SEEDS:]
            user_genres = list(
                {genre for row in history for genre in normalize_genres(row.get("genres"))}
            )
            wishlist_ids = {
                int(row["title_id"]) for row in history if bool(row.get("in_wishlist"))
            }
            seen_ids = {int(row["title_id"]) for row in history}

            future_by_id = {int(row["title_id"]): row for row in future}
            positive_ids = set(future_by_id.keys())

            semantic_candidates = fetch_semantic_candidates(conn, seed_rows, TOPK)
            user_user_candidates = fetch_user_user_candidates(conn, user_id, history_ids, TOPK * 2)
            merged = merge_candidates(
                [*popular_candidates, *semantic_candidates, *user_user_candidates],
                seed_rows,
                user_genres,
                wishlist_ids,
                seen_ids,
            )

            missing_positive_ids = [
                positive_id
                for positive_id in positive_ids
                if not any(int(row["title_id"]) == positive_id for row in merged)
            ]
            if missing_positive_ids:
                positive_meta = fetch_title_rows_by_ids(conn, missing_positive_ids)
                inject = []
                for positive_id in missing_positive_ids:
                    meta = positive_meta.get(int(positive_id))
                    if not meta:
                        continue
                    inject.append(
                        {
                            "title_id": int(meta["id"]),
                            "title": meta.get("name"),
                            "year": meta.get("year"),
                            "genres": meta.get("genres"),
                            "popularity_count": to_float(meta.get("popularity_count"), 0.0),
                        }
                    )
                if inject:
                    merged.extend(
                        merge_candidates(
                            inject,
                            seed_rows,
                            user_genres,
                            wishlist_ids,
                            seen_ids,
                        )
                    )

            merged = sorted(merged, key=candidate_rank_score, reverse=True)
            positives = [row for row in merged if int(row["title_id"]) in positive_ids]
            negatives = [row for row in merged if int(row["title_id"]) not in positive_ids]
            negatives = negatives[:MAX_NEGATIVES_PER_QUERY]
            query_rows = positives + negatives

            if not positives or not query_rows:
                continue

            query_id = f"{user_id}:{cutoff}"
            query_count += 1

            for candidate in query_rows:
                future_row = future_by_id.get(int(candidate["title_id"]))
                label = positive_label_from_signal(future_row["signal"]) if future_row else 0.0
                row = {
                    "query_id": query_id,
                    "user_id": user_id,
                    "history_size": len(history),
                    "future_size": len(future),
                    "cand_title_id": int(candidate["title_id"]),
                    "label": label,
                }
                for feature in FEATURE_COLUMNS:
                    row[feature] = to_float(candidate.get(feature), 0.0)
                rows.append(row)
                if label > 0:
                    positives_total += 1

        if users_used % 25 == 0:
            print(
                f"[xgb-dataset] users_used={users_used} queries={query_count} rows={len(rows)} "
                f"positives={positives_total}"
            )

    conn.close()

    if not rows:
        print("[xgb-dataset] no rows built; ensure you have interactions or wishlist data.")
        return

    with open(OUT_CSV, "w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(rows[0].keys()))
        writer.writeheader()
        writer.writerows(rows)

    print(f"[xgb-dataset] wrote {len(rows)} rows -> {OUT_CSV}")
    print(
        f"[xgb-dataset] users_used={users_used} queries={query_count} positives={positives_total}"
    )


if __name__ == "__main__":
    build_dataset()
