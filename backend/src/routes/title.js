// backend/src/routes/title.js
import express from "express";
import pool from "../db.js";    // same pool you use elsewhere

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

export default router;
