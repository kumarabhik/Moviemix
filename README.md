# MovieMix

MovieMix is a full-stack movie and series recommendation platform built as a multi-service monorepo.
It combines semantic retrieval, popularity-based collaborative signals, and optional XGBoost reranking.

## Tech Stack

- Frontend: Next.js 14, React 18, Tailwind CSS, Bootstrap
- Backend API: Node.js, Express, PostgreSQL, JWT auth
- Recommender: FastAPI, SentenceTransformers, FAISS, XGBoost
- Orchestration: Docker Compose, optional Kubernetes manifests
- Scheduling: Apache Airflow DAGs
- Observability: Prometheus metrics, optional Grafana + Alertmanager

## Repository Layout

```text
backend/        Express API (auth, wishlist, recs, integrations)
frontend/       Next.js app (search, title detail, wishlist, For You)
recommender/    FastAPI semantic service + FAISS index + reranker
infra/          Docker Compose, Kubernetes manifests, monitoring config
airflow/        DAGs for embeddings and popularity refresh
db/init/        PostgreSQL schema/bootstrap SQL
scripts/        Data import/enrichment and model training utilities
```

## Architecture

```text
Frontend (Next.js :3000)
  -> /api/* rewrites
Backend (Express :8000)
  -> PostgreSQL (titles/users/wishlists/interactions)
  -> Recommender (FastAPI :8001)
Recommender
  -> SentenceTransformer embeddings
  -> FAISS semantic search
  -> Optional XGBoost reranking
Airflow
  -> /admin/build_embeddings
  -> REFRESH MATERIALIZED VIEW popular_titles
```

## Core Features

- Semantic search with FAISS (`/api/recs/semantic`)
- Content-based "more like this" (`/api/recs/content`)
- Global hybrid recs with semantic fallback (`/api/recs/cf`)
- Personalized "For You" lane (`/api/recs/cf_user`)
- JWT auth (`/api/auth/signup`, `/api/auth/login`)
- Per-user wishlist (`/api/wishlist`)
- Interaction logging and signal rebuild (`/api/interactions`, `/api/events/rebuild_signals`)
- Optional Trakt watchlist import (`/api/integrations/trakt/import`)

## Prerequisites

- Docker + Docker Compose
- PowerShell (commands below assume Windows PowerShell)
- Optional for local scripts: Python 3.10+

## Environment Setup

Create a root `.env` file (recommended to do this manually; current `.env.example` is not reliable).

```dotenv
# Postgres
POSTGRES_USER=admin
POSTGRES_PASSWORD=I4mGr00t
POSTGRES_DB=moviemix
DATABASE_URL=postgresql://admin:I4mGr00t@db:5432/moviemix

# Backend
JWT_SECRET=change_me
RECS_URL=http://recommender:8001
PORT=8000

# External metadata APIs
OMDB_API_KEY=
TRAKT_CLIENT_ID=
TRAKT_CLIENT_SECRET=
TRAKT_REDIRECT_URI=http://localhost:8000/integrations/trakt/cb

# Optional Trakt import route gate
ENABLE_TRAKT_IMPORT=0
TRAKT_ACCESS_TOKEN=

# Optional watch-link route gate
ENABLE_WATCH_LINKS=0
NEXT_PUBLIC_ENABLE_WATCH_LINKS=0

# Optional A/B flag
ENABLE_AB_TEST=0
NEXT_PUBLIC_ENABLE_AB_TEST=0

# Optional frontend helper base URL (usually blank in Docker)
NEXT_PUBLIC_API_BASE=
```

## Quick Start (Docker)

1. Start the stack.

```powershell
docker compose --env-file .env -f .\infra\docker-compose.yaml up -d --build
```

2. Verify health.

```powershell
Invoke-RestMethod http://localhost:8000/health
Invoke-RestMethod http://localhost:8001/health
```

3. Build the semantic index once titles exist.

