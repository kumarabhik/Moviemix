import crypto from "crypto";
import express from "express";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import fetch from "node-fetch";
import { OAuth2Client } from "google-auth-library";
import pool from "../db.js";
import { JWT_SECRET } from "../config.js";

const router = express.Router();

const GOOGLE_CLIENT_ID = String(process.env.GOOGLE_CLIENT_ID || "").trim();
const GOOGLE_CLIENT_SECRET = String(process.env.GOOGLE_CLIENT_SECRET || "").trim();
const GOOGLE_REDIRECT_URI = String(process.env.GOOGLE_REDIRECT_URI || "").trim();
const GOOGLE_SCOPE = "openid email profile";
const googleClient = GOOGLE_CLIENT_ID ? new OAuth2Client(GOOGLE_CLIENT_ID) : null;

function googleAuthEnabled() {
  return Boolean(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET && GOOGLE_REDIRECT_URI && googleClient);
}

function issueToken(user) {
  return jwt.sign(
    {
      userId: user.id,
      email: user.email,
      name: user.display_name || "",
      avatarUrl: user.avatar_url || "",
      authProvider:
        user.auth_provider || (user.google_sub ? (user.pass_hash ? "hybrid" : "google") : "local"),
    },
    JWT_SECRET,
    { expiresIn: "7d" }
  );
}

function normalizeReturnTo(value) {
  const text = String(value || "/").trim() || "/";
  if (!text.startsWith("/") || text.startsWith("//")) {
    return "/";
  }
  return text;
}

function frontendOrigin(req) {
  const explicit = String(process.env.FRONTEND_ORIGIN || "").trim().replace(/\/+$/, "");
  if (explicit) return explicit;

  const origin = String(req.get("origin") || "").trim().replace(/\/+$/, "");
  if (origin) return origin;

  return "http://localhost:3000";
}

function buildFrontendCallbackUrl(req, params = {}) {
  const origin = frontendOrigin(req);
  const url = new URL("/auth/google/callback", `${origin}/`);
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && String(value) !== "") {
      url.searchParams.set(key, String(value));
    }
  });
  return url.toString();
}

function redirectWithAuthError(req, res, error, returnTo = "/") {
  return res.redirect(
    buildFrontendCallbackUrl(req, {
      error,
      returnTo: normalizeReturnTo(returnTo),
    })
  );
}

async function upsertGoogleUser({ email, googleSub, displayName, avatarUrl }) {
  await pool.query("BEGIN");
  try {
    const byGoogle = await pool.query(
      `
      SELECT id, email, pass_hash, google_sub, display_name, avatar_url, auth_provider, created_at
      FROM users
      WHERE google_sub = $1
      LIMIT 1
      `,
      [googleSub]
    );

    if (byGoogle.rows[0]) {
      const updated = await pool.query(
        `
        UPDATE users
        SET
          email = $2,
          display_name = $3,
          avatar_url = $4,
          auth_provider = CASE
            WHEN pass_hash IS NOT NULL THEN 'hybrid'
            ELSE 'google'
          END
        WHERE id = $1
        RETURNING id, email, pass_hash, google_sub, display_name, avatar_url, auth_provider, created_at
        `,
        [byGoogle.rows[0].id, email, displayName || null, avatarUrl || null]
      );
      await pool.query("COMMIT");
      return updated.rows[0];
    }

    const byEmail = await pool.query(
      `
      SELECT id, email, pass_hash, google_sub, display_name, avatar_url, auth_provider, created_at
      FROM users
      WHERE lower(email) = $1
      LIMIT 1
      `,
      [email]
    );

    if (byEmail.rows[0]) {
      const updated = await pool.query(
        `
        UPDATE users
        SET
          google_sub = $2,
          display_name = COALESCE(NULLIF($3, ''), display_name),
          avatar_url = COALESCE(NULLIF($4, ''), avatar_url),
          auth_provider = CASE
            WHEN pass_hash IS NOT NULL THEN 'hybrid'
            ELSE 'google'
          END
        WHERE id = $1
        RETURNING id, email, pass_hash, google_sub, display_name, avatar_url, auth_provider, created_at
        `,
        [byEmail.rows[0].id, googleSub, displayName || null, avatarUrl || null]
      );
      await pool.query("COMMIT");
      return updated.rows[0];
    }

    const inserted = await pool.query(
      `
      INSERT INTO users (email, pass_hash, auth_provider, google_sub, display_name, avatar_url)
      VALUES ($1, NULL, 'google', $2, $3, $4)
      RETURNING id, email, pass_hash, google_sub, display_name, avatar_url, auth_provider, created_at
      `,
      [email, googleSub, displayName || null, avatarUrl || null]
    );

    await pool.query("COMMIT");
    return inserted.rows[0];
  } catch (err) {
    await pool.query("ROLLBACK");
    throw err;
  }
}

router.get("/providers", (_req, res) => {
  res.json({
    ok: true,
    providers: {
      google: googleAuthEnabled(),
    },
  });
});

