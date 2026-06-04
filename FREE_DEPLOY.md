# Free Deploy

This repo can be adapted for a free demo deployment with:

- frontend on Vercel
- backend on a Hugging Face Docker Space
- recommender on a second Hugging Face Docker Space
- Postgres on Supabase Free

This is a demo / portfolio setup, not a high-availability production setup.

## What changed in the code

- The frontend now supports `NEXT_PUBLIC_API_BASE` everywhere, so browser requests can go directly to your hosted backend URL.
- `frontend/next.config.js` also supports `BACKEND_ORIGIN` or `NEXT_PUBLIC_API_BASE` rewrites when available.
- The backend Postgres client now supports SSL-managed databases such as Supabase by using:
  - `DATABASE_REQUIRE_SSL=1`
  - optionally `DATABASE_REJECT_UNAUTHORIZED=0`

## Free URLs you will end up with

- frontend: `https://<your-project>.vercel.app`
- backend: `https://<your-backend-space>.hf.space`
- recommender: `https://<your-recommender-space>.hf.space`

## Supabase

Create a free Supabase project and run:

- [`db/init/001_schema.sql`](c:/Users/kumar/Downloads/XOXO/moviemix/db/init/001_schema.sql)

Use the direct Postgres connection string in:

- backend env: `DATABASE_URL`
- recommender env: `DATABASE_URL`

Set these too for both backend and recommender:

```dotenv
DATABASE_REQUIRE_SSL=1
DATABASE_REJECT_UNAUTHORIZED=0
```

## Backend Hugging Face Space

Create a new Docker Space and deploy the `backend/` service there.
If the host does not support selecting a monorepo subfolder directly, create a separate repo containing the contents of `backend/`.

Set Space env vars:

```dotenv
PORT=8000
DATABASE_URL=postgresql://...
DATABASE_REQUIRE_SSL=1
DATABASE_REJECT_UNAUTHORIZED=0
JWT_SECRET=your_long_secret
RECS_URL=https://<your-recommender-space>.hf.space
CORS_ORIGIN=https://<your-project>.vercel.app
OMDB_API_KEY=
TRAKT_CLIENT_ID=
TRAKT_CLIENT_SECRET=
TRAKT_REDIRECT_URI=
ENABLE_TRAKT_IMPORT=0
ENABLE_WATCH_LINKS=0
ENABLE_AB_TEST=0
```

## Recommender Hugging Face Space

Create another Docker Space and deploy the `recommender/` service there.
If needed, create a separate repo containing the contents of `recommender/`.

Set Space env vars:

```dotenv
DATABASE_URL=postgresql://...
DATABASE_REQUIRE_SSL=1
DATABASE_REJECT_UNAUTHORIZED=0
DATA_DIR=/app/data
```

The recommender image already includes bundled data under `recommender/data`, which helps for a free demo.

## Vercel Frontend

Deploy the `frontend/` folder to Vercel.

Set Vercel env vars:

```dotenv
NEXT_PUBLIC_API_BASE=https://<your-backend-space>.hf.space
BACKEND_ORIGIN=https://<your-backend-space>.hf.space
NEXT_PUBLIC_ENABLE_AB_TEST=0
ENABLE_AB_TEST=0
NEXT_PUBLIC_ENABLE_WATCH_LINKS=0
```

If you use direct `NEXT_PUBLIC_API_BASE`, the frontend will work even without Vercel rewrites.

## Important limits

- Free Hugging Face Spaces can sleep and cold start.
- Free storage on Spaces is limited and runtime-written data may not be durable.
- Airflow is not part of the free deploy path.
- This setup is best for demos, resumes, and portfolio links.
