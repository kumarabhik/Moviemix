import json
import math
import os
import random
from collections import defaultdict
from datetime import datetime, timedelta, timezone

import psycopg2
from psycopg2.extras import RealDictCursor, execute_batch

DB_URL = os.environ.get("DATABASE_URL")
if not DB_URL:
    raise SystemExit("DATABASE_URL is required")

TOTAL_USERS = int(os.environ.get("TOTAL_USERS", "100"))
GROUP_COUNT = 4
if TOTAL_USERS % GROUP_COUNT != 0:
    raise SystemExit("TOTAL_USERS must be divisible by 4")

USERS_PER_GROUP = TOTAL_USERS // GROUP_COUNT
TITLES_PER_USER = int(os.environ.get("TITLES_PER_USER", "100"))
REVIEWS_PER_USER = int(os.environ.get("REVIEWS_PER_USER", "60"))
if TITLES_PER_USER < 60:
    raise SystemExit("TITLES_PER_USER should be at least 60")
if REVIEWS_PER_USER < 20 or REVIEWS_PER_USER > TITLES_PER_USER:
    raise SystemExit("REVIEWS_PER_USER must be between 20 and TITLES_PER_USER")

SHARED_CORE_COUNT = 35
HOLDOUT_FRESH_COUNT = 3
GROUP_EXTRA_COUNT = 25
RANDOM_TAIL_COUNT = TITLES_PER_USER - SHARED_CORE_COUNT - GROUP_EXTRA_COUNT
if RANDOM_TAIL_COUNT < 20:
    raise SystemExit("TITLES_PER_USER is too small for the configured group composition")

RANDOM_SEED = int(os.environ.get("SEED", "20260319"))
USER_PASSWORD = os.environ.get("SYNTHETIC_USER_PASSWORD", "SyntheticPass123!")
EMAIL_DOMAIN = os.environ.get("SYNTHETIC_EMAIL_DOMAIN", "synthetic.moviemix.local")
EMAIL_PREFIX = os.environ.get("SYNTHETIC_EMAIL_PREFIX", "synthetic")

GROUPS = [
    {
        "slug": "action",
        "primary": {"Action", "Adventure", "Science Fiction"},
        "secondary": {"Thriller", "Fantasy"},
    },
    {
        "slug": "drama",
        "primary": {"Drama", "Crime", "Thriller"},
        "secondary": {"History", "War", "Mystery"},
    },
    {
        "slug": "comedy",
        "primary": {"Comedy", "Romance", "Family"},
        "secondary": {"Music", "Adventure"},
    },
    {
        "slug": "spooky",
        "primary": {"Horror", "Mystery", "Fantasy"},
        "secondary": {"Thriller", "Science Fiction"},
    },
]


def normalize_genres(genres):
    if not isinstance(genres, list):
        return []
    return [str(genre).strip() for genre in genres if str(genre).strip()]


def score_title(title, primary, secondary):
    genres = set(normalize_genres(title.get("genres")))
    primary_hits = len(genres & primary)
    secondary_hits = len(genres & secondary)
    if primary_hits == 0 and secondary_hits == 0:
        return -1.0

    popularity = float(title.get("popularity") or 0.0)
    year = int(title.get("year") or 2000)
    plot_bonus = 0.25 if title.get("plot") else 0.0
    modern_bonus = 0.15 if year >= 1990 else 0.0
    return (
        primary_hits * 3.0
        + secondary_hits * 1.4
        + min(math.log1p(max(popularity, 0.0)), 5.0) * 0.12
        + plot_bonus
        + modern_bonus
    )


def sample_without_replacement(rng, pool_ids, count, excluded_ids):
    available = [title_id for title_id in pool_ids if title_id not in excluded_ids]
    if len(available) < count:
        raise RuntimeError(f"Needed {count} titles but only found {len(available)} available")
    return rng.sample(available, count)


def rating_for_bucket(rng, bucket):
    if bucket == "holdout":
        return rng.choice([4.5, 5.0, 5.0])
    if bucket == "core":
        return rng.choice([4.0, 4.5, 5.0])
    if bucket == "group":
        return rng.choice([3.5, 4.0, 4.5, 5.0])
    return rng.choice([2.5, 3.0, 3.5, 4.0, 4.5])


def weight_for_rating(rating):
    if rating >= 5.0:
        return 6.0
    if rating >= 4.5:
        return 5.2
    if rating >= 4.0:
        return 4.4
    if rating >= 3.5:
        return 3.6
    if rating >= 3.0:
        return 2.8
    return 2.0


def build_review_text(group_slug, title, rating):
    genres = normalize_genres(title.get("genres"))
    genre_text = ", ".join(genres[:2]) if genres else "mixed-genre"
    sentiment = (
        "one of the better picks"
        if rating >= 4.5
        else "pretty enjoyable overall"
        if rating >= 4.0
        else "worth the watch even if it is not a favorite"
    )
    return (
        f"Synthetic {group_slug} profile review: {title['name']} felt {sentiment}. "
        f"The {genre_text} blend fit this user's taste cluster well."
    )


