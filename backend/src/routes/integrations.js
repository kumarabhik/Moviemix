// backend/src/routes/integrations.js
import express from "express";
import fetch from "node-fetch";
import pool from "../db.js";
import { requireAuth } from "../middleware/auth.js";

const router = express.Router();
router.use(requireAuth);

// POST /api/integrations/trakt/import
router.post("/trakt/import", async (req, res) => {
  try {
    if (process.env.ENABLE_TRAKT_IMPORT !== "1") {
      return res.status(403).json({ ok: false, error: "trakt_import_disabled" });
    }

    const token = process.env.TRAKT_ACCESS_TOKEN;
    const clientId = process.env.TRAKT_CLIENT_ID;

    if (!token || !clientId) {
      return res.status(500).json({ ok: false, error: "missing_trakt_env" });
    }

    const r = await fetch("https://api.trakt.tv/sync/watchlist/movies?extended=full", {
      method: "GET",
      headers: {
        "content-type": "application/json",
        "authorization": `Bearer ${token}`,
        "trakt-api-version": "2",
        "trakt-api-key": clientId,
      },
    });

    if (!r.ok) {
      const txt = await r.text().catch(() => "");
      return res.status(502).json({
        ok: false,
        error: "trakt_watchlist_fetch_failed",
        status: r.status,
        body: txt.slice(0, 300),
      });
    }

    const items = await r.json(); // array
    let insertedTitles = 0;
    let insertedWishlist = 0;
    let skipped = 0;

    for (const it of items) {
      const m = it?.movie;
      const ids = m?.ids || {};
      const imdb = ids.imdb || null;
      const traktId = Number.isInteger(ids.trakt) ? ids.trakt : null;
      const slug = ids.slug || null;

      const name = m?.title || null;
      const year = Number.isInteger(m?.year) ? m.year : null;
      const plot = m?.overview || null;

      if (!name) {
        skipped++;
        continue;
      }

      // 1) find existing title
      let titleId = null;
      if (imdb) {
        const q = await pool.query("SELECT id FROM titles WHERE imdb_id = $1 LIMIT 1", [imdb]);
        titleId = q.rows?.[0]?.id ?? null;
      }
      if (!titleId && traktId) {
        const q = await pool.query("SELECT id FROM titles WHERE trakt_id = $1 LIMIT 1", [traktId]);
        titleId = q.rows?.[0]?.id ?? null;
      }

      // 2) insert title if missing (minimal fields)
      if (!titleId) {
        const ins = await pool.query(
          `
          INSERT INTO titles (imdb_id, trakt_id, trakt_slug, name, year, plot, updated_at)
          VALUES ($1, $2, $3, $4, $5, $6, now())
          RETURNING id
          `,
          [imdb, traktId, slug, name, year, plot]
        );
        titleId = ins.rows?.[0]?.id ?? null;
        if (titleId) insertedTitles++;
      }

      if (!titleId) {
        skipped++;
        continue;
      }

      // 3) insert into wishlists as source='trakt' (idempotent)
      const userId = req.user.id;
      const w = await pool.query(
        `
        INSERT INTO wishlists (user_id, title_id, source)
        VALUES ($1, $2, 'trakt')
        ON CONFLICT (user_id, title_id, source) DO NOTHING
        `,
        [userId, titleId]
      );

      // pg: rowCount=1 means inserted, 0 means already existed
      if (w.rowCount === 1) insertedWishlist++;
    }

    return res.json({
      ok: true,
      totals: { fetched: items.length, insertedTitles, insertedWishlist, skipped },
    });
  } catch (err) {
    console.error("POST /api/integrations/trakt/import error:", err);
    return res.status(500).json({ ok: false, error: "trakt_import_failed" });
  }
});

export default router;
