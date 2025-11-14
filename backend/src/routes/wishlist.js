// backend/src/routes/wishlist.js
import express from "express";
import pool from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { logEvent } from "../metrics.js";

const router = express.Router();

// All wishlist routes require auth
router.use(requireAuth);

// GET /api/wishlist
router.get("/", async (req, res) => {
  try {
    const userId = req.user.id;

    const result = await pool.query(
      `
      SELECT
        w.title_id,
        t.name         AS title,
        t.year,
        t.poster_url,
        t.plot,
        t.popularity,
        w.ts           AS added_at
      FROM wishlists w
      JOIN titles t ON t.id = w.title_id
      WHERE w.user_id = $1
        AND w.source = 'app'
      ORDER BY w.ts DESC
      `,
      [userId]
    );

    res.json({ ok: true, items: result.rows ?? [] });
  } catch (err) {
    console.error("GET /api/wishlist error:", err);
    res.status(500).json({ ok: false, error: "wishlist_fetch_failed" });
  }
});

// POST /api/wishlist/:titleId
router.post("/:titleId", async (req, res) => {
  try {
    const userId = req.user.id;
    const titleId = Number(req.params.titleId);
    if (!Number.isInteger(titleId)) {
      return res.status(400).json({ ok: false, error: "bad_title_id" });
    }

    await pool.query(
      `
      INSERT INTO wishlists (user_id, title_id, source)
      VALUES ($1, $2, 'app')
      ON CONFLICT (user_id, title_id, source) DO NOTHING
      `,
      [userId, titleId]
    );

    // log interaction (non-fatal if it fails)
    try {
      await logEvent(userId, titleId, "wishlist_add");
    } catch (e) {
      console.error("logEvent wishlist_add error:", e.message);
    }

    res.json({ ok: true });
  } catch (err) {
    console.error("POST /api/wishlist error:", err);
    res.status(500).json({ ok: false, error: "wishlist_add_failed" });
  }
});

// DELETE /api/wishlist/:titleId
router.delete("/:titleId", async (req, res) => {
  try {
    const userId = req.user.id;
    const titleId = Number(req.params.titleId);
    if (!Number.isInteger(titleId)) {
      return res.status(400).json({ ok: false, error: "bad_title_id" });
    }

    await pool.query(
      `DELETE FROM wishlists WHERE user_id = $1 AND title_id = $2 AND source = 'app'`,
      [userId, titleId]
    );

    // optional: log removal (non-fatal)
    try {
      await logEvent(userId, titleId, "wishlist_remove");
    } catch (e) {
      console.error("logEvent wishlist_remove error:", e.message);
    }

    res.json({ ok: true });
  } catch (err) {
    console.error("DELETE /api/wishlist error:", err);
    res.status(500).json({ ok: false, error: "wishlist_delete_failed" });
  }
});

export default router;
