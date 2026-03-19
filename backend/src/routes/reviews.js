import express from "express";
import pool from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { logEvent } from "../metrics.js";

const router = express.Router();

function asInt(v) {
  const n = Number(v);
  return Number.isInteger(n) ? n : null;
}

function normalizeReviewText(v) {
  return String(v || "").trim();
}

router.get("/title/:titleId", async (req, res) => {
  try {
    const titleId = asInt(req.params.titleId);
    if (!titleId) {
      return res.status(400).json({ ok: false, error: "bad_title_id" });
    }

    const list = await pool.query(
      `
      SELECT
        r.id,
        r.user_id,
        r.title_id,
        r.rating,
        r.review_text,
        r.created_at,
        r.updated_at,
        u.email AS reviewer
      FROM reviews r
      JOIN users u ON u.id = r.user_id
      WHERE r.title_id = $1
      ORDER BY r.updated_at DESC
      LIMIT 100
      `,
      [titleId]
    );

    const summary = await pool.query(
      `
      SELECT
        COUNT(*)::int AS count,
        ROUND(COALESCE(AVG(rating), 0)::numeric, 2)::float8 AS avg_rating
      FROM reviews
      WHERE title_id = $1
      `,
      [titleId]
    );

    return res.json({
      ok: true,
      summary: summary.rows[0] || { count: 0, avg_rating: 0 },
      items: list.rows || [],
    });
  } catch (err) {
    console.error("GET /api/reviews/title/:titleId error:", err);
    return res.status(500).json({ ok: false, error: "reviews_fetch_failed" });
  }
});

router.use(requireAuth);

router.get("/me", async (req, res) => {
  try {
    const out = await pool.query(
      `
      SELECT
        r.id,
        r.title_id,
        r.rating,
        r.review_text,
        r.created_at,
        r.updated_at,
        t.name AS title,
        t.year,
        t.poster_url
      FROM reviews r
      JOIN titles t ON t.id = r.title_id
      WHERE r.user_id = $1
      ORDER BY r.updated_at DESC
      LIMIT 200
      `,
      [req.user.id]
    );

    return res.json({ ok: true, items: out.rows || [] });
  } catch (err) {
    console.error("GET /api/reviews/me error:", err);
    return res.status(500).json({ ok: false, error: "my_reviews_fetch_failed" });
  }
});

router.post("/title/:titleId", async (req, res) => {
  try {
    const titleId = asInt(req.params.titleId);
    if (!titleId) {
      return res.status(400).json({ ok: false, error: "bad_title_id" });
    }

    const rating = Number(req.body?.rating);
    if (!Number.isFinite(rating) || rating < 1 || rating > 5) {
      return res.status(400).json({ ok: false, error: "rating_must_be_1_to_5" });
    }

    const reviewText = normalizeReviewText(req.body?.review_text);
    if (reviewText.length < 5) {
      return res.status(400).json({ ok: false, error: "review_too_short" });
    }

    const exists = await pool.query(
      "SELECT id FROM titles WHERE id = $1 LIMIT 1",
      [titleId]
    );
    if (exists.rows.length === 0) {
      return res.status(404).json({ ok: false, error: "title_not_found" });
    }

    const saved = await pool.query(
      `
      INSERT INTO reviews (user_id, title_id, rating, review_text)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (user_id, title_id)
      DO UPDATE SET
        rating = EXCLUDED.rating,
        review_text = EXCLUDED.review_text,
        updated_at = now()
      RETURNING id, user_id, title_id, rating, review_text, created_at, updated_at
      `,
      [req.user.id, titleId, rating, reviewText]
    );

    try {
      await logEvent(req.user.id, titleId, "review_add", { rating });
    } catch (eventErr) {
      console.error("review_add logEvent error:", eventErr.message);
    }

    return res.json({ ok: true, item: saved.rows[0] });
  } catch (err) {
    console.error("POST /api/reviews/title/:titleId error:", err);
    return res.status(500).json({ ok: false, error: "review_save_failed" });
  }
});

export default router;
