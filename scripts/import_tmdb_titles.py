import os
import psycopg2
import pandas as pd
import ast

# Path to your CSV
CSV_PATH = os.path.join(os.path.dirname(__file__), "..", "data", "tmdb_5000_movies.csv")

# Database connection (edit if your password differs)
DATABASE_URL = os.environ.get(
    "DATABASE_URL", "postgresql://admin:I4mGr00t@localhost:5432/moviemix"
)

def main():
    print(f"Reading {CSV_PATH} ...")
    df = pd.read_csv(CSV_PATH)

    # --- keep only relevant columns ---
    df = df[["id", "title", "overview", "genres", "popularity", "release_date"]]

    # --- clean + transform ---
    df = df.dropna(subset=["title", "overview"])
    df["title"] = df["title"].str.strip()
    df["year"] = df["release_date"].str[:4]

    def parse_genres(x):
        try:
            genres = [g["name"] for g in ast.literal_eval(x)]
            return genres
        except Exception:
            return []

    df["genres_list"] = df["genres"].apply(parse_genres)

    print(f"Sample:\n{df.head(3)}")

    # --- connect to database ---
    conn = psycopg2.connect(DATABASE_URL)
    conn.autocommit = True
    cur = conn.cursor()

    inserted = 0
    for _, row in df.iterrows():
        cur.execute(
            """
            INSERT INTO titles (name, year, imdb_id, trakt_id, trakt_slug, plot, genres, cast_names, poster_url, popularity)
            VALUES (%s, %s, NULL, NULL, NULL, %s, %s, ARRAY[]::text[], NULL, %s)
            ON CONFLICT DO NOTHING;
            """,
            (row["title"], row["year"], row["overview"], row["genres_list"], row["popularity"]),
        )
        inserted += 1

    cur.close()
    conn.close()
    print(f"✅ Inserted {inserted} rows into titles.")

if __name__ == "__main__":
    main()
