// backend/src/metrics.js
import pool from "./db.js";

export async function logEvent(userId, titleId, event, meta = null) {
  try {
    await pool.query(
      `INSERT INTO interaction_events (user_id, title_id, event, meta)
       VALUES ($1, $2, $3, $4)`,
      [userId, titleId, event, meta]
    );
  } catch (err) {
    console.error("logEvent error:", err.message);
  }
}
