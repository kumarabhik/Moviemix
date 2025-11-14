CREATE TABLE IF NOT EXISTS interaction_events (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title_id INT REFERENCES titles(id) ON DELETE CASCADE,
  event TEXT NOT NULL,
  meta JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ix_ie_user_created
  ON interaction_events(user_id, created_at DESC);

CREATE MATERIALIZED VIEW IF NOT EXISTS popular_titles AS
SELECT title_id, COUNT(*) AS cnt
FROM wishlists w
GROUP BY title_id
ORDER BY cnt DESC;

CREATE UNIQUE INDEX IF NOT EXISTS idx_popular_titles_title_id
  ON popular_titles(title_id);

CREATE OR REPLACE VIEW top_popular_titles AS 
SELECT t.id, t.name, pt.cnt
FROM popular_titles pt
JOIN titles t ON t.id = pt.title_id
ORDER BY pt.cnt DESC;
