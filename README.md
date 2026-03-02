# MovieMix

MovieMix is a full-stack movie and series recommendation platform built as a multi-service monorepo.
It combines semantic retrieval, collaborative popularity signals, and optional XGBoost reranking.

## What Is Improved

- Explainable recommendations: every recommendation item now includes `reason` and `reason_code`.
- Real A/B analytics: experiment summary endpoint and dashboard page (`/experiment`) with CTR/winner.
- Security hardening: required env-driven secrets (`DATABASE_URL`, `JWT_SECRET`, `AUTH_TOKEN`) and cleaned `.env.example`.
- Quality gates: backend tests plus CI pipeline across backend, frontend smoke build, and Python syntax checks.
- Offline evaluation upgrades: `Precision@K`, `Recall@K`, `NDCG@K`, `Coverage@K`, `Novelty@K`, and genre-match.
- UX refresh: improved visual system, gradients, improved cards, loading skeletons, and clearer states.

## Tech Stack

- Frontend: Next.js 14, React 18, Tailwind CSS, Bootstrap
- Backend API: Node.js, Express, PostgreSQL, JWT
- Recommender: FastAPI, SentenceTransformers, FAISS, XGBoost
- Orchestration: Docker Compose, optional Kubernetes manifests
- Scheduling: Apache Airflow DAGs
- Observability: Prometheus metrics, optional Grafana + Alertmanager

## Repository Layout

```text
backend/        Express API (auth, wishlist, recs, events, integrations)
frontend/       Next.js app (search, title detail, wishlist, For You, experiment dashboard)
recommender/    FastAPI semantic service + FAISS index + reranker
infra/          Docker Compose, Kubernetes manifests, monitoring config
airflow/        DAGs for embeddings and popularity refresh
db/init/        PostgreSQL schema/bootstrap SQL
scripts/        Data import/enrichment and model training/evaluation utilities
```

## Architecture

```text
Frontend (Next.js :3000)
  -> /api/* rewrites
Backend (Express :8000)
  -> PostgreSQL (titles/users/wishlists/interactions/events)
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

- Semantic search (`/api/recs/semantic`)
- Content-based "more like this" (`/api/recs/content`)
- Global hybrid recommendations (`/api/recs/cf`)
- Personalized recommendations (`/api/recs/cf_user`)
- Explainable recommendation fields (`reason`, `reason_code`)
- JWT auth (`/api/auth/signup`, `/api/auth/login`)
- Wishlist (`/api/wishlist`)
- Interaction logging and signal rebuild (`/api/interactions`, `/api/events/rebuild_signals`)
- Experiment analytics (`/api/events/ab_summary`, `/experiment`)
- Optional Trakt watchlist import (`/api/integrations/trakt/import`)

## Prerequisites

- Docker + Docker Compose
- PowerShell (commands below assume Windows PowerShell)
- Optional for local scripts: Python 3.10+

## Environment Setup

Copy `.env.example` to `.env` and set values.

```dotenv
# Postgres
POSTGRES_USER=admin
POSTGRES_PASSWORD=change_me
POSTGRES_DB=moviemix
DATABASE_URL=postgresql://admin:change_me@db:5432/moviemix

# Backend
JWT_SECRET=change_me_min_32_chars
RECS_URL=http://recommender:8001
PORT=8000

# External metadata APIs
OMDB_API_KEY=
TRAKT_CLIENT_ID=
TRAKT_CLIENT_SECRET=
TRAKT_REDIRECT_URI=http://localhost:8000/integrations/trakt/cb

# Optional Trakt import
ENABLE_TRAKT_IMPORT=0
TRAKT_ACCESS_TOKEN=
TRAKT_REFRESH_TOKEN=

# Optional watch-links
ENABLE_WATCH_LINKS=0
NEXT_PUBLIC_ENABLE_WATCH_LINKS=0

# Optional A/B
ENABLE_AB_TEST=0
NEXT_PUBLIC_ENABLE_AB_TEST=0

# Optional frontend helper base URL
NEXT_PUBLIC_API_BASE=
```

## Trakt OAuth Setup

1. Create a Trakt API app:
   - https://trakt.tv/oauth/applications/new
2. Copy `Client ID` and `Client Secret` into `.env`.
3. Use your configured redirect URI (example: `http://localhost:8000/integrations/trakt/cb`) and authorize:

```text
https://trakt.tv/oauth/authorize?response_type=code&client_id=<TRAKT_CLIENT_ID>&redirect_uri=<TRAKT_REDIRECT_URI>
```

4. Exchange the returned `code` for tokens:

