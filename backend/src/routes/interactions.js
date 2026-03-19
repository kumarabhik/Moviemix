// interactions.js
import express from "express";
import pool from "../db.js";
import { requireAuth } from "../middleware/auth.js";

const router = express.Router();
router.use(requireAuth);

// Get my interactions (watched/rating/weight) for a list of title_ids
router.get("/me", async (req, res) => {
  try {
    const idsRaw = String(req.query.ids || "").trim();
    const ids = idsRaw
      ? idsRaw
          .split(",")
          .map((x) => Number(x))
          .filter((n) => Number.isFinite(n))
      : [];

    if (ids.length === 0) return res.json({ items: [] });

    const q = `
      SELECT title_id, watched, rating, weight
      FROM interactions
      WHERE user_id = $1 AND title_id = ANY($2::int[])
    `;
    const out = await pool.query(q, [req.user.id, ids]);
    return res.json({ items: out.rows });
  } catch (e) {
    console.error("GET /interactions/me error", e);
    return res.status(500).send("Internal Server Error");
  }
});

router.post("/", async (req, res) => {
  try {
    const { event, title_id, meta } = req.body || {};
    if (!event)
      return res.status(400).json({ ok: false, error: "event_required" });

    // ✅ FIX: ensure meta is stored as JSONB reliably
    const metaJson = JSON.stringify(meta ?? {});

    await pool.query(
      "INSERT INTO interaction_events (user_id, title_id, event, meta) VALUES ($1,$2,$3,$4::jsonb)",
      [req.user.id, title_id ?? null, event, metaJson]
    );

    // ------------------------------
    // Build signals into interactions
    // ------------------------------
    const ev = String(event || "").toLowerCase();
    const tid = title_id ?? null;

    if (tid) {
      let delta = 0.5;
      let watched = null; // null = no explicit watch override
      let rating = null;

      if (ev === "wishlist_add") delta = 3.0;
      else if (ev === "wishlist_remove") delta = -3.0;
      else if (ev === "watched" || ev === "watch") {
        delta = 5.0;
        watched = true;
      } else if (ev === "unwatch") {
        delta = -5.0;
        watched = false;
      } else if (ev === "rate" || ev === "rating") {
        delta = 2.0;
        const m = meta || {};
        const val = m.rating ?? m.value ?? null;
        const num = Number(val);
        if (!Number.isNaN(num) && num >= 1 && num <= 5) rating = num;
      }

      await pool.query(
        `
        INSERT INTO interactions (user_id, title_id, watched, weight, rating, ts)
        VALUES ($1, $2, $3, $4, $5, NOW())
        ON CONFLICT (user_id, title_id)
        DO UPDATE SET
          watched = CASE
            WHEN EXCLUDED.watched = false THEN false
            WHEN EXCLUDED.watched IS NULL THEN interactions.watched
            ELSE (interactions.watched OR EXCLUDED.watched)
          END,
          weight  = GREATEST(interactions.weight + EXCLUDED.weight, 0.0),
          rating  = COALESCE(EXCLUDED.rating, interactions.rating),
          ts      = GREATEST(interactions.ts, EXCLUDED.ts)
        `,
        [req.user.id, tid, watched, delta, rating]
      );
    }

    res.json({ ok: true });
  } catch (e) {
    console.error("interactions add error:", e);
    res.status(500).json({ ok: false, error: "interactions_failed" });
  }
});

export default router;
