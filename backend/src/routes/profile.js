import express from "express";
import pool from "../db.js";
import { requireAuth } from "../middleware/auth.js";

const router = express.Router();
router.use(requireAuth);

router.get("/me", async (req, res) => {
  try {
    const userId = req.user.id;

    const userQ = await pool.query(
      `
      SELECT id, email, display_name, avatar_url, auth_provider, created_at
      FROM users
      WHERE id = $1
      LIMIT 1
      `,
      [userId]
    );
    if (!userQ.rows[0]) {
      return res.status(404).json({ ok: false, error: "user_not_found" });
    }

    const statsQ = await pool.query(
      `
      SELECT
        (SELECT COUNT(*)::int FROM wishlists WHERE user_id = $1 AND source IN ('app', 'trakt')) AS wishlist_count,
        (SELECT COUNT(*)::int FROM interactions WHERE user_id = $1 AND watched = TRUE) AS watched_count,
        (
          SELECT COUNT(*)::int
          FROM interactions
          WHERE user_id = $1 AND rating IS NOT NULL AND rating >= 1 AND rating <= 5
        ) AS ratings_count,
        (
          SELECT COUNT(*)::int
          FROM reviews
          WHERE user_id = $1 AND rating >= 1 AND rating <= 5
        ) AS reviews_count,
        (
          SELECT ROUND(COALESCE(AVG(rating), 0)::numeric, 2)::float8
          FROM reviews
          WHERE user_id = $1 AND rating >= 1 AND rating <= 5
        ) AS avg_review_rating
      `,
      [userId]
    );

    const activityQ = await pool.query(
      `
      SELECT
        e.id,
        e.event,
        e.title_id,
        e.meta,
        e.created_at,
        t.name AS title
      FROM interaction_events e
      LEFT JOIN titles t ON t.id = e.title_id
      WHERE e.user_id = $1
      ORDER BY e.created_at DESC
      LIMIT 30
      `,
      [userId]
    );

    const ratingsQ = await pool.query(
      `
      SELECT
        i.title_id,
        i.rating,
        i.ts,
        t.name AS title,
        t.year,
        t.poster_url
      FROM interactions i
      JOIN titles t ON t.id = i.title_id
      WHERE i.user_id = $1
        AND i.rating IS NOT NULL
        AND i.rating >= 1
        AND i.rating <= 5
      ORDER BY i.ts DESC
      LIMIT 30
      `,
      [userId]
    );

    const reviewsQ = await pool.query(
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
        AND r.rating >= 1
        AND r.rating <= 5
      ORDER BY r.updated_at DESC
      LIMIT 30
      `,
      [userId]
    );

    return res.json({
      ok: true,
      profile: userQ.rows[0],
      stats: statsQ.rows[0] || {
        wishlist_count: 0,
        watched_count: 0,
        ratings_count: 0,
        reviews_count: 0,
        avg_review_rating: 0,
      },
      recent_activity: activityQ.rows || [],
      ratings: ratingsQ.rows || [],
      reviews: reviewsQ.rows || [],
    });
  } catch (err) {
    console.error("GET /api/profile/me error:", err);
    return res.status(500).json({ ok: false, error: "profile_fetch_failed" });
  }
});

export default router;
