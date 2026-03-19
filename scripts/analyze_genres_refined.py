import csv
import json
from collections import Counter

movies = []
with open('data/tmdb_5000_movies.csv', mode='r', encoding='utf-8') as f:
    reader = csv.DictReader(f)
    for row in reader:
        try:
            genres = json.loads(row['genres'])
            pop = float(row['popularity'])
            movies.append({'genres': [g['name'] for g in genres], 'popularity': pop})
        except Exception as e:
            continue

# Sort movies by popularity descending
movies.sort(key=lambda x: x['popularity'], reverse=True)

# Count genres in top 100 most popular movies
top_100_genres = Counter()
for movie in movies[:100]:
    for genre in movie['genres']:
        top_100_genres[genre] += 1

print("Top 10 genres in the 100 most popular movies:")
for genre, count in top_100_genres.most_common(10):
    print(f"{genre}: {count}")

# Count genres in all movies
all_genres = Counter()
for movie in movies:
    for genre in movie['genres']:
        all_genres[genre] += 1

print("\nTop 10 genres across all movies:")
for genre, count in all_genres.most_common(10):
    print(f"{genre}: {count}")
