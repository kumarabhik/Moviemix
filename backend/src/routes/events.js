import express from "express";
import pool from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { toAbSummary } from "../utils/reasoning.js";

const router = express.Router();
router.use(requireAuth);

router.post("/rebuild_signals", async (req, res) => {
  try {
    const userId = req.user.id;

    const weights = {
      click: 1.0,
      open: 1.0,
      view: 0.5,
      wishlist_add: 3.0,
      like: 2.0,
      watch: 5.0,
      watched: 5.0,
      rate: 2.0,
      rating: 2.0,
    };

    const { rows } = await pool.query(
      `
      SELECT title_id, event, meta, created_at
      FROM interaction_events
      WHERE user_id = $1 AND title_id IS NOT NULL
      ORDER BY created_at ASC
      `,
      [userId]
    );

    let upserts = 0;

    for (const r of rows) {
      const titleId = Number(r.title_id);
      if (!Number.isFinite(titleId)) continue;
      const ev = String(r.event || "").toLowerCase();

      const w = weights[ev] ?? 0.5;
      const watched = (ev === "watch" || ev === "watched");

      let rating = null;
      if (ev === "rate" || ev === "rating") {
        const m = r.meta || {};
        const val = m.rating ?? m.value ?? null;
        if (val !== null && val !== undefined && val !== "") {
          const num = Number(val);
          if (!Number.isNaN(num)) rating = num;
        }
      }

      await pool.query(
        `
        INSERT INTO interactions (user_id, title_id, watched, weight, rating, ts)
        VALUES ($1, $2, $3, $4, $5, NOW())
        ON CONFLICT (user_id, title_id)
        DO UPDATE SET
          watched = interactions.watched OR EXCLUDED.watched,
          weight  = interactions.weight + EXCLUDED.weight,
          rating  = COALESCE(EXCLUDED.rating, interactions.rating),
          ts      = NOW()

        `,
        [userId, titleId, watched, w, rating]
      );

      upserts += 1;
    }

    return res.json({ ok: true, user_id: userId, processed_events: rows.length, upserts });
  } catch (e) {
    console.error("rebuild_signals error:", e);
    return res.status(500).json({ ok: false, error: "rebuild_signals_failed" });
  }
});

router.get("/ab_summary", async (req, res) => {
  try {
    const rawDays = Number(req.query.days || 14);
    const windowDays = Number.isFinite(rawDays)
      ? Math.max(1, Math.min(90, rawDays))
      : 14;
    const scope = req.query.scope === "me" ? "me" : "all";

    const params = [windowDays];
    let whereClause = `created_at >= NOW() - ($1::int * INTERVAL '1 day')`;
    if (scope === "me") {
      params.push(req.user.id);
      whereClause += ` AND user_id = $2`;
    }

    const sql = `
      SELECT
        COALESCE(NULLIF(meta->>'ab_variant', ''), 'unknown') AS variant,
        COUNT(*) FILTER (
          WHERE event IN ('view', 'detail_open', 'open', 'click')
        )::int AS impressions,
        COUNT(*) FILTER (
          WHERE event = 'wishlist_add'
        )::int AS wishlist_adds,
        COUNT(*) FILTER (
          WHERE event IN ('watch', 'watched')
        )::int AS watched,
        COUNT(*) FILTER (
          WHERE event IN ('rate', 'rating')
        )::int AS ratings,
        COUNT(*) FILTER (
          WHERE event IN ('wishlist_add', 'watch', 'watched', 'rate', 'rating')
        )::int AS conversions
      FROM interaction_events
      WHERE ${whereClause}
      GROUP BY 1
      ORDER BY 1
    `;

    const { rows } = await pool.query(sql, params);
    const summary = toAbSummary(rows);

    return res.json({
      ok: true,
      window_days: windowDays,
      scope,
      ...summary,
    });
  } catch (e) {
    console.error("ab_summary error:", e);
    return res.status(500).json({ ok: false, error: "ab_summary_failed" });
  }
});

router.post("/", async (req, res) => {
  try {
    const { event, title_id, meta } = req.body || {};
    if (!event) return res.status(400).json({ ok: false, error: "event_required" });

    await pool.query(
      `INSERT INTO interaction_events (user_id, title_id, event, meta)
       VALUES ($1, $2, $3, $4)`,
      [req.user.id, title_id ?? null, event, meta ?? null]
    );

    res.json({ ok: true });
  } catch (e) {
    console.error("interaction_events insert error:", e);
    res.status(500).json({ ok: false, error: "interactions_failed" });
  }
});

export default router;
