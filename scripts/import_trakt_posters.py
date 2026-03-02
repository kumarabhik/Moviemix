import os
import time

import psycopg2
import requests
from dotenv import load_dotenv
from psycopg2.extras import DictCursor

load_dotenv()

DATABASE_URL = os.environ.get("DATABASE_URL")
if not DATABASE_URL:
    raise SystemExit("DATABASE_URL is required")

TRAKT_CLIENT_ID = os.environ.get("TRAKT_CLIENT_ID")
if not TRAKT_CLIENT_ID:
    raise SystemExit("TRAKT_CLIENT_ID is required")

TRAKT_BASE = "https://api.trakt.tv"
HEADERS = {
    "trakt-api-key": TRAKT_CLIENT_ID,
    "trakt-api-version": "2",
}


def extract_poster_from_item(item):
    if not isinstance(item, dict):
        return None
    images = item.get("images") or {}
    if not isinstance(images, dict):
        return None
    poster = images.get("poster") or {}
    if not isinstance(poster, dict):
        return None
    return poster.get("full") or poster.get("medium") or poster.get("thumb")


def fetch_trakt_poster_by_slug(slug):
    if not slug:
        return None
    resp = requests.get(
        f"{TRAKT_BASE}/movies/{slug}",
        headers=HEADERS,
        params={"extended": "full,images"},
        timeout=10,
    )
    resp.raise_for_status()
    data = resp.json()
    if not isinstance(data, dict):
        return None
    return extract_poster_from_item(data)


def fetch_trakt_poster_by_search(title_name, year):
    if not title_name:
        return None
    params = {
        "query": title_name,
        "type": "movie",
        "limit": 1,
        "extended": "full,images",
    }
    if year:
        params["year"] = year
    resp = requests.get(
        f"{TRAKT_BASE}/search",
        headers=HEADERS,
        params=params,
        timeout=10,
    )
    resp.raise_for_status()
    data = resp.json()
    if not isinstance(data, list) or not data:
        return None
    wrapper = data[0]
    item = wrapper.get("movie") if isinstance(wrapper, dict) else None
    if not isinstance(item, dict):
        return None
    return extract_poster_from_item(item)


def main(batch_size=200):
    conn = psycopg2.connect(DATABASE_URL)
    conn.autocommit = True

    with conn.cursor(cursor_factory=DictCursor) as cur:
        cur.execute(
            """
            SELECT id, name, year, trakt_slug
            FROM titles
            WHERE poster_url IS NULL
            ORDER BY popularity DESC NULLS LAST, id ASC
            LIMIT %s
            """,
            (batch_size,),
        )
        rows = cur.fetchall()
        total = len(rows)
        print(f"[trakt] Titles missing posters: {total}")
        if not rows:
            return

        updated = 0
        for idx, row in enumerate(rows, start=1):
            tid = row["id"]
            name = row["name"]
            year = row["year"]
            slug = row["trakt_slug"]
            print(f"[trakt] ({idx}/{total}) {tid}: {name} ({year})")

            poster_url = None
            try:
                if slug:
                    poster_url = fetch_trakt_poster_by_slug(slug)
            except Exception as e:
                print(f"  slug lookup error: {e}")

            if not poster_url:
                try:
                    poster_url = fetch_trakt_poster_by_search(name, year)
                except Exception as e:
                    print(f"  search error: {e}")

            if not poster_url:
                print("  no poster found")
                continue

            cur.execute("UPDATE titles SET poster_url = %s WHERE id = %s", (poster_url, tid))
            updated += 1
            print("  updated poster_url")
            time.sleep(0.3)

        print(f"[trakt] Done. Updated {updated} poster URLs.")

    conn.close()


if __name__ == "__main__":
    main()