def fetch_titles(cur):
    cur.execute(
        """
        SELECT id, name, year, genres, plot, popularity
        FROM titles
        WHERE name IS NOT NULL
        ORDER BY id ASC
        """
    )
    rows = [dict(row) for row in cur.fetchall()]
    if len(rows) < TITLES_PER_USER:
        raise RuntimeError("Not enough titles in the catalog to seed synthetic users")
    return rows


def fetch_pass_hash(cur):
    cur.execute("SELECT crypt(%s, gen_salt('bf'))", (USER_PASSWORD,))
    row = cur.fetchone()
    if isinstance(row, dict):
        return next(iter(row.values()))
    return row[0]


def refresh_popular_titles(cur):
    cur.execute(
        """
        SELECT 1
        FROM pg_matviews
        WHERE schemaname = 'public' AND matviewname = 'popular_titles'
        """
    )
    if cur.fetchone():
        cur.execute("REFRESH MATERIALIZED VIEW popular_titles")


def main():
    rng = random.Random(RANDOM_SEED)
    conn = psycopg2.connect(DB_URL)
    conn.autocommit = False

    with conn.cursor(cursor_factory=RealDictCursor) as cur:
        titles = fetch_titles(cur)
        title_by_id = {int(row["id"]): row for row in titles}
        pass_hash = fetch_pass_hash(cur)

        cur.execute("DELETE FROM users WHERE email LIKE %s", (f"{EMAIL_PREFIX}.%@{EMAIL_DOMAIN}",))
        conn.commit()

        group_catalogs = []
        all_title_ids = [int(row["id"]) for row in titles]
        for group in GROUPS:
            scored = []
            for title in titles:
                score = score_title(title, group["primary"], group["secondary"])
                if score < 0:
                    continue
                scored.append((score, float(title.get("popularity") or 0.0), int(title["id"])))

            scored.sort(key=lambda item: (item[0], item[1], -item[2]), reverse=True)
            ranked_ids = [title_id for _, _, title_id in scored]
            if len(ranked_ids) < SHARED_CORE_COUNT + GROUP_EXTRA_COUNT + 50:
                raise RuntimeError(f"Group {group['slug']} does not have enough matching titles")

            group_catalogs.append(
                {
                    **group,
                    "shared_core_ids": ranked_ids[:SHARED_CORE_COUNT],
                    "group_pool_ids": ranked_ids[SHARED_CORE_COUNT : SHARED_CORE_COUNT + 300],
                    "holdout_ids": ranked_ids[:HOLDOUT_FRESH_COUNT],
                }
            )

        summary = defaultdict(int)
        per_group_examples = {}

        for group_index, group in enumerate(group_catalogs, start=1):
            shared_core_ids = list(group["shared_core_ids"])
            holdout_ids = list(group["holdout_ids"])
            core_regular_ids = [title_id for title_id in shared_core_ids if title_id not in holdout_ids]

            for user_index in range(1, USERS_PER_GROUP + 1):
                email = f"{EMAIL_PREFIX}.{group['slug']}.{user_index:02d}@{EMAIL_DOMAIN}"
                created_at = datetime.now(timezone.utc) - timedelta(
                    days=rng.randint(45, 240),
                    minutes=rng.randint(0, 720),
                )

                cur.execute(
                    """
                    INSERT INTO users (email, pass_hash, created_at)
                    VALUES (%s, %s, %s)
                    RETURNING id
                    """,
                    (email, pass_hash, created_at),
                )
                user_id = str(cur.fetchone()["id"])

                selected_ids = set(shared_core_ids)
                group_extra_ids = sample_without_replacement(
                    rng,
                    group["group_pool_ids"],
                    GROUP_EXTRA_COUNT,
                    selected_ids,
                )
                selected_ids.update(group_extra_ids)
                random_tail_ids = sample_without_replacement(
                    rng,
                    all_title_ids,
                    RANDOM_TAIL_COUNT,
                    selected_ids,
                )
                selected_ids.update(random_tail_ids)

                if len(selected_ids) != TITLES_PER_USER:
                    raise RuntimeError(
                        f"Expected {TITLES_PER_USER} titles for {email}, got {len(selected_ids)}"
                    )

                reviewed_group_ids = sample_without_replacement(
                    rng,
                    group_extra_ids,
                    min(15, len(group_extra_ids)),
                    set(),
                )
                reviewed_random_ids = sample_without_replacement(
                    rng,
                    random_tail_ids,
                    REVIEWS_PER_USER - len(shared_core_ids) - len(reviewed_group_ids),
                    set(),
                )
                reviewed_ids = set(shared_core_ids) | set(reviewed_group_ids) | set(reviewed_random_ids)

                wishlist_order = list(random_tail_ids) + list(group_extra_ids) + core_regular_ids + holdout_ids
                review_order = [title_id for title_id in wishlist_order if title_id in reviewed_ids]

                wishlist_rows = []
                interaction_rows = []
                review_rows = []
                event_rows = []

                wishlist_start = created_at + timedelta(days=1)
                review_start = wishlist_start + timedelta(days=5)
                review_rank = {title_id: idx for idx, title_id in enumerate(review_order)}

                for offset, title_id in enumerate(wishlist_order):
                    ts = wishlist_start + timedelta(minutes=offset * 11 + rng.randint(0, 4))
                    wishlist_rows.append((user_id, int(title_id), "app", ts))
                    event_rows.append(
                        (
                            user_id,
                            int(title_id),
                            "wishlist_add",
                            json.dumps({"seed": "synthetic", "group": group["slug"]}),
                            ts,
                        )
                    )

                for title_id in review_order:
                    if title_id in holdout_ids:
                        bucket = "holdout"
                    elif title_id in shared_core_ids:
                        bucket = "core"
                    elif title_id in group_extra_ids:
                        bucket = "group"
                    else:
                        bucket = "random"

                    rating = rating_for_bucket(rng, bucket)
                    weight = weight_for_rating(rating)
                    review_ts = review_start + timedelta(
                        minutes=review_rank[title_id] * 13 + rng.randint(0, 5)
                    )
                    title = title_by_id[int(title_id)]

                    interaction_rows.append(
                        (
                            user_id,
                            int(title_id),
                            rating,
                            True,
                            weight,
                            review_ts,
                        )
                    )
                    review_rows.append(
                        (
                            user_id,
                            int(title_id),
                            rating,
                            build_review_text(group["slug"], title, rating),
                            review_ts,
                            review_ts,
                        )
                    )
                    event_rows.append(
                        (
                            user_id,
                            int(title_id),
                            "watched",
                            json.dumps({"seed": "synthetic", "group": group["slug"]}),
                            review_ts - timedelta(minutes=2),
                        )
                    )
                    event_rows.append(
                        (
                            user_id,
                            int(title_id),
                            "rating",
                            json.dumps(
                                {
                                    "seed": "synthetic",
                                    "group": group["slug"],
                                    "rating": rating,
                                }
                            ),
                            review_ts,
                        )
                    )

                execute_batch(
                    cur,
                    """
                    INSERT INTO wishlists (user_id, title_id, source, ts)
                    VALUES (%s, %s, %s, %s)
                    ON CONFLICT (user_id, title_id, source) DO UPDATE SET ts = EXCLUDED.ts
                    """,
                    wishlist_rows,
                    page_size=200,
                )
                execute_batch(
                    cur,
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
                    interaction_rows,
                    page_size=200,
                )
                execute_batch(
                    cur,
                    """
                    INSERT INTO reviews (user_id, title_id, rating, review_text, created_at, updated_at)
                    VALUES (%s, %s, %s, %s, %s, %s)
                    ON CONFLICT (user_id, title_id)
                    DO UPDATE SET
                      rating = EXCLUDED.rating,
                      review_text = EXCLUDED.review_text,
                      updated_at = EXCLUDED.updated_at
                    """,
                    review_rows,
                    page_size=200,
                )
                execute_batch(
                    cur,
                    """
                    INSERT INTO interaction_events (user_id, title_id, event, meta, created_at)
                    VALUES (%s, %s, %s, %s::jsonb, %s)
                    """,
                    event_rows,
                    page_size=300,
                )

                summary["users"] += 1
                summary["wishlists"] += len(wishlist_rows)
                summary["interactions"] += len(interaction_rows)
                summary["reviews"] += len(review_rows)
                summary["events"] += len(event_rows)

            per_group_examples[group["slug"]] = {
                "shared_core": [title_by_id[title_id]["name"] for title_id in shared_core_ids[:5]],
                "fresh_holdouts": [title_by_id[title_id]["name"] for title_id in holdout_ids],
            }

        refresh_popular_titles(cur)
        conn.commit()

    print("Synthetic seeding complete")
    print(f"Seed: {RANDOM_SEED}")
    print(f"Users created: {summary['users']}")
    print(f"Wishlist rows: {summary['wishlists']}")
    print(f"Interaction rows: {summary['interactions']}")
    print(f"Review rows: {summary['reviews']}")
    print(f"Event rows: {summary['events']}")
    print(f"Users per group: {USERS_PER_GROUP}")
    for group_slug, example in per_group_examples.items():
        print(f"\nGroup: {group_slug}")
        print("Shared core sample:", example["shared_core"])
        print("Fresh holdouts:", example["fresh_holdouts"])

    conn.close()


if __name__ == "__main__":
    main()
