// backend/src/index.js
import express from "express";
import cors from "cors";
import "dotenv/config";
import pkg from "pg";
import fetch from "node-fetch";
import recsRouter from './routes/recs.js';   // 👈 update path
import wishlistRouter from "./routes/wishlist.js";
import titleRouter from "./routes/title.js";
import authRoutes from "./routes/auth.js";
import interactionsRoutes from "./routes/events.js";
// app.use('/api/recs', recsRouter);

const { Pool } = pkg;

const PORT = process.env.PORT || 8000;
const DATABASE_URL = process.env.DATABASE_URL;
const RECS_URL = process.env.RECS_URL || "http://recommender:8001"; // <-- matches compose

const app = express();
app.use(cors());
app.use(express.json());

app.use("/api/wishlist", wishlistRouter);

app.use("/api/title", titleRouter);
app.use("/api/auth", authRoutes);
app.set('etag', false); 
// disable ETag generation globally
app.use("/api/interactions", interactionsRoutes);

app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  next();
});

// Global error handler (to print stack traces)
app.use((err, req, res, next) => {
  console.error("🔥 Global Error Handler:", err.stack || err);
  res.status(500).json({ ok: false, error: err.message || "Internal Server Error" });
});

app.use((req, res, next) => {
  console.log(`[${req.method}] ${req.url}`);
  next();
});

app.use('/api/recs', recsRouter);

// Postgres pool (optional if DATABASE_URL present)
const pool = DATABASE_URL ? new Pool({ connectionString: DATABASE_URL }) : null;

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

/** ---------- proxy to recommender ---------- **/
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

/** ---------- tiny /titles scaffold (DB read) ---------- **/
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

app.listen(PORT, () => {
  console.log(`Backend listening on :${PORT}`);
});
