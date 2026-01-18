import requests
import psycopg2
from collections import defaultdict
import base64
import json

# ================= CONFIG =================
DB_URL = "postgresql://admin:I4mGr00t@localhost:5432/moviemix"
API_BASE = "http://localhost:8000"
TOPK = 50
AUTH_TOKEN = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOiJlYTZjMDdmZS0zNDNlLTQ1MDItODYwYy0wMjViMmNkZDczNzUiLCJlbWFpbCI6ImFiaGlzaGVrQHVzZXIuY29tIiwiaWF0IjoxNzY2MDc3MzAxLCJleHAiOjE3NjY2ODIxMDF9.2llZ7cHXGv0he_exgZjSfIRbiUkCn45bemVBleEVvUY"
# =========================================


def jwt_user_id(token: str) -> str | None:
    """
    Decode JWT payload without verifying signature.
    Only used to read userId for evaluation filtering.
    """
    try:
        parts = token.split(".")
        if len(parts) != 3:
            return None
        payload_b64 = parts[1] + "==="  # padding
        payload_bytes = base64.urlsafe_b64decode(payload_b64)
        payload = json.loads(payload_bytes.decode("utf-8"))
        return payload.get("userId")
    except Exception:
        return None


conn = psycopg2.connect(DB_URL)
cur = conn.cursor()


# ---------- helpers ----------
def in_wishlist(user_id, title_id) -> bool:
    cur.execute(
        "SELECT 1 FROM wishlists WHERE user_id=%s AND title_id=%s LIMIT 1",
        (str(user_id), int(title_id)),
    )
    return cur.fetchone() is not None


def user_top_genres(user_id, topn=5) -> set:
    """
    User preference profile from *positive* history.
    """
    cur.execute(
        """
        SELECT unnest(t.genres) AS g, COUNT(*) AS c
        FROM interactions i
        JOIN titles t ON t.id = i.title_id
        WHERE i.user_id = %s
          AND (i.watched = true OR i.rating >= 4 OR i.weight >= 3)
        GROUP BY g
        ORDER BY c DESC
        LIMIT %s
        """,
        (str(user_id), int(topn)),
    )
    return set([r[0] for r in cur.fetchall() if r and r[0]])


def title_genres(title_id) -> set:
    cur.execute("SELECT genres FROM titles WHERE id=%s", (int(title_id),))
    row = cur.fetchone()
    if not row or not row[0]:
        return set()
    return set(row[0])
# ----------------------------


# 1) Load positives (for building per-user histories)
cur.execute("""
SELECT user_id, title_id, ts
FROM interactions
WHERE watched = true OR rating >= 4 OR weight >= 3
ORDER BY user_id, ts
""")

rows = cur.fetchall()

by_user = defaultdict(list)
for u, t, ts in rows:
    by_user[u].append((ts, t))

users = [u for u in by_user if len(by_user[u]) >= 2]

token_uid = jwt_user_id(AUTH_TOKEN)
print("Token userId:", token_uid)
print("Users in eval set:", [str(u) for u in users])

# Evaluate only the token user (so we don't need multiple JWTs)
if token_uid:
    users = [u for u in users if str(u) == str(token_uid)]

print(f"Evaluating {len(users)} users")

# ✅ Aggregation variables (these feed the final summary)
valid_users = 0
personal_sum = 0.0
all_recs = set()

for user in users:
    # Debug: recent positives (filtered only by wishlist for display)
    test_items = [t for _, t in by_user[user][-5:]]
    test_items = [t for t in test_items if not in_wishlist(user, t)]
    print("\nUser:", user)
    print("Recent positives (debug):", test_items)

    topg = user_top_genres(user, topn=5)
    print("Top genres:", sorted(topg))

    # Call recommender (cf_user returns NEW items, filters seen + wishlist)
    r = requests.get(
        f"{API_BASE}/api/recs/cf_user",
        params={"topK": TOPK},
        headers={"Authorization": f"Bearer {AUTH_TOKEN}"},
        timeout=30,
    )

    if not r.ok:
        print("API error:", r.status_code, r.text[:200])
        continue

    items = r.json().get("items", [])
    if not items:
        print("Empty rec list for user (token mismatch or no data):", user)
        continue

    # Robust: some endpoints return title_id, some return id
    rec_ids = [
        (it.get("title_id") if it.get("title_id") is not None else it.get("id"))
        for it in items
    ]
    rec_ids = [rid for rid in rec_ids if rid is not None]

    # Track overall coverage
    for rid in rec_ids:
        all_recs.add(int(rid))

    # Personalization = fraction of recs whose genres overlap user's top genres
    matched = 0
    checked = 0
    for rid in rec_ids:
        gs = title_genres(int(rid))
        checked += 1
        if gs & topg:
            matched += 1

    personalization = matched / max(1, checked)

    print(f"Genre-match@{TOPK}: {personalization:.3f} ({matched}/{checked})")

    # ✅ Update aggregation
    personal_sum += personalization
    valid_users += 1

print("\n===== OFFLINE EVALUATION (cf_user personalization) =====")
print(f"Users evaluated: {valid_users}")
print(
    f"Avg Genre-match@{TOPK}: {personal_sum/valid_users:.3f}"
    if valid_users
    else f"Avg Genre-match@{TOPK}: 0.000"
)
print(f"Coverage@{TOPK}: {len(all_recs)} unique titles")

cur.close()
conn.close()