```powershell
$body = @{
  code = "<CODE_FROM_TRAKT>"
  client_id = $env:TRAKT_CLIENT_ID
  client_secret = $env:TRAKT_CLIENT_SECRET
  redirect_uri = $env:TRAKT_REDIRECT_URI
  grant_type = "authorization_code"
} | ConvertTo-Json

Invoke-RestMethod -Uri "https://api.trakt.tv/oauth/token" -Method Post -ContentType "application/json" -Body $body
```

5. Save both `access_token` and `refresh_token` into `.env` as:
   - `TRAKT_ACCESS_TOKEN=...`
   - `TRAKT_REFRESH_TOKEN=...`

## Quick Start (Docker)

1. Start services.

```powershell
docker compose --env-file .env -f .\infra\docker-compose.yaml up -d --build
```

2. Verify health.

```powershell
Invoke-RestMethod http://localhost:8000/health
Invoke-RestMethod http://localhost:8001/health
```

3. Build semantic index.

```powershell
Invoke-RestMethod "http://localhost:8001/admin/build_embeddings" -Method Post -ContentType "application/json" -Body "{}"
```

4. Open services.

- Frontend: <http://localhost:3000>
- Experiment dashboard: <http://localhost:3000/experiment>
- Backend: <http://localhost:8000/health>
- Recommender: <http://localhost:8001/health>
- Airflow UI: <http://localhost:8080>

## Data and Metadata Scripts

Run from repo root:

```powershell
python scripts/import_tmdb_titles.py
python scripts/import_trakt_popular.py
python scripts/enrich_omdb_top_titles.py
python scripts/import_trakt_posters.py
```

Notes:

- `DATABASE_URL` is required for all scripts.
- `TRAKT_CLIENT_ID` is required for Trakt scripts.
- `OMDB_API_KEY` is required for OMDb enrichment.

## XGBoost Reranker Workflow (Optional)

1. Build training dataset.

```powershell
$env:BACKEND_URL = "http://localhost:8000"
python scripts/build_xgb_dataset.py
```

2. Train model.

```powershell
python scripts/train_xgb_reranker.py
```

3. Copy model and rebuild recommender.

```powershell
Copy-Item .\models\xgb_reranker.json .\recommender\xgb_reranker.json -Force
docker compose --env-file .env -f .\infra\docker-compose.yaml up -d --build recommender
```

## Offline Evaluation

`scripts/eval_offline.py` now reports:

- `Precision@K`
- `Recall@K`
- `NDCG@K`
- `Genre-match@K`
- `Novelty@K`
- `Coverage@K`

Required env:

```powershell
$env:DATABASE_URL="postgresql://..."
$env:BACKEND_URL="http://localhost:8000"
$env:AUTH_TOKEN="<bearer-token>"
python scripts/eval_offline.py
```

## Testing and CI

Backend tests:

```powershell
cd backend
npm test
```

Frontend smoke test:

```powershell
cd frontend
npm run test:smoke
```

CI workflow (`.github/workflows/ci.yml`) runs:

- backend tests
- frontend smoke build
- Python syntax checks

## Useful API Endpoints

- `GET /health` (backend)
- `GET /metrics` (backend Prometheus metrics)
- `POST /api/auth/signup`
- `POST /api/auth/login`
- `GET /api/recs/semantic?query=...&topK=...`
- `GET /api/recs/content?seed_text=...&topK=...`
- `GET /api/recs/cf`
- `GET /api/recs/cf_user` (Bearer token required)
- `GET /api/events/ab_summary?days=14&scope=all` (Bearer token required)
- `GET /api/wishlist` (Bearer token required)
- `POST /api/integrations/trakt/import` (Bearer token required + feature flag)
- `POST /admin/build_embeddings` (recommender)

## Monitoring (Optional)

```powershell
docker compose --env-file .env -f .\infra\docker-compose.yaml -f .\infra\docker-compose.monitoring.yaml up -d
```

Ports:

- Prometheus: `9090`
- Alertmanager: `9093`
- Grafana: `3001`

## Kubernetes (Optional)

```powershell
.\k8s-up.ps1
.\k8s-status.ps1
.\k8s-down.ps1
.\k8s-resume.ps1
```

Manifests are under `infra/k8s/`.

## Troubleshooting

- `Index not built`: call `/admin/build_embeddings`.
- Empty `/api/recs/cf_user`: confirm auth token and enough interaction/wishlist data.
- `trakt_import_disabled`: set `ENABLE_TRAKT_IMPORT=1`.
- `trakt_auth_expired`: refresh or re-authorize Trakt token and update `TRAKT_ACCESS_TOKEN` and `TRAKT_REFRESH_TOKEN`.
- Watch links disabled: set `ENABLE_WATCH_LINKS=1` and `NEXT_PUBLIC_ENABLE_WATCH_LINKS=1`.
