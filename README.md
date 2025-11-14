# 🎬 MovieMix — Hybrid Movie Recommendation Engine (Semantic + CF + XGBoost)

Monorepo for a full-stack, ML-driven movie & series recommendation system:

- **Frontend** – Next.js (React) + Tailwind
- **Backend** – Node.js (Express)
- **Recommender** – FastAPI (Python)
- **Infra** – Postgres, FAISS, Airflow, Docker Compose

---

## 1. Overview

**MovieMix** is a production-style movie recommendation system that simulates the backend stack of Netflix / Prime Video / Letterboxd.

It combines:

- **Semantic search** (Sentence Transformers + FAISS)
- **Collaborative filtering (CF-lite)** from user events
- **XGBoost reranking** on top of semantic candidates
- **Hybrid recommendation APIs** exposed via a Node.js backend
- **A polished Next.js UI** with wishlist, “For You” lane, and JWT auth

**What it solves for users**

- Lets users **search by meaning**, not just exact titles (e.g. _“space adventure with time travel”_).
- Generates **personalized recommendations** using wishlist and popularity signals.
- Provides a clean, responsive UI with **wishlist management**, **“More like this”**, and **semantic search**.

---

## 2. Architecture

High-level components:

- **Frontend**: Next.js + Tailwind, talks to backend via `/api/*`.
- **Backend**: Node.js (Express) gateway for auth, wishlist, and recs.
- **Recommender**: FastAPI service with FAISS, SentenceTransformers, XGBoost reranker.
- **Database**: PostgreSQL with `titles`, `users`, `wishlists`, `interaction_events`, `popular_titles` materialized view.
- **ETL / Scheduling**: Apache Airflow DAGs to refresh embeddings and popularity.
- **Infra**: Docker Compose orchestrating all services.

### 2.1 System Diagram

