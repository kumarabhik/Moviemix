import ast
import os

import pandas as pd
import psycopg2

CSV_PATH = os.path.join(os.path.dirname(__file__), "..", "data", "tmdb_5000_movies.csv")
DATABASE_URL = os.environ.get("DATABASE_URL")
if not DATABASE_URL:
    raise SystemExit("DATABASE_URL is required")


def parse_genres(value):
    try:
        return [g["name"] for g in ast.literal_eval(value)]
    except Exception:
        return []


def main():
    print(f"Reading {CSV_PATH} ...")
    df = pd.read_csv(CSV_PATH)
    df = df[["id", "title", "overview", "genres", "popularity", "release_date"]]
    df = df.dropna(subset=["title", "overview"])
    df["title"] = df["title"].str.strip()
    df["year"] = df["release_date"].str[:4]
    df["genres_list"] = df["genres"].apply(parse_genres)

    conn = psycopg2.connect(DATABASE_URL)
    conn.autocommit = True
    cur = conn.cursor()

    inserted = 0
    for _, row in df.iterrows():
        cur.execute(
            """
            INSERT INTO titles (name, year, imdb_id, trakt_id, trakt_slug, plot, genres, cast_names, poster_url, popularity)
            VALUES (%s, %s, NULL, NULL, NULL, %s, %s, ARRAY[]::text[], NULL, %s)
            ON CONFLICT DO NOTHING
            """,
            (
                row["title"],
                row["year"],
                row["overview"],
                row["genres_list"],
                row["popularity"],
            ),
        )
        inserted += 1

    cur.close()
    conn.close()
    print(f"Inserted {inserted} rows into titles.")


if __name__ == "__main__":
    main()

