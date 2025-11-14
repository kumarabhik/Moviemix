import os
import time
import requests
import psycopg2
from psycopg2.extras import DictCursor
from dotenv import load_dotenv
load_dotenv()



DATABASE_URL = os.environ.get(
    "DATABASE_URL",
    "postgresql://admin:I4mGr00t@localhost:5432/moviemix",
)
TRAKT_CLIENT_ID = os.environ["TRAKT_CLIENT_ID"]

TRAKT_BASE = "https://api.trakt.tv"
HEADERS = {
    "trakt-api-key": TRAKT_CLIENT_ID,
    "trakt-api-version": "2",
}


def _extract_poster_from_item(item: dict) -> str | None:
    """
    Given a Trakt movie/show dict (with images), extract a poster URL.
    """
    if not isinstance(item, dict):
        return None

    images = item.get("images") or {}
    if not isinstance(images, dict):
        return None

    poster = images.get("poster") or {}
    if not isinstance(poster, dict):
        return None

    return poster.get("full") or poster.get("medium") or poster.get("thumb")


def fetch_trakt_poster_by_slug(slug: str) -> str | None:
    """
    Fetch poster using /movies/{slug}?extended=full,images
    This is the most reliable if we have trakt_slug in the DB.
    """
    if not slug:
        return None

    url = f"{TRAKT_BASE}/movies/{slug}"
    params = {"extended": "full,images"}

    resp = requests.get(url, headers=HEADERS, params=params, timeout=10)
    resp.raise_for_status()

    data = resp.json()

    # Some error responses can be strings or dicts without images
    if not isinstance(data, dict):
        return None

    return _extract_poster_from_item(data)


def fetch_trakt_poster_by_search(title_name: str, year: int | None) -> str | None:
    """
    Fallback: use Trakt /search with extended=full,images to get a poster URL.
    Returns a URL string or None.
    """
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

    # Make sure we actually got a list
    if not isinstance(data, list) or not data:
        return None

    wrapper = data[0]
    if not isinstance(wrapper, dict):
        return None

    item = wrapper.get("movie") or wrapper.get("show")
    if not isinstance(item, dict):
        return None

    return _extract_poster_from_item(item)


def main(batch_size: int = 200):
    conn = psycopg2.connect(DATABASE_URL)
    conn.autocommit = True

    with conn.cursor(cursor_factory=DictCursor) as cur:
        # pick titles with no poster yet
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

        missing = len(rows)
        print(f"[trakt] Titles missing posters: {missing}")
        if not rows:
            print("[trakt] Nothing to do, exiting.")
            return

        updated = 0
        for idx, row in enumerate(rows, start=1):
            tid = row["id"]
            name = row["name"]
            year = row["year"]
            slug = row["trakt_slug"]

            label = f"{tid}: {name} ({year})"
            print(f"[trakt] ({idx}/{missing}) {label}")

            poster_url = None

            # 1) Prefer trakt_slug if present
            try:
                if slug:
                    poster_url = fetch_trakt_poster_by_slug(slug)
            except Exception as e:
                print(f"  → slug lookup error: {e}")

            # 2) Fallback: search by name/year
            if not poster_url:
                try:
                    poster_url = fetch_trakt_poster_by_search(name, year)
                except Exception as e:
                    print(f"  → search error: {e}")

            if not poster_url:
                print("  → no poster found")
                continue

            cur.execute(
                "UPDATE titles SET poster_url = %s WHERE id = %s",
                (poster_url, tid),
            )
            updated += 1
            print("  → updated poster_url")

            # be nice to the API
            time.sleep(0.3)

        print(f"[trakt] Done. Updated {updated} poster URLs.")

    conn.close()


if __name__ == "__main__":
    main()