```text
                        ┌───────────────────┐
                        │   Next.js Frontend│
                        │ (UI + Search + JWT)│
                        └─────────▲─────────┘
                                  │ /api/*
                                  ▼
                     ┌─────────────────────────┐
                     │   Node.js Backend (8000) │
                     │ Auth / Wishlist / CF API │
                     │ OMDb + Trakt enrichment  │
                     └──────────▲─┬────────────┘
                                │ │ HTTP (Semantic/ML)
                                ▼ ▼
        ┌─────────────────────────────────────────────┐
        │      FastAPI Recommender Service (8001)     │
        │  - Semantic Search via FAISS                │
        │  - XGBoost Reranker                         │
        │  - Embedding builder + admin endpoints      │
        └───────────────────▲────────────────────────┘
                            │ SQL
                            ▼
                     ┌─────────────────────┐
                     │   PostgreSQL (DB)   │
                     │ titles / users      │
                     │ wishlists / events  │
                     │ popular_titles MV   │
                     └─────────────────────┘
                            │
                            ▼
               ┌────────────────────────────┐
               │     Airflow ETL Scheduler  │
               │ nightly refresh DAGs       │
               └────────────────────────────┘
2.2 Docker Compose Layout
All services run via a single command:

moviemix-db – PostgreSQL

moviemix-backend – Node/Express API

moviemix-recommender – FastAPI + FAISS + XGBoost

moviemix-frontend – Next.js app

moviemix-airflow-{webserver,scheduler} – Airflow for ETL

3. Data & Models
3.1 Schema (Postgres)
Key tables:

titles

id, name, year

imdb_id, trakt_id, trakt_slug

genres (array)

poster_url

plot, popularity

users

id, email, password_hash, timestamps

wishlists

user_id, title_id, source, ts

interaction_events

user_id, title_id, event_type, ts

Basis for popularity + CF-lite

popular_titles (materialized view)

title_id, cnt – aggregated interaction counts

3.2 Embeddings & Semantic Search
SentenceTransformers model: all-MiniLM-L6-v2

Every title is embedded into a vector.

Vectors indexed in FAISS for fast nearest-neighbor search.

Endpoints (recommender):

POST /recs/semantic – semantic search by text query.

POST /recs/content – content-based “more like this” via seed text.

Optional: GET /recs/by_seed – “more like this” using a seed title_id.

The backend exposes:

GET /api/recs/semantic?query=...&topK=... – proxy to recommender + DB enrichment.

3.3 Collaborative Filtering (CF-lite)
Instead of a full matrix factorization, MovieMix uses:

Wishlist events and interaction_events to compute popularity.

A materialized view popular_titles to cache counts.

Backend endpoints:

GET /api/recs/cf – global hybrid CF (popular_titles + semantic fallback).

GET /api/recs/cf_user – personalized “For You” lane:

Excludes titles already in the user’s wishlist.

Falls back to semantic recommendations using user-specific seeds.

3.4 Hybrid Recommendation Engine
The hybrid logic:

Try CF (from popular_titles), optionally excluding wishlist.

If CF is “strong enough” (e.g. ≥ 5 items), return those.

Otherwise:

Select seed titles:

For guest/global: from popular_titles.

For logged-in users: from the user’s wishlist first, else popular_titles.

Call the semantic recommender using those seeds (by text or id).

Optionally apply XGBoost reranking to reorder candidates.

Merge + dedupe CF + semantic results and return the top-N.

4. Pipelines (Airflow)
Airflow DAGs keep the system fresh and automated:

4.1 Embeddings & FAISS
DAG: build_embeddings_nightly

Recomputes SentenceTransformer embeddings for titles.

Rebuilds the FAISS index.

Calls the recommender admin endpoint:

POST /admin/build_embeddings

4.2 Popularity & CF Signals
DAG: refresh_popular_titles_nightly

Recomputes popularity counts from interaction_events / wishlists.

Refreshes the popular_titles materialized view.

Keeps CF recommendations up to date with user behavior.

5. Features
5.1 Search & Semantic Recs
Debounced search input in the UI.

Calls GET /api/recs/semantic?query=....

Backend enriches results with:

year, plot, genres, poster_url (from DB / OMDb / Trakt).

5.2 Title Details + “More like this”
Each title has a detail page:

Poster, year, genres, plot.

“More like this” section powered by semantic recs from the recommender.

5.3 Auth & Wishlist (Per User)
JWT auth:

/api/auth/signup, /api/auth/login.

Wishlist:

Add/remove via animated heart button ❤️.

Wishlist page shows all saved titles, sorted by added time.

Wishlist is central to personalization:

Drives CF signals.

Feeds seeds into the hybrid / CF-user recommender.

5.4 “For You” Lane
Endpoint: GET /api/recs/cf_user.

Combines:

popular_titles (CF-lite)

User’s wishlist as semantic seeds

Optional XGBoost reranking

Excludes titles already present in the user’s wishlist.

5.5 Theming & UI
Next.js + Tailwind CSS.

Light/dark theme.

Responsive layout.

Smooth wishlist interactions and cards.

6. XGBoost Reranker (Session-aware Ranking)
On top of semantic search, MovieMix adds a lightweight XGBoost model to rerank candidates using richer features.

6.1 Data Pipeline
Script: scripts/build_xgb_dataset.py

For users with wishlist activity:

Treat every movie in their wishlist as a positive seed.

Call the backend semantic endpoint (/api/recs/semantic) to get candidate similar titles.

For each (user, seed, candidate) triple compute features:

semantic_score – similarity score from the recommender.

log_popularity – log-transformed popularity count.

same_year – 1 if candidate.year == seed.year, else 0.

genre_overlap_seed – Jaccard overlap between seed genres and candidate genres.

genre_overlap_user – overlap between candidate genres and the user’s wishlist genre profile.

in_user_wishlist – label; 1 if candidate is in user’s wishlist, else 0.

Write all rows to: data/xgb_rerank_dataset.csv.

Run:

bash
Copy code
export DATABASE_URL=...
export BACKEND_URL=http://localhost:8000

python scripts/build_xgb_dataset.py
6.2 Training
Script: scripts/train_xgb_reranker.py

Loads data/xgb_rerank_dataset.csv.

Uses feature columns such as:

text
Copy code
["semantic_score", "log_popularity", "same_year",
 "genre_overlap_seed", "genre_overlap_user"]
Trains a binary:logistic XGBoost model for ~120 rounds.

Saves model as: xgb_reranker.json.

Run:

bash
Copy code
python scripts/train_xgb_reranker.py
6.3 Serving & Inference
In recommender/main.py (FastAPI):

On startup:

Attempts to load /app/xgb_reranker.json.

If found → [xgb] loaded reranker model....

If not → reranker is disabled; fall back to pure semantic scores.

For each semantic recommendation:

Get top-K semantic candidates from FAISS.

Build a feature matrix for those candidates.

Run XGBoost to get rerank scores.

Sort candidates by rerank score.

Return results to the backend, which enriches with metadata for the frontend.

Docker builds copy the trained model into the image so the reranker is active automatically.

7. Metadata & Poster Enrichment
To keep UI rich and visual:

OMDb API:

Posters, plot, actors, basic metadata.

Trakt API:

Used as fallback poster source when OMDb poster is missing or rate-limited.

Scripts:

scripts/import_seed_titles.py – seed baseline titles.

scripts/enrich_omdb_top_titles.py – fetch OMDb data for top titles.

scripts/import_trakt_posters.py – fill missing posters via Trakt.

The backend’s recs routes also call OMDb on-demand when poster_url is missing and imdb_id is known.

8. How to Run
8.1 Prerequisites
Docker

Docker Compose

Python 3.10+ (for local scripts)

Node.js (for local dev of frontend/backend, optional)

8.2 Clone the Repo
bash
Copy code
git clone https://github.com/<your-username>/moviemix.git
cd moviemix
8.3 Create .env (root)
Minimal example:

dotenv
Copy code
POSTGRES_USER=admin
POSTGRES_PASSWORD=I4mGr00t
POSTGRES_DB=moviemix

JWT_SECRET=your_jwt_secret_here

OMDB_API_KEY=your_omdb_key
TRAKT_CLIENT_ID=your_trakt_client_id
TRAKT_CLIENT_SECRET=your_trakt_client_secret
8.4 Start Everything
bash
Copy code
docker compose -f infra/docker-compose.yaml up -d --build
Services:

Frontend: http://localhost:8080

Backend: http://localhost:8000

Recommender: http://localhost:8001

Airflow UI (if exposed): http://localhost:8081 (or whatever you configure)

8.5 Initialize DB & Metadata
From the project root (inside your Python venv if you use one):

bash
Copy code
python scripts/import_seed_titles.py
python scripts/enrich_omdb_top_titles.py
python scripts/import_trakt_posters.py
8.6 Build FAISS Embeddings
Call the admin endpoint of the recommender:

bash
Copy code
Invoke-RestMethod "http://localhost:8001/admin/build_embeddings" -Method Post
# or with curl:
# curl -X POST http://localhost:8001/admin/build_embeddings
8.7 (Optional) Train XGBoost Reranker
bash
Copy code
python scripts/build_xgb_dataset.py
python scripts/train_xgb_reranker.py
Rebuild recommender image if needed so xgb_reranker.json is copied into the container.

9. Recommendation Flow (End-to-End)
User types a query in the frontend.

Frontend calls GET /api/recs/semantic?query=....

Backend forwards to recommender /recs/semantic.

Recommender:

Runs FAISS nearest-neighbor search.

Applies optional XGBoost reranking.

Returns top-K candidates with scores.

Backend:

Enriches with DB data (plots, posters, genres).

Responds to frontend.

Frontend renders cards with poster, title, year, and wishlist heart.

For logged-in users:

Wishlist & interaction events feed into:

popular_titles MV.

CF-lite + personalization (/api/recs/cf_user).

Hybrid logic mixes:

Popular titles,

Wishlist-based semantic seeds,

XGBoost reranker.

10. Future Work
Some extension ideas:

True matrix factorization CF (ALS / implicit MF).

Richer hybrid ranking (learned ensemble of CF + content + reranker).

Scene / mood tags with an LLM (e.g. OpenAI / Qwen) over plots.

Trending & “Newly added” lanes based on time + interactions.

User reviews / ratings and rating-aware ranking.

Browser extension to push movies from Trakt/Letterboxd into MovieMix.

11. Why MovieMix Is a Strong Portfolio Project
MovieMix demonstrates:

✅ End-to-end ML system design (embedding models, FAISS, reranking).

✅ Backend engineering with Node.js, FastAPI, Postgres.

✅ ETL & MLOps flavor via Airflow DAGs.

✅ Dockerized microservices and local orchestration.

✅ A production-style UI/UX with auth, wishlist, and recommendation lanes.

Perfect for:

Hackathons

Final-year projects

ML / Data / Backend engineering interviews

Portfolio / GitHub showcase