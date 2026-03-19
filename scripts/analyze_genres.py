import csv
import json
from collections import Counter

genre_counter = Counter()

with open('data/tmdb_5000_movies.csv', mode='r', encoding='utf-8') as f:
    reader = csv.DictReader(f)
    for row in reader:
        try:
            genres = json.loads(row['genres'])
            for genre in genres:
                genre_counter[genre['name']] += 1
        except Exception as e:
            # Skip rows with invalid JSON or other issues
            continue

# Print top 10 most popular genres
print("Top 10 most popular genres in TMDB dataset:")
for genre, count in genre_counter.most_common(10):
    print(f"{genre}: {count}")
