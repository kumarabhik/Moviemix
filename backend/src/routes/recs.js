// backend/src/routes/recs.js
import express from "express";
import fetch from "node-fetch";
import pool from "../db.js";
import authRequired from "../middleware/auth.js";

const router = express.Router();
const RECS_URL = process.env.RECS_URL || "http://recommender:8001";
const OMDB_KEY = process.env.OMDB_API_KEY || process.env.OMDB_KEY || "";

// no-cache for all /api/recs/*
router.use((req, res, next) => {
  res.set("Cache-Control", "no-store");
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");
  next();
});

async function omdbPoster(imdbId) {
  if (!OMDB_KEY || !imdbId) return null;
  try {
    const r = await fetch(
      `https://www.omdbapi.com/?i=${encodeURIComponent(imdbId)}&apikey=${OMDB_KEY}`
    );
    const j = await r.json();
    if (j && j.Poster && j.Poster !== "N/A") return j.Poster;
  } catch (_) {}
  return null;
}

// Normalize recommender response into an array
function toArray(res) {
  if (!res) return [];
  if (Array.isArray(res)) return res;
  if (Array.isArray(res.items)) return res.items;
  if (Array.isArray(res.results)) return res.results;
  if (Array.isArray(res.data)) return res.data;
  return [];
}

// --- CF + semantic hybrid helpers (global) ---

// Basic CF from DB (public.popular_titles)
async function getCfRecs(limit = 20) {
  const q = await pool.query(
    `SELECT t.id AS title_id,
            t.name AS title,
            t.year,
            t.poster_url,
            p.cnt::float AS score
     FROM public.popular_titles p
     JOIN titles t ON t.id = p.title_id
     ORDER BY p.cnt DESC
     LIMIT $1`,
    [limit]
  );
  return q.rows;
}

// Pick seeds for semantic fallback (here: just from popular_titles)
async function pickSeeds(limit = 5) {
  const q = await pool.query(
    `SELECT t.id AS title_id,
            t.name AS title
     FROM public.popular_titles p
     JOIN titles t ON t.id = p.title_id
     ORDER BY p.cnt DESC
     LIMIT $1`,
    [limit]
  );
  return q.rows;
}

// Call semantic recommender using seed titles (by name) and enrich from DB
async function getSemanticFallbackFromSeeds(seeds, target = 10) {
  if (!seeds || seeds.length === 0) return [];

  const collected = [];
  const seen = new Set(); // dedupe by title_id

  for (const seed of seeds) {
    const seedTitle = (seed.title || seed.name || "").toString().trim();
    if (!seedTitle) continue;

    try {
      const r = await fetch(`${RECS_URL}/recs/semantic`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: seedTitle, topK: target }),
      });

      if (!r.ok) {
        console.error(
          "semantic fallback HTTP error for seed:",
          seedTitle,
          r.status
        );
        continue;
      }

      const base = await r.json();
      const items = toArray(base);

      for (const it of items) {
        if (collected.length >= target * 2) break; // safety cap

        const rawId = it.title_id || it.id || null;
        const rawName = (it.title || it.name || "").toString();

        let row = null;

        // Try by id first
        if (rawId) {
          const q = await pool.query(
            `SELECT id, name, year, imdb_id, trakt_id, trakt_slug, poster_url, plot, genres
             FROM titles
             WHERE id = $1
             LIMIT 1`,
            [rawId]
          );
          row = q.rows[0] || null;
        }

        // Fallback: lookup by name
        if (!row && rawName) {
          const q = await pool.query(
            `SELECT id, name, year, imdb_id, trakt_id, trakt_slug, poster_url, plot, genres
             FROM titles
             WHERE lower(name) = lower($1)
             ORDER BY popularity DESC NULLS LAST
             LIMIT 1`,
            [rawName]
          );
          row = q.rows[0] || null;
        }

        const finalId = rawId || row?.id || null;
        if (!finalId || seen.has(finalId)) continue;

        let poster_url = row?.poster_url || null;
        if (!poster_url && row?.imdb_id) {
          poster_url = await omdbPoster(row.imdb_id);
        }

        seen.add(finalId);

        collected.push({
          title_id: finalId,
          title: rawName || row?.name || null,
          year: row?.year ?? null,
          poster_url: poster_url || null,
          score:
            typeof it.score === "number" ? it.score : it.similarity ?? null,
        });
      }
    } catch (err) {
      console.error("semantic fallback error for seed:", seedTitle, err);
    }
  }

  return collected.slice(0, target);
}

