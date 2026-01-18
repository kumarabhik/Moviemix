// backend/src/index.js
import express from "express";
import cors from "cors";
import "dotenv/config";
import pkg from "pg";
import fetch from "node-fetch";

import recsRouter from "./routes/recs.js";
import wishlistRouter from "./routes/wishlist.js";
import titleRouter from "./routes/title.js";
import authRoutes from "./routes/auth.js";
import interactionsRoutes from "./routes/interactions.js";
import eventsRouter from "./routes/events.js";
import integrationsRouter from "./routes/integrations.js";

import client from "prom-client";
// new mount

const { Pool } = pkg;

const PORT = process.env.PORT || 8000;
const DATABASE_URL = process.env.DATABASE_URL;
const RECS_URL = process.env.RECS_URL || "http://recommender:8001";

const app = express();
app.use(cors());
app.use(express.json());

/* =========================
   Disable caching
========================= */
app.set("etag", false);
app.use((req, res, next) => {
  res.set("Cache-Control", "no-store");
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");
  next();
});

/* =========================
   Logger
========================= */
app.use((req, res, next) => {
  console.log(`[${req.method}] ${req.url}`);
  next();
});

/* =========================
   ---- Prometheus metrics ----
========================= */
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

// capture metrics for all requests
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

// expose metrics endpoint
app.get("/metrics", async (_req, res) => {
  res.set("Content-Type", client.register.contentType);
  res.end(await client.register.metrics());
});

/* =========================
   Routes
========================= */
app.use("/api/wishlist", wishlistRouter);
app.use("/api/title", titleRouter);
app.use("/api/auth", authRoutes);
app.use("/api/interactions", interactionsRoutes);
app.use("/api/events", eventsRouter);
app.use("/api/recs", recsRouter);
app.use("/api/integrations", integrationsRouter);

/* =========================
   Postgres pool
========================= */
const pool = DATABASE_URL
  ? new Pool({ connectionString: DATABASE_URL })
  : null;

/* =========================
   Health checks
========================= */
app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "backend", ts: new Date().toISOString() });
});

app.get("/db/health", async (_req, res) => {
  if (!pool) return res.status(500).json({ ok: false, error: "No DATABASE_URL" });
  try {
    const r = await pool.query("SELECT 1 AS up");
    res.json({ ok: true, db: r.rows[0].up === 1 });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* =========================
   Proxy to recommender
========================= */
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

/* =========================
   Titles scaffold
========================= */
app.get("/api/titles", async (_req, res) => {
  if (!pool) return res.status(500).json({ ok: false, error: "No DATABASE_URL" });
  try {
    const { rows } = await pool.query(
      "SELECT id, name, year, imdb_id, trakt_id, trakt_slug, poster_url FROM titles ORDER BY id DESC LIMIT 50"
    );
    res.json({ ok: true, items: rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* =========================
   Global error handler (LAST)
========================= */
app.use((err, req, res, next) => {
  console.error("🔥 Global Error Handler:", err.stack || err);
  res
    .status(500)
    .json({ ok: false, error: err.message || "Internal Server Error" });
});

/* =========================
   Start server
========================= */
app.listen(PORT, () => {
  console.log(`Backend listening on :${PORT}`);
});