router.get("/google/start", async (req, res) => {
  if (!googleAuthEnabled()) {
    return res.status(503).json({ ok: false, error: "google_auth_not_configured" });
  }

  const returnTo = normalizeReturnTo(req.query.returnTo);
  const state = jwt.sign(
    {
      purpose: "google_oauth_state",
      nonce: crypto.randomUUID(),
      returnTo,
    },
    JWT_SECRET,
    { expiresIn: "15m" }
  );

  const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authUrl.searchParams.set("client_id", GOOGLE_CLIENT_ID);
  authUrl.searchParams.set("redirect_uri", GOOGLE_REDIRECT_URI);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", GOOGLE_SCOPE);
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("prompt", "select_account");
  authUrl.searchParams.set("include_granted_scopes", "true");

  return res.redirect(authUrl.toString());
});

router.get("/google/callback", async (req, res) => {
  const fallbackReturnTo = normalizeReturnTo(req.query.returnTo);

  if (!googleAuthEnabled()) {
    return redirectWithAuthError(req, res, "google_auth_not_configured", fallbackReturnTo);
  }

  if (req.query.error) {
    return redirectWithAuthError(req, res, String(req.query.error), fallbackReturnTo);
  }

  const code = String(req.query.code || "").trim();
  const state = String(req.query.state || "").trim();
  if (!code || !state) {
    return redirectWithAuthError(req, res, "google_callback_missing_code", fallbackReturnTo);
  }

  let statePayload;
  try {
    statePayload = jwt.verify(state, JWT_SECRET);
    if (statePayload?.purpose !== "google_oauth_state") {
      throw new Error("invalid_state_purpose");
    }
  } catch (_err) {
    return redirectWithAuthError(req, res, "google_state_invalid", fallbackReturnTo);
  }

  try {
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: GOOGLE_REDIRECT_URI,
        grant_type: "authorization_code",
      }),
    });

    const tokenJson = await tokenRes.json().catch(() => ({}));
    if (!tokenRes.ok || !tokenJson?.id_token) {
      console.error("google token exchange failed:", tokenJson);
      return redirectWithAuthError(
        req,
        res,
        "google_token_exchange_failed",
        statePayload?.returnTo
      );
    }

    const ticket = await googleClient.verifyIdToken({
      idToken: tokenJson.id_token,
      audience: GOOGLE_CLIENT_ID,
    });
    const payload = ticket.getPayload();

    const email = String(payload?.email || "").trim().toLowerCase();
    const emailVerified = payload?.email_verified === true;
    const googleSub = String(payload?.sub || "").trim();
    const displayName = String(payload?.name || "").trim();
    const avatarUrl = String(payload?.picture || "").trim();

    if (!email || !googleSub || !emailVerified) {
      return redirectWithAuthError(
        req,
        res,
        "google_account_not_verified",
        statePayload?.returnTo
      );
    }

    const user = await upsertGoogleUser({
      email,
      googleSub,
      displayName,
      avatarUrl,
    });
    const token = issueToken(user);

    return res.redirect(
      buildFrontendCallbackUrl(req, {
        token,
        returnTo: normalizeReturnTo(statePayload?.returnTo),
      })
    );
  } catch (err) {
    console.error("google callback error:", err);
    return redirectWithAuthError(req, res, "google_login_failed", statePayload?.returnTo);
  }
});

router.post("/signup", async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ ok: false, error: "email_and_password_required" });
    }

    const normEmail = String(email).trim().toLowerCase();

    const existing = await pool.query(
      `
      SELECT id, google_sub, pass_hash
      FROM users
      WHERE lower(email) = $1
      LIMIT 1
      `,
      [normEmail]
    );
    if (existing.rows.length > 0) {
      const row = existing.rows[0];
      const error =
        row.google_sub && !row.pass_hash ? "account_exists_use_google_login" : "email_in_use";
      return res.status(409).json({ ok: false, error });
    }

    const pass_hash = await bcrypt.hash(password, 10);

    const inserted = await pool.query(
      `
      INSERT INTO users (email, pass_hash, auth_provider)
      VALUES ($1, $2, 'local')
      RETURNING id, email, pass_hash, google_sub, display_name, avatar_url, auth_provider, created_at
      `,
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
        display_name: user.display_name,
        avatar_url: user.avatar_url,
        auth_provider: user.auth_provider,
        created_at: user.created_at,
      },
    });
  } catch (err) {
    console.error("signup error:", err);
    return res.status(500).json({ ok: false, error: "signup_failed" });
  }
});

router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ ok: false, error: "email_and_password_required" });
    }

    const normEmail = String(email).trim().toLowerCase();

    const q = await pool.query(
      `
      SELECT id, email, pass_hash, google_sub, display_name, avatar_url, auth_provider, created_at
      FROM users
      WHERE lower(email) = $1
      LIMIT 1
      `,
      [normEmail]
    );
    const user = q.rows[0];
    if (!user) {
      return res.status(401).json({ ok: false, error: "invalid_credentials" });
    }

    if (!user.pass_hash) {
      return res.status(401).json({ ok: false, error: "use_google_login" });
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
        display_name: user.display_name,
        avatar_url: user.avatar_url,
        auth_provider: user.auth_provider,
        created_at: user.created_at,
      },
    });
  } catch (err) {
    console.error("login error:", err);
    return res.status(500).json({ ok: false, error: "login_failed" });
  }
});

export default router;
