import os

import psycopg2
import requests
from dotenv import load_dotenv

load_dotenv()

DATABASE_URL = os.environ.get("DATABASE_URL")
if not DATABASE_URL:
    raise SystemExit("DATABASE_URL is required")

OMDB_KEY = os.environ.get("OMDB_API_KEY")
if not OMDB_KEY:
    raise SystemExit("OMDB_API_KEY is required")


def main():
    conn = psycopg2.connect(DATABASE_URL)
    conn.autocommit = True
    cur = conn.cursor()

    cur.execute(
        """
        SELECT id, name, year
        FROM titles
        WHERE (poster_url IS NULL OR poster_url = '')
        ORDER BY popularity DESC
        LIMIT 300
        """
    )
    rows = cur.fetchall()
    print(f"Found {len(rows)} titles to enrich from OMDb")

    updated = 0
    for _, name, year in rows:
        params = {"apikey": OMDB_KEY, "t": name}
        if year:
            params["y"] = str(year)

        try:
            resp = requests.get("https://www.omdbapi.com/", params=params, timeout=5)
            data = resp.json()
        except Exception as e:
            print(f"OMDb request failed for {name!r}: {e}")
            continue

        if data.get("Response") != "True":
            continue

        poster = data.get("Poster") or ""
        plot = data.get("Plot") or None
        if not poster or poster == "N/A":
            continue

        cur.execute(
            """
            UPDATE titles
            SET poster_url = COALESCE(NULLIF(%s, ''), poster_url),
                plot       = COALESCE(%s, plot)
            WHERE name = %s AND year = %s
            """,
            (poster, plot, name, year),
        )

        updated += 1
        if updated % 50 == 0:
            print(f"... updated {updated} titles so far")

    cur.close()
    conn.close()
    print(f"Done. Updated {updated} titles with OMDb metadata")


if __name__ == "__main__":
    main()

