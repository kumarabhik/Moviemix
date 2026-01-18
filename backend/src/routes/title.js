// backend/src/routes/title.js
import express from "express";
import pool from "../db.js"; // same pool you use elsewhere

const router = express.Router();

// GET /api/title/:id
router.get("/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ ok: false, error: "bad_id" });
  }

  try {
    const { rows } = await pool.query(
      `
      SELECT
        id,
        name        AS title,
        year,
        imdb_id,
        trakt_id,
        trakt_slug,
        plot,
        genres,
        poster_url,
        popularity
      FROM titles
      WHERE id = $1
      `,
      [id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ ok: false, error: "not_found" });
    }

    res.json({ ok: true, item: rows[0] });
  } catch (err) {
    console.error("GET /api/title/:id error:", err);
    res.status(500).json({ ok: false, error: "internal_error" });
  }
});

// GET /api/title/:id/watch-links  (TMDB-free, ISP-safe)
router.get("/:id/watch-links", async (req, res) => {
  if (process.env.ENABLE_WATCH_LINKS !== "1") {
    return res.status(403).json({ ok: false, error: "disabled" });
  }

  // ✅ Optional clarity rename (prevents confusion with other ids)
  const titleId = Number(req.params.id);
  if (!Number.isInteger(titleId)) {
    return res.status(400).json({ ok: false, error: "bad_id" });
  }

  try {
    // ✅ Bulletproof: never references unknown columns
    // ✅ Uses your actual PK column name: id
    const { rows } = await pool.query(
      `SELECT to_jsonb(t) AS row FROM titles t WHERE id=$1 LIMIT 1`,
      [titleId]
    );

    if (!rows.length) {
      return res.status(404).json({ ok: false, error: "not_found" });
    }

    const row = rows[0].row || {};

    const title =
      row.title ||
      row.primary_title ||
      row.original_title ||
      row.name ||
      row.series_title ||
      row.primaryTitle || // camelCase safety
      row.originalTitle ||
      "";

    const year =
      row.year ||
      row.start_year ||
      row.release_year ||
      row.startYear ||
      row.releaseYear ||
      "";

    const q = `${title}${year ? ` ${year}` : ""}`.trim();

    const links = {
      netflix: `https://www.netflix.com/search?q=${encodeURIComponent(q)}`,
      prime: `https://www.primevideo.com/search/ref=atv_nb_sr?phrase=${encodeURIComponent(
        q
      )}`,
      // disney: `https://www.hotstar.com/search?q=${encodeURIComponent(q)}`,
      google: `https://www.google.com/search?q=${encodeURIComponent(
        `watch ${q} online`
      )}`,
    };

    return res.json({ ok: true, links });
  } catch (e) {
    console.error("watch-links error:", e);
    return res.status(500).json({ ok: false, error: "internal_error" });
  }
});

export default router;
