import express from "express";
import pool from "../db.js";
import { requireAuth } from "../middleware/auth.js";

const router = express.Router();
router.use(requireAuth);

router.post("/", async (req, res) => {
  try {
    const { event, title_id, meta } = req.body || {};
    if (!event) return res.status(400).json({ ok:false, error:"event_required" });

    await pool.query(
      `INSERT INTO interaction_events (user_id, title_id, event, meta)
       VALUES ($1, $2, $3, $4)`,
      [req.user.id, title_id ?? null, event, meta ?? null]
    );

    res.json({ ok:true });
  } catch (e) {
    console.error("interaction_events insert error:", e);
    res.status(500).json({ ok:false, error:"interactions_failed" });
  }
});

export default router;