```powershell
Invoke-RestMethod "http://localhost:8001/admin/build_embeddings" -Method Post -ContentType "application/json" -Body "{}"
```

4. Open services.

- Frontend: <http://localhost:3000>
- Backend health: <http://localhost:8000/health>
- Recommender health: <http://localhost:8001/health>
- Airflow UI: <http://localhost:8080> (default `admin/admin` from compose command)

## Data and Metadata Scripts

Run these from repo root if you want richer content locally.

```powershell
python scripts/import_tmdb_titles.py
python scripts/import_trakt_popular.py
python scripts/enrich_omdb_top_titles.py
python scripts/import_trakt_posters.py
```

Notes:

- `import_trakt_popular.py` and `import_trakt_posters.py` require `TRAKT_CLIENT_ID`.
- `enrich_omdb_top_titles.py` requires `OMDB_API_KEY`.
- Most scripts assume DB is reachable on `localhost:5432` when run from host.

## XGBoost Reranker Workflow (Optional)

1. Build training data.

```powershell
$env:BACKEND_URL = "http://localhost:8000"
python scripts/build_xgb_dataset.py
```

2. Train model.

```powershell
python scripts/train_xgb_reranker.py
```

3. Copy model for recommender runtime and rebuild recommender image.

```powershell
Copy-Item .\models\xgb_reranker.json .\recommender\xgb_reranker.json -Force
docker compose --env-file .env -f .\infra\docker-compose.yaml up -d --build recommender
```

## Local Dev (without Docker, optional)

Backend:

```powershell
cd backend
npm install
npm run dev
```

Frontend:

```powershell
cd frontend
npm install
npm run dev
```

Recommender:

```powershell
cd recommender
pip install -r requirements.txt
uvicorn main:app --host 0.0.0.0 --port 8001 --reload
```

## Useful API Endpoints

- `GET /health` (backend)
- `GET /metrics` (backend Prometheus metrics)
- `POST /api/auth/signup`
- `POST /api/auth/login`
- `GET /api/recs/semantic?query=...&topK=...`
- `GET /api/recs/content?seed_text=...&topK=...`
- `GET /api/recs/cf`
- `GET /api/recs/cf_user` (requires Bearer token)
- `GET /api/wishlist` (requires Bearer token)
- `POST /api/integrations/trakt/import` (requires Bearer token and feature flag)
- `POST /admin/build_embeddings` (recommender)
- `GET /health` (recommender)

## Monitoring (Optional)

Bring up Prometheus, Alertmanager, and Grafana using the monitoring overlay:

```powershell
docker compose --env-file .env -f .\infra\docker-compose.yaml -f .\infra\docker-compose.monitoring.yaml up -d
```

Ports:

- Prometheus: `9090`
- Alertmanager: `9093`
- Grafana: `3001`

## Kubernetes (Optional)

Helper scripts are available in repo root:

```powershell
.\k8s-up.ps1
.\k8s-status.ps1
.\k8s-down.ps1
.\k8s-resume.ps1
```

Manifests are under `infra/k8s/`.

## Troubleshooting

- `Index not built` error from recommender: run `/admin/build_embeddings`.
- Empty recs on `/api/recs/cf_user`: ensure user has token and seed data exists.
- Missing posters: run metadata scripts and set API keys.
- Trakt import returns `trakt_import_disabled`: set `ENABLE_TRAKT_IMPORT=1` and `TRAKT_ACCESS_TOKEN`.
- Watch links return `disabled`: set `ENABLE_WATCH_LINKS=1` (backend) and `NEXT_PUBLIC_ENABLE_WATCH_LINKS=1` (frontend).

## Convenience Scripts

Shortcuts in [`scripts/`](scripts/) and [`infra/scripts/`](infra/scripts/):

- `scripts/up.ps1` / `scripts/down.ps1` / `scripts/logs.ps1`
- `infra/scripts/up.ps1` / `infra/scripts/down.ps1` / `infra/scripts/logs.ps1`
