import express from "express";
import cors from "cors";
import "dotenv/config";
import fetch from "node-fetch";
import client from "prom-client";

import pool from "./db.js";
import recsRouter from "./routes/recs.js";
import wishlistRouter from "./routes/wishlist.js";
import titleRouter from "./routes/title.js";
import authRoutes from "./routes/auth.js";
import interactionsRoutes from "./routes/interactions.js";
import eventsRouter from "./routes/events.js";
import integrationsRouter from "./routes/integrations.js";
import reviewsRouter from "./routes/reviews.js";
import profileRouter from "./routes/profile.js";

const PORT = process.env.PORT || 8000;
const RECS_URL = process.env.RECS_URL || "http://recommender:8001";
const allowedOrigins = String(process.env.CORS_ORIGIN || "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

const app = express();
app.use(
  cors(
    allowedOrigins.length === 0
      ? {}
      : {
          origin(origin, callback) {
            if (!origin || allowedOrigins.includes(origin)) {
              return callback(null, true);
            }
            return callback(new Error("Not allowed by CORS"));
          },
        }
  )
);
app.use(express.json());

app.set("etag", false);
app.use((req, res, next) => {
  res.set("Cache-Control", "no-store");
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");
  next();
});

app.use((req, _res, next) => {
  console.log(`[${req.method}] ${req.url}`);
  next();
});

client.collectDefaultMetrics();
const httpRequestsTotal = new client.Counter({
  name: "http_requests_total",
  help: "Total HTTP requests",
  labelNames: ["method", "route", "status"],
});
const httpRequestDurationMs = new client.Histogram({
  name: "http_request_duration_ms",
  help: "HTTP request duration in ms",
  labelNames: ["method", "route", "status"],
  buckets: [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000],
});

app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    const route = req.route?.path || req.baseUrl || req.path || "unknown";
    const status = String(res.statusCode);
    httpRequestsTotal.labels(req.method, route, status).inc();
    httpRequestDurationMs
      .labels(req.method, route, status)
      .observe(Date.now() - start);
  });
  next();
});

app.get("/metrics", async (_req, res) => {
  res.set("Content-Type", client.register.contentType);
  res.end(await client.register.metrics());
});

app.use("/api/wishlist", wishlistRouter);
app.use("/api/title", titleRouter);
app.use("/api/auth", authRoutes);
app.use("/api/interactions", interactionsRoutes);
app.use("/api/events", eventsRouter);
app.use("/api/recs", recsRouter);
app.use("/api/integrations", integrationsRouter);
app.use("/api/reviews", reviewsRouter);
app.use("/api/profile", profileRouter);

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "backend", ts: new Date().toISOString() });
});

app.get("/db/health", async (_req, res) => {
  try {
    const r = await pool.query("SELECT 1 AS up");
    res.json({ ok: true, db: r.rows[0].up === 1 });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post("/api/recs/content", async (req, res) => {
  try {
    const r = await fetch(`${RECS_URL}/recs/content`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(req.body || {}),
    });
    const data = await r.json().catch(() => ({}));
    res.status(r.status).json(data);
  } catch (e) {
    res.status(502).json({ ok: false, error: `recommender: ${e.message}` });
  }
});

app.post("/api/recs/semantic", async (req, res) => {
  try {
    const r = await fetch(`${RECS_URL}/recs/semantic`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(req.body || {}),
    });
    const data = await r.json().catch(() => ({}));
    res.status(r.status).json(data);
  } catch (e) {
    res.status(502).json({ ok: false, error: `recommender: ${e.message}` });
  }
});

app.get("/api/titles", async (_req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT id, name, year, imdb_id, trakt_id, trakt_slug, poster_url FROM titles ORDER BY id DESC LIMIT 50"
    );
    res.json({ ok: true, items: rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});


app.get("/api/titles/suggest", async (req, res) => {
  const raw = String(req.query.q || "").trim();
  const limit = Math.min(Math.max(1, parseInt(req.query.limit || "8", 10)), 20);
  if (raw.length < 1) return res.json({ ok: true, items: [] });
  const escaped = raw.replace(/[%_\\]/g, (c) => `\\${c}`);
  try {
    const { rows } = await pool.query(
      `SELECT id, name AS title, year, poster_url
       FROM titles
       WHERE name ILIKE $1 ESCAPE '\\'
       ORDER BY popularity DESC NULLS LAST, year DESC NULLS LAST
       LIMIT $2`,
      [`%${escaped}%`, limit]
    );
    res.json({ ok: true, items: rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.use((err, _req, res, _next) => {
  console.error("Global Error Handler:", err.stack || err);
  res.status(500).json({ ok: false, error: err.message || "Internal Server Error" });
});

async function ensureRuntimeTables() {
  await pool.query("ALTER TABLE users ALTER COLUMN pass_hash DROP NOT NULL");
  await pool.query(
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS auth_provider TEXT NOT NULL DEFAULT 'local'"
  );
  await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS google_sub TEXT");
  await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS display_name TEXT");
  await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url TEXT");
  await pool.query(
    "CREATE UNIQUE INDEX IF NOT EXISTS ux_users_google_sub ON users(google_sub) WHERE google_sub IS NOT NULL"
  );
  await pool.query(`
    UPDATE users
    SET auth_provider = CASE
      WHEN google_sub IS NOT NULL AND pass_hash IS NOT NULL THEN 'hybrid'
      WHEN google_sub IS NOT NULL THEN 'google'
      ELSE 'local'
    END
    WHERE auth_provider IS NULL OR trim(auth_provider) = ''
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS reviews (
      id BIGSERIAL PRIMARY KEY,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title_id INT NOT NULL REFERENCES titles(id) ON DELETE CASCADE,
      rating DOUBLE PRECISION NOT NULL CHECK (rating >= 1 AND rating <= 5),
      review_text TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (user_id, title_id)
    )
  `);

  await pool.query(
    "CREATE INDEX IF NOT EXISTS ix_reviews_title_updated ON reviews(title_id, updated_at DESC)"
  );
  await pool.query(
    "CREATE INDEX IF NOT EXISTS ix_reviews_user_updated ON reviews(user_id, updated_at DESC)"
  );

  // cleanup of older invalid values from previous 10-point implementation
  await pool.query("DELETE FROM reviews WHERE rating < 1 OR rating > 5");
  await pool.query("UPDATE interactions SET rating = NULL WHERE rating < 1 OR rating > 5");
}

async function startServer() {
  try {
    await ensureRuntimeTables();
  } catch (err) {
    console.error("Failed to ensure runtime tables:", err.message);
  }

  app.listen(PORT, () => {
    console.log(`Backend listening on :${PORT}`);
  });
}

startServer();
