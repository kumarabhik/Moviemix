// backend/src/routes/auth.js
import express from "express";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import pool from "../db.js";

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || "dev_secret_change_me";

// helper to issue a JWT
function issueToken(user) {
  return jwt.sign(
    {
      userId: user.id,
      email: user.email,
    },
    JWT_SECRET,
    { expiresIn: "7d" }
  );
}

// POST /api/auth/signup  { email, password }
router.post("/signup", async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ ok: false, error: "email_and_password_required" });
    }

    const normEmail = String(email).trim().toLowerCase();

    // check existing user
    const existing = await pool.query(
      "SELECT id FROM users WHERE lower(email) = $1 LIMIT 1",
      [normEmail]
    );
    if (existing.rows.length > 0) {
      return res.status(409).json({ ok: false, error: "email_in_use" });
    }

    const pass_hash = await bcrypt.hash(password, 10);

    const inserted = await pool.query(
      `INSERT INTO users (email, pass_hash)
       VALUES ($1, $2)
       RETURNING id, email, created_at`,
      [normEmail, pass_hash]
    );

    const user = inserted.rows[0];
    const token = issueToken(user);

    return res.json({
      ok: true,
      token,
      user: {
        id: user.id,
        email: user.email,
        created_at: user.created_at,
      },
    });
  } catch (err) {
    console.error("signup error:", err);
    return res.status(500).json({ ok: false, error: "signup_failed" });
  }
});

// POST /api/auth/login  { email, password }
router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ ok: false, error: "email_and_password_required" });
    }

    const normEmail = String(email).trim().toLowerCase();

    const q = await pool.query(
      "SELECT id, email, pass_hash, created_at FROM users WHERE lower(email) = $1 LIMIT 1",
      [normEmail]
    );
    const user = q.rows[0];
    if (!user) {
      return res.status(401).json({ ok: false, error: "invalid_credentials" });
    }

    const ok = await bcrypt.compare(password, user.pass_hash);
    if (!ok) {
      return res.status(401).json({ ok: false, error: "invalid_credentials" });
    }

    const token = issueToken(user);

    return res.json({
      ok: true,
      token,
      user: {
        id: user.id,
        email: user.email,
        created_at: user.created_at,
      },
    });
  } catch (err) {
    console.error("login error:", err);
    return res.status(500).json({ ok: false, error: "login_failed" });
  }
});

export default router;
