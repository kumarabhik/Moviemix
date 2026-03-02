// backend/src/routes/integrations.js
import express from "express";
import fetch from "node-fetch";
import pool from "../db.js";
import { requireAuth } from "../middleware/auth.js";

const router = express.Router();
router.use(requireAuth);

const TRAKT_BASE = "https://api.trakt.tv";
let traktAccessToken = process.env.TRAKT_ACCESS_TOKEN || "";
let traktRefreshToken = process.env.TRAKT_REFRESH_TOKEN || "";

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

function traktHeaders(clientId, token) {
  return {
    "content-type": "application/json",
    authorization: `Bearer ${token}`,
    "trakt-api-version": "2",
    "trakt-api-key": clientId,
  };
}

async function fetchWatchlistMovies(clientId, token) {
  return fetch(`${TRAKT_BASE}/sync/watchlist/movies?extended=full`, {
    method: "GET",
    headers: traktHeaders(clientId, token),
  });
}

async function tryRefreshTraktToken() {
  const clientId = process.env.TRAKT_CLIENT_ID;
  const clientSecret = process.env.TRAKT_CLIENT_SECRET;
  const redirectUri = process.env.TRAKT_REDIRECT_URI;
  if (!traktRefreshToken) {
    traktRefreshToken = process.env.TRAKT_REFRESH_TOKEN || "";
  }

  if (!clientId || !clientSecret || !redirectUri || !traktRefreshToken) {
    return { ok: false, error: "missing_refresh_env" };
  }

  const refreshRes = await fetch(`${TRAKT_BASE}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: traktRefreshToken,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
    }),
  });

  if (!refreshRes.ok) {
    const txt = await refreshRes.text().catch(() => "");
    return {
      ok: false,
      error: "refresh_failed",
      status: refreshRes.status,
      body: txt.slice(0, 300),
    };
  }

  const data = await refreshRes.json().catch(() => ({}));
  const newAccess = String(data?.access_token || "").trim();
  const newRefresh = String(data?.refresh_token || "").trim();
  if (!newAccess) {
    return { ok: false, error: "refresh_invalid_payload" };
  }

  traktAccessToken = newAccess;
  process.env.TRAKT_ACCESS_TOKEN = newAccess;

  if (newRefresh) {
    traktRefreshToken = newRefresh;
    process.env.TRAKT_REFRESH_TOKEN = newRefresh;
  }

  return {
    ok: true,
    accessToken: newAccess,
    refreshToken: newRefresh || null,
    expiresIn: data?.expires_in ?? null,
  };
}

// POST /api/integrations/trakt/import
router.post("/trakt/import", async (req, res) => {
  try {
    if (process.env.ENABLE_TRAKT_IMPORT !== "1") {
      return res.status(403).json({ ok: false, error: "trakt_import_disabled" });
    }

    const clientId = process.env.TRAKT_CLIENT_ID;
    const token = traktAccessToken || process.env.TRAKT_ACCESS_TOKEN;
    if (!traktAccessToken && token) {
      traktAccessToken = token;
    }

    if (!token || !clientId) {
      return res.status(500).json({ ok: false, error: "missing_trakt_env" });
    }

    let r = await fetchWatchlistMovies(clientId, token);
    let refreshed = false;

    // Access token expired or revoked -> try refresh once.
    if (r.status === 401) {
      const refreshedToken = await tryRefreshTraktToken();
      if (refreshedToken.ok && refreshedToken.accessToken) {
        refreshed = true;
        r = await fetchWatchlistMovies(clientId, refreshedToken.accessToken);
      } else {
        return res.status(502).json({
          ok: false,
          error: "trakt_auth_expired",
          hint: "Re-authorize Trakt and update TRAKT_ACCESS_TOKEN/TRAKT_REFRESH_TOKEN.",
          refresh_error: refreshedToken.error,
          refresh_status: refreshedToken.status ?? null,
          refresh_body: refreshedToken.body ?? "",
        });
      }
    }

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
      const dedupeKey = wishlistDedupeKeySql("t");
      const baseKey = wishlistDedupeKeySql("tb");
      const w = await pool.query(
        `
        WITH base AS (
          SELECT ${baseKey} AS dedupe_key
          FROM titles tb
          WHERE tb.id = $2
          LIMIT 1
        )
        INSERT INTO wishlists (user_id, title_id, source)
        SELECT $1, $2, 'trakt'
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

      // pg: rowCount=1 means inserted, 0 means already existed
      if (w.rowCount === 1) insertedWishlist++;
    }

    return res.json({
      ok: true,
      auth: { refreshed },
      totals: { fetched: items.length, insertedTitles, insertedWishlist, skipped },
    });
  } catch (err) {
    console.error("POST /api/integrations/trakt/import error:", err);
    return res.status(500).json({ ok: false, error: "trakt_import_failed" });
  }
});

export default router;