// --- User-specific helpers you asked for ---

async function pickSeedsForUser(userId) {
  // Option A: wishlist first
  const { rows: wl } = await pool.query(
    "SELECT title_id FROM wishlists WHERE user_id = $1 ORDER BY ts DESC LIMIT 3",
    [userId]
  );
  if (wl.length > 0) return wl.map((r) => r.title_id);

  // Option B: fallback to most popular titles
  const { rows: popular } = await pool.query(
    "SELECT title_id FROM public.popular_titles ORDER BY cnt DESC LIMIT 3"
  );
  return popular.map((r) => r.title_id);
}

// This version uses /recs/by_seed on the recommender (by title_id)
async function getSemanticFallback(seedTitleIds, target) {
  if (!seedTitleIds || seedTitleIds.length === 0) return [];

  const seed = seedTitleIds[0];

  try {
    const r = await fetch(
      `${RECS_URL}/recs/by_seed?id=${encodeURIComponent(
        seed
      )}&topK=${encodeURIComponent(target)}`,
      {
        method: "GET",
      }
    );

    if (!r.ok) {
      console.error("semantic by_seed HTTP error:", r.status);
      return [];
    }

    const data = await r.json();
    return data.items || data.results || data.data || [];
  } catch (err) {
    console.error("semantic by_seed error:", err);
    return [];
  }
}

// GET /api/recs/semantic?query=...&topK=5
router.get("/semantic", async (req, res) => {
  try {
    const query = (req.query.query || "").toString().trim();
    const topK = Number(req.query.topK || 5);
    if (!query) {
      return res
        .status(400)
        .json({ ok: false, error: "query is required" });
    }

    // 1) ask recommender (semantic/embedding-based)
    const r = await fetch(`${RECS_URL}/recs/semantic`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query, topK }),
    });
    const base = await r.json();
    if (!r.ok) return res.status(r.status).json(base);

    const items = toArray(base);

    // 2) enrich semantic candidates from DB
    const enriched = [];
    for (const it of items) {
      const titleId = it.title_id || it.id || null;
      const titleName = (it.title || it.name || "").toString();

      let row = null;

      if (titleId) {
        const q = await pool.query(
          `SELECT id, name, year, imdb_id, trakt_id, trakt_slug, poster_url, plot, genres 
           FROM titles WHERE id = $1 LIMIT 1`,
          [titleId]
        );
        row = q.rows[0] || null;
      }

      if (!row && titleName) {
        const q = await pool.query(
          `SELECT id, name, year, imdb_id, trakt_id, trakt_slug, poster_url, plot, genres 
           FROM titles 
           WHERE lower(name) = lower($1)
           ORDER BY popularity DESC NULLS LAST
           LIMIT 1`,
          [titleName]
        );
        row = q.rows[0] || null;
      }

      let poster_url = row?.poster_url || null;
      if (!poster_url && row?.imdb_id) {
        poster_url = await omdbPoster(row.imdb_id);
      }

      enriched.push({
        title_id: titleId || row?.id || null,
        title: titleName || row?.name || null,
        score:
          typeof it.score === "number" ? it.score : it.similarity ?? null,
        year: row?.year ?? null,
        imdb_id: row?.imdb_id ?? null,
        trakt_id: row?.trakt_id ?? null,
        trakt_slug: row?.trakt_slug ?? null,
        plot: row?.plot ?? null,
        genres: row?.genres ?? null,
        poster_url: poster_url || null,
      });
    }

    // 3) ALSO: lexical title search (LIKE %query%) to catch franchises like "Ice Age"
    const likePattern = `%${query}%`;
    const lexical = await pool.query(
      `SELECT id, name, year, imdb_id, trakt_id, trakt_slug, poster_url, plot, genres
       FROM titles
       WHERE lower(name) LIKE lower($1)
       ORDER BY popularity DESC NULLS LAST
       LIMIT 50`,
      [likePattern]
    );

    const byId = new Map(enriched.map((it) => [it.title_id, it]));

    for (const row of lexical.rows) {
      if (!byId.has(row.id)) {
        // not in semantic candidates -> add it with a base score
        enriched.push({
          title_id: row.id,
          title: row.name,
          score: 0.5, // base score for lexical-only hits
          year: row.year,
          imdb_id: row.imdb_id,
          trakt_id: row.trakt_id,
          trakt_slug: row.trakt_slug,
          plot: row.plot,
          genres: row.genres,
          poster_url: row.poster_url,
        });
      }
    }

    // 4) Rescore / sort – boost any title whose name contains the query
    const qLower = query.toLowerCase();
    const rescored = enriched.map((it) => {
      let boost = 0;
      if (it.title && it.title.toLowerCase().includes(qLower)) {
        boost += 1.0; // make "Ice Age ..." bubble to the top
      }
      const baseScore = typeof it.score === "number" ? it.score : 0;
      return { ...it, _rank_score: baseScore + boost };
    });

    rescored.sort(
      (a, b) => (b._rank_score ?? 0) - (a._rank_score ?? 0)
    );

    // 5) Return without the internal _rank_score
    return res.json({
      ok: true,
      items: rescored.map(({ _rank_score, ...rest }) => rest),
    });
  } catch (err) {
    console.error("semantic proxy+enrich error:", err);
    return res.status(500).json({ ok: false, error: "proxy_failed" });
  }
});

