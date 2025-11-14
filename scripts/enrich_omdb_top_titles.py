import os
import psycopg2
import requests
from dotenv import load_dotenv

# Load .env from project root (for OMDB_API_KEY etc.)
load_dotenv()

# *** IMPORTANT ***
# Use localhost here because this script runs on your host, not inside Docker
DATABASE_URL = "postgresql://admin:I4mGr00t@localhost:5432/moviemix"

OMDB_KEY = os.getenv("OMDB_API_KEY")
if not OMDB_KEY:
    raise SystemExit("OMDB_API_KEY not set in environment or .env")

def main():
    conn = psycopg2.connect(DATABASE_URL)
    conn.autocommit = True
    cur = conn.cursor()

    # Pick popular titles with missing posters
    cur.execute(
        """
        SELECT id, name, year
        FROM titles
        WHERE (poster_url IS NULL OR poster_url = '')
        ORDER BY popularity DESC
        LIMIT 300;
        """
    )
    rows = cur.fetchall()
    print(f"Found {len(rows)} titles to enrich from OMDb")

    updated = 0
    for (tid, name, year) in rows:
        params = {"apikey": OMDB_KEY, "t": name}
        if year:
            params["y"] = str(year)

        try:
            r = requests.get("https://www.omdbapi.com/", params=params, timeout=5)
            j = r.json()
        except Exception as e:
            print(f"❌ OMDb request failed for {name!r}: {e}")
            continue

        if j.get("Response") != "True":
            # print(f"OMDb: no match for {name!r} ({year}) -> {j.get('Error')}")
            continue

        poster = j.get("Poster") or ""
        plot = j.get("Plot") or None

        if not poster or poster == "N/A":
            continue

        # Update all duplicates for that movie (same name+year),
        # so whichever id the recommender uses will have a poster
        cur.execute(
            """
            UPDATE titles
            SET poster_url = COALESCE(NULLIF(%s, ''), poster_url),
                plot       = COALESCE(%s, plot)
            WHERE name = %s AND year = %s;
            """,
            (poster, plot, name, year),
        )

        updated += 1
        if updated % 50 == 0:
            print(f"... updated {updated} titles so far")

    cur.close()
    conn.close()
    print(f"✅ Done. Updated {updated} titles with OMDb metadata")

if __name__ == "__main__":
    main()
