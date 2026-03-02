// backend/src/routes/wishlist.js
import express from "express";
import pool from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { logEvent } from "../metrics.js";

const router = express.Router();

function wishlistDedupeKeySql(alias = "t") {
  return `
    COALESCE(
      NULLIF(lower(trim(${alias}.imdb_id)), ''),
      CASE WHEN ${alias}.trakt_id IS NOT NULL THEN 'trakt:' || ${alias}.trakt_id::text ELSE NULL END,
      CASE
        WHEN NULLIF(lower(trim(${alias}.name)), '') IS NOT NULL
        THEN 'name:' || lower(trim(${alias}.name)) || ':' || COALESCE(${alias}.year::text, '')
        ELSE NULL
      END,
      'id:' || ${alias}.id::text
    )
  `;
}

// All wishlist routes require auth
router.use(requireAuth);

// GET /api/wishlist
router.get("/", async (req, res) => {
  try {
    const userId = String(req.user.id);
    const dedupeKey = wishlistDedupeKeySql("t");

    const result = await pool.query(
      `
      WITH wishlist_rows AS (
        SELECT
          w.title_id,
          t.imdb_id,
          t.trakt_id,
          t.name AS title,
          t.year,
          t.poster_url,
          t.plot,
          t.popularity,
          w.source AS source,
          w.ts AS added_at,
          ${dedupeKey} AS dedupe_key
        FROM wishlists w
        JOIN titles t ON t.id = w.title_id
        WHERE w.user_id = $1
          AND w.source IN ('app', 'trakt')
      ),
      ranked AS (
        SELECT
          *,
          ROW_NUMBER() OVER (
            PARTITION BY dedupe_key
            ORDER BY
              CASE WHEN source = 'app' THEN 0 ELSE 1 END,
              added_at DESC,
              title_id DESC
          ) AS rn
        FROM wishlist_rows
      )
      SELECT
        title_id,
        imdb_id,
        trakt_id,
        title,
        year,
        poster_url,
        plot,
        popularity,
        source,
        added_at
      FROM ranked
      WHERE rn = 1
      ORDER BY added_at DESC, title_id DESC
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
    const userId = String(req.user.id);
    const titleId = Number(req.params.titleId);
    const dedupeKey = wishlistDedupeKeySql("t");
    const baseKey = wishlistDedupeKeySql("tb");

    if (!Number.isInteger(titleId)) {
      return res.status(400).json({ ok: false, error: "bad_title_id" });
    }

    const inserted = await pool.query(
      `
      WITH base AS (
        SELECT ${baseKey} AS dedupe_key
        FROM titles tb
        WHERE tb.id = $2
        LIMIT 1
      )
      INSERT INTO wishlists (user_id, title_id, source)
      SELECT $1, $2, 'app'
      WHERE EXISTS (SELECT 1 FROM base)
        AND NOT EXISTS (
          SELECT 1
          FROM wishlists w
          JOIN titles t ON t.id = w.title_id
          JOIN base b ON TRUE
          WHERE w.user_id = $1
            AND w.source IN ('app', 'trakt')
            AND ${dedupeKey} = b.dedupe_key
        )
      ON CONFLICT (user_id, title_id, source) DO NOTHING
      RETURNING title_id
      `,
      [userId, titleId]
    );

    // log interaction (non-fatal if it fails)
    if (inserted.rowCount === 1) {
      try {
        await logEvent(userId, titleId, "wishlist_add");
      } catch (e) {
        console.error("logEvent wishlist_add error:", e.message);
      }
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
    const userId = String(req.user.id);
    const titleId = Number(req.params.titleId);
    const dedupeKey = wishlistDedupeKeySql("t");
    const baseKey = wishlistDedupeKeySql("tb");

    if (!Number.isInteger(titleId)) {
      return res.status(400).json({ ok: false, error: "bad_title_id" });
    }

    const deleted = await pool.query(
      `
      WITH base AS (
        SELECT ${baseKey} AS dedupe_key
        FROM titles tb
        WHERE tb.id = $2
        LIMIT 1
      )
      DELETE FROM wishlists w
      USING titles t, base b
      WHERE w.user_id = $1
        AND w.source IN ('app', 'trakt')
        AND w.title_id = t.id
        AND ${dedupeKey} = b.dedupe_key
      RETURNING w.title_id
      `,
      [userId, titleId]
    );

    // Fallback: if dedupe key could not be derived, remove exact title_id rows.
    if (deleted.rowCount === 0) {
      await pool.query(
        `DELETE FROM wishlists WHERE user_id = $1 AND title_id = $2 AND source IN ('app', 'trakt')`,
        [userId, titleId]
      );
    }

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