// GET /api/recs/content?seed_text=...&topK=5
router.get("/content", async (req, res) => {
  try {
    const seed_text = (req.query.seed_text || req.query.seed || "")
      .toString()
      .trim();
    const topK = Number(req.query.topK || 5);

    if (!seed_text) {
      return res.status(400).json({
        ok: false,
        error: "seed_text query parameter is required",
      });
    }

    // 1) call recommender
    const r = await fetch(`${RECS_URL}/recs/content`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ seed_text, topK }),
    });
    const base = await r.json();
    if (!r.ok) return res.status(r.status).json(base);

    const items = toArray(base);

    // 2) enrich each item from DB (same style as /semantic)
    const enriched = [];
    for (const it of items) {
      const titleId = it.title_id || it.id || null;
      const titleName = (it.title || it.name || "").toString();

      let row = null;

      if (titleId) {
        const q = await pool.query(
          `SELECT id, name, year, imdb_id, trakt_id, trakt_slug, poster_url, plot, genres 
           FROM titles WHERE id = $1 LIMIT 1`,
          [titleId]
        );
        row = q.rows[0] || null;
      }

      if (!row && titleName) {
        const q = await pool.query(
          `SELECT id, name, year, imdb_id, trakt_id, trakt_slug, poster_url, plot, genres 
           FROM titles WHERE lower(name) = lower($1)
           ORDER BY popularity DESC NULLS LAST
           LIMIT 1`,
          [titleName]
        );
        row = q.rows[0] || null;
      }

      let poster_url = row?.poster_url || null;
      if (!poster_url && row?.imdb_id) {
        poster_url = await omdbPoster(row.imdb_id);
      }

      enriched.push({
        title_id: titleId || row?.id || null,
        title: titleName || row?.name || null,
        score:
          typeof it.score === "number" ? it.score : it.similarity ?? null,
        year: row?.year ?? null,
        imdb_id: row?.imdb_id ?? null,
        trakt_id: row?.trakt_id ?? null,
        trakt_slug: row?.trakt_slug ?? null,
        plot: row?.plot ?? null,
        genres: row?.genres ?? null,
        poster_url: poster_url || null,
      });
    }

    return res.json({ ok: true, items: enriched });
  } catch (err) {
    console.error("content proxy+enrich error:", err);
    return res.status(500).json({ ok: false, error: "proxy_failed" });
  }
});

