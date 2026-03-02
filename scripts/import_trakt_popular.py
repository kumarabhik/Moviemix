import os

import psycopg2
import requests
from psycopg2.extras import execute_batch

TRAKT_CLIENT_ID = os.environ.get("TRAKT_CLIENT_ID")
if not TRAKT_CLIENT_ID:
    raise SystemExit("TRAKT_CLIENT_ID is required")

DATABASE_URL = os.environ.get("DATABASE_URL")
if not DATABASE_URL:
    raise SystemExit("DATABASE_URL is required")

BASE_URL = "https://api.trakt.tv"
HEADERS = {
    "Content-Type": "application/json",
    "trakt-api-key": TRAKT_CLIENT_ID,
    "trakt-api-version": "2",
}


def fetch_popular_movies(pages=5, per_page=50):
    movies = []
    for page in range(1, pages + 1):
        resp = requests.get(
            f"{BASE_URL}/movies/popular",
            params={"page": page, "limit": per_page},
            headers=HEADERS,
            timeout=15,
        )
        resp.raise_for_status()
        payload = resp.json()
        if not payload:
            break
        movies.extend(payload)
    return movies


def main():
    movies = fetch_popular_movies(pages=5, per_page=50)
    print(f"Fetched {len(movies)} movies from Trakt")

    conn = psycopg2.connect(DATABASE_URL)
    cur = conn.cursor()

    rows = []
    for movie in movies:
        title = movie.get("title")
        year = movie.get("year")
        ids = movie.get("ids") or {}
        if not title:
            continue
        rows.append((ids.get("imdb"), ids.get("trakt"), ids.get("slug"), title, year))

    sql = """
    INSERT INTO titles (imdb_id, trakt_id, trakt_slug, name, year)
    VALUES (%s, %s, %s, %s, %s)
    ON CONFLICT (imdb_id) DO UPDATE
      SET trakt_id = EXCLUDED.trakt_id,
          trakt_slug = EXCLUDED.trakt_slug,
          name = EXCLUDED.name,
          year = EXCLUDED.year,
          updated_at = now()
    """

    execute_batch(cur, sql, rows, page_size=100)
    conn.commit()
    cur.close()
    conn.close()
    print(f"Upserted {len(rows)} titles into DB")


if __name__ == "__main__":
    main()

