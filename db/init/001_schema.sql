-- MOVIEMIX-SCHEMA v1 (TMDb-free; uses IMDb/Trakt IDs)
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Core titles
CREATE TABLE IF NOT EXISTS titles (
  id SERIAL PRIMARY KEY,
  imdb_id TEXT UNIQUE,          -- e.g., tt1375666
  trakt_id INT,                 -- Trakt internal id
  trakt_slug TEXT,              -- Trakt slug
  name TEXT NOT NULL,
  year INT,
  plot TEXT,
  genres TEXT[],
  cast_names TEXT[],
  poster_url TEXT,
  popularity DOUBLE PRECISION,
  updated_at TIMESTAMP DEFAULT now()
);

-- Users
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT UNIQUE NOT NULL,
  pass_hash TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT now()
);

-- Interactions (implicit/explicit)
CREATE TABLE IF NOT EXISTS interactions (
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  title_id INT REFERENCES titles(id) ON DELETE CASCADE,
  rating DOUBLE PRECISION,
  watched BOOLEAN DEFAULT FALSE,
  weight DOUBLE PRECISION DEFAULT 1.0,
  ts TIMESTAMP DEFAULT now(),
  PRIMARY KEY (user_id, title_id)
);

-- Wishlists
CREATE TABLE IF NOT EXISTS wishlists (
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  title_id INT REFERENCES titles(id) ON DELETE CASCADE,
  source TEXT CHECK (source IN ('app','trakt')) DEFAULT 'app',
  ts TIMESTAMP DEFAULT now(),
  PRIMARY KEY (user_id, title_id, source)
);

CREATE TABLE IF NOT EXISTS interaction_events (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title_id INT REFERENCES titles(id) ON DELETE CASCADE,
  event TEXT NOT NULL,           -- 'search_click' | 'detail_open' | 'wishlist_add' | ...
  meta JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ix_ie_user_created
  ON interaction_events(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS reviews (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title_id INT NOT NULL REFERENCES titles(id) ON DELETE CASCADE,
  rating DOUBLE PRECISION NOT NULL CHECK (rating >= 1 AND rating <= 5),
  review_text TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, title_id)
);

CREATE INDEX IF NOT EXISTS ix_reviews_title_updated
  ON reviews(title_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS ix_reviews_user_updated
  ON reviews(user_id, updated_at DESC);

