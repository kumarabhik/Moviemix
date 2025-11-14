import os
import math
import requests
import psycopg2
from psycopg2.extras import execute_batch

TRAKT_CLIENT_ID = os.environ.get("TRAKT_CLIENT_ID")
if not TRAKT_CLIENT_ID:
    raise SystemExit("TRAKT_CLIENT_ID not set in env")

DATABASE_URL = os.environ.get(
    "DATABASE_URL",
    "postgresql://admin:I4mGr00t@localhost:5432/moviemix",
)

BASE_URL = "https://api.trakt.tv"
HEADERS = {
    "Content-Type": "application/json",
    "trakt-api-key": TRAKT_CLIENT_ID,
    "trakt-api-version": "2",
}


def fetch_popular_movies(pages=5, per_page=50):
    movies = []
    for page in range(1, pages + 1):
        r = requests.get(
            f"{BASE_URL}/movies/popular",
            params={"page": page, "limit": per_page},
            headers=HEADERS,
            timeout=15,
        )
        r.raise_for_status()
        chunk = r.json()
        if not chunk:
            break
        movies.extend(chunk)
    return movies


def main():
    movies = fetch_popular_movies(pages=5, per_page=50)
    print(f"Fetched {len(movies)} movies from Trakt")

    conn = psycopg2.connect(DATABASE_URL)
    cur = conn.cursor()

    rows = []
    for m in movies:
        title = m.get("title")
        year = m.get("year")
        ids = m.get("ids") or {}
        imdb_id = ids.get("imdb")
        trakt_id = ids.get("trakt")
        trakt_slug = ids.get("slug")

        if not title:
            continue

        rows.append((imdb_id, trakt_id, trakt_slug, title, year))

    sql = """
    INSERT INTO titles (imdb_id, trakt_id, trakt_slug, name, year)
    VALUES (%s, %s, %s, %s, %s)
    ON CONFLICT (imdb_id) DO UPDATE
      SET trakt_id = EXCLUDED.trakt_id,
          trakt_slug = EXCLUDED.trakt_slug,
          name = EXCLUDED.name,
          year = EXCLUDED.year,
          updated_at = now();
    """

    execute_batch(cur, sql, rows, page_size=100)
    conn.commit()
    cur.close()
    conn.close()
    print(f"Upserted {len(rows)} titles into DB")


if __name__ == "__main__":
    main()