// GET /api/recs/cf  (hybrid CF + semantic fallback, global)
router.get("/cf", async (req, res) => {
  try {
    const TARGET = Number(req.query.topK || 10);

    // 1) Try CF from DB (popular_titles)
    let cfItems = [];
    try {
      // ask for a bit more so we can slice later
      cfItems = await getCfRecs(TARGET * 2);
    } catch (e) {
      console.error("CF (DB) failed, will fallback to semantic:", e);
    }

    // 2) If CF is good enough, just return it
    if (cfItems && cfItems.length >= 5) {
      return res.json({
        ok: true,
        items: cfItems.slice(0, TARGET),
      });
    }

    // 3) Otherwise, build seeds (from popular_titles)
    const seeds = await pickSeeds(5);

    // 4) Semantic fallback using those seeds
    const semanticItems = await getSemanticFallbackFromSeeds(
      seeds,
      TARGET
    );

    // 5) Merge + dedupe CF + semantic
    const seen = new Set();
    const merged = [];

    for (const it of cfItems || []) {
      const id = it.title_id || it.id;
      if (!id || seen.has(id)) continue;
      seen.add(id);
      merged.push(it);
    }

    for (const it of semanticItems || []) {
      const id = it.title_id || it.id;
      if (!id || seen.has(id)) continue;
      seen.add(id);
      merged.push(it);
    }

    return res.json({
      ok: true,
      items: merged.slice(0, TARGET),
    });
  } catch (err) {
    console.error("cf (hybrid) route error:", err);
    res.status(500).json({ ok: false, error: "cf_failed" });
  }
});

// GET /api/recs/cf_user  (personalized popular recs + semantic fallback)
router.get("/cf_user", authRequired, async (req, res) => {
  try {
    const userId = req.user.id; // set by auth middleware
    const TARGET = Number(req.query.topK || 20);

    // 1) CF-style: popular but excluding wishlist
    let cfItems = [];
    try {
      const q = await pool.query(
        `
        SELECT
          t.id   AS title_id,
          t.name AS title,
          t.year,
          t.poster_url,
          p.cnt::float AS score
        FROM public.popular_titles p
        JOIN titles t
          ON t.id = p.title_id
        LEFT JOIN wishlists w
          ON w.user_id = $1
         AND w.title_id = t.id
        WHERE w.title_id IS NULL          -- not already in the user's wishlist
        ORDER BY p.cnt DESC
        LIMIT $2
        `,
        [userId, TARGET * 2]
      );
      cfItems = q.rows || [];
    } catch (e) {
      console.error("cf_user CF query failed:", e);
    }

    // 2) If CF is good enough, just return it
    if (cfItems && cfItems.length >= 5) {
      return res.json({ ok: true, items: cfItems.slice(0, TARGET) });
    }

    // 3) Otherwise, pick seeds for this user (wishlist → popular_titles)
    const seedIds = await pickSeedsForUser(userId);

    // 4) Semantic fallback using those seed IDs (via /recs/by_seed)
    const semanticItems = await getSemanticFallback(seedIds, TARGET);

    // 5) Merge + dedupe CF + semantic
    const seen = new Set();
    const merged = [];

    for (const it of cfItems || []) {
      const id = it.title_id || it.id;
      if (!id || seen.has(id)) continue;
      seen.add(id);
      merged.push(it);
    }

    for (const it of semanticItems || []) {
      const id = it.title_id || it.id;
      if (!id || seen.has(id)) continue;
      seen.add(id);
      merged.push(it);
    }

    return res.json({ ok: true, items: merged.slice(0, TARGET) });
  } catch (err) {
    console.error("cf_user route error:", err);
    return res.status(500).json({ ok: false, error: "cf_user_failed" });
  }
});

export default router;
