import express from "express";
import fetch from "node-fetch";
import pool from "../db.js";
import authRequired from "../middleware/auth.js";
import { withRecommendationReason } from "../utils/reasoning.js";

const router = express.Router();
const RECS_URL = process.env.RECS_URL || "http://recommender:8001";
const OMDB_KEY = process.env.OMDB_API_KEY || process.env.OMDB_KEY || "";

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

function dedupeByTitleId(items) {
  const seen = new Set();
  const out = [];

  for (const it of items || []) {
    const imdb = String(it?.imdb_id || "").trim().toLowerCase();
    const trakt = String(it?.trakt_id || "").trim().toLowerCase();
    const title = String(it?.title || it?.name || "")
      .trim()
      .toLowerCase();
    const year = String(it?.year || "").trim();
    const id = String(it?.title_id ?? it?.id ?? "").trim();

    const keys = [];
    if (imdb) keys.push(`imdb:${imdb}`);
    if (trakt) keys.push(`trakt:${trakt}`);
    if (title && year) keys.push(`title_year:${title}:${year}`);
    if (title) keys.push(`title:${title}`);
    if (id) keys.push(`id:${id}`);
    if (keys.length === 0) continue;

    if (keys.some((k) => seen.has(k))) continue;
    keys.forEach((k) => seen.add(k));
    out.push(it);
  }

  return out;
}

function toArray(res) {
  if (!res) return [];
  if (Array.isArray(res)) return res;
  if (Array.isArray(res.items)) return res.items;
  if (Array.isArray(res.results)) return res.results;
  if (Array.isArray(res.data)) return res.data;
  return [];
}

async function fetchTitleRowByIdOrName(titleId, titleName) {
  if (titleId) {
    const byId = await pool.query(
      `SELECT id, name, year, imdb_id, trakt_id, trakt_slug, poster_url, plot, genres
       FROM titles
       WHERE id = $1
       LIMIT 1`,
      [titleId]
    );
    if (byId.rows[0]) return byId.rows[0];
  }

  if (!titleName) return null;
  const byName = await pool.query(
    `SELECT id, name, year, imdb_id, trakt_id, trakt_slug, poster_url, plot, genres
     FROM titles
     WHERE lower(name) = lower($1)
     ORDER BY popularity DESC NULLS LAST
     LIMIT 1`,
    [titleName]
  );
  return byName.rows[0] || null;
}

async function enrichCandidate(it) {
  const titleId = it?.title_id || it?.id || null;
  const titleName = (it?.title || it?.name || "").toString();
  const row = await fetchTitleRowByIdOrName(titleId, titleName);

  let posterUrl = row?.poster_url || null;
  if (!posterUrl && row?.imdb_id) {
    posterUrl = await omdbPoster(row.imdb_id);
  }

  return {
    title_id: titleId || row?.id || null,
    title: titleName || row?.name || null,
    score: typeof it?.score === "number" ? it.score : it?.similarity ?? null,
    year: row?.year ?? null,
    imdb_id: row?.imdb_id ?? null,
    trakt_id: row?.trakt_id ?? null,
    trakt_slug: row?.trakt_slug ?? null,
    plot: row?.plot ?? null,
    genres: row?.genres ?? null,
    poster_url: posterUrl || null,
  };
}

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

async function getSemanticFallbackFromSeeds(seeds, target = 10) {
  if (!seeds || seeds.length === 0) return [];

  const collected = [];
  const seen = new Set();

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
        console.error("semantic fallback HTTP error for seed:", seedTitle, r.status);
        continue;
      }

      const base = await r.json();
      const items = toArray(base);

      for (const it of items) {
        if (collected.length >= target * 2) break;

        const enriched = await enrichCandidate(it);
        const finalId = enriched.title_id;
        if (!finalId || seen.has(finalId)) continue;

        seen.add(finalId);
        collected.push({
          ...enriched,
          _strategy: "semantic_fallback_seed",
          _seed_text: seedTitle,
        });
      }
    } catch (err) {
      console.error("semantic fallback error for seed:", seedTitle, err);
    }
  }

  return collected.slice(0, target);
}

async function pickSeedsForUser(userId) {
  const { rows: wl } = await pool.query(
    "SELECT title_id FROM wishlists WHERE user_id = $1 ORDER BY ts DESC LIMIT 3",
    [userId]
  );
  if (wl.length > 0) return wl.map((r) => r.title_id);

  const { rows: popular } = await pool.query(`
    SELECT id AS title_id
    FROM titles
    ORDER BY popularity DESC NULLS LAST, id ASC
    LIMIT 10
  `);
  return popular.map((r) => r.title_id).slice(0, 3);
}

async function getSemanticFallback(seedTitleIds, target) {
  if (!seedTitleIds || seedTitleIds.length === 0) return [];

  const seedId = seedTitleIds[0];
  try {
    const q = await pool.query("SELECT name FROM titles WHERE id = $1 LIMIT 1", [
      seedId,
    ]);
    const seedTitle = (q.rows?.[0]?.name || "").toString().trim();
    if (!seedTitle) return [];

    const r = await fetch(`${RECS_URL}/recs/semantic`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: seedTitle, topK: target }),
    });
    if (!r.ok) {
      console.error("semantic fallback HTTP error:", r.status);
      return [];
    }

    const data = await r.json();
    return toArray(data);
  } catch (err) {
    console.error("semantic fallback error:", err);
    return [];
  }
}

router.get("/semantic", async (req, res) => {
  try {
    const query = (req.query.query || "").toString().trim();
    const topK = Number(req.query.topK || 5);
    if (!query) {
      return res.status(400).json({ ok: false, error: "query is required" });
    }

    const r = await fetch(`${RECS_URL}/recs/semantic`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query, topK }),
    });
    const base = await r.json();
    if (!r.ok) return res.status(r.status).json(base);

    const items = toArray(base);
    const enriched = [];
    for (const it of items) {
      const candidate = await enrichCandidate(it);
      enriched.push({ ...candidate, _strategy: "semantic" });
    }

    const lexical = await pool.query(
      `SELECT id, name, year, imdb_id, trakt_id, trakt_slug, poster_url, plot, genres
       FROM titles
       WHERE lower(name) LIKE lower($1)
       ORDER BY popularity DESC NULLS LAST
       LIMIT 50`,
      [`%${query}%`]
    );

    const byId = new Map(enriched.map((it) => [it.title_id, it]));
    for (const row of lexical.rows) {
      if (byId.has(row.id)) continue;
      enriched.push({
        title_id: row.id,
        title: row.name,
        score: 0.5,
        year: row.year,
        imdb_id: row.imdb_id,
        trakt_id: row.trakt_id,
        trakt_slug: row.trakt_slug,
        plot: row.plot,
        genres: row.genres,
        poster_url: row.poster_url,
        _strategy: "lexical",
        _title_matches_query: true,
      });
    }

    const qLower = query.toLowerCase();
    const rescored = enriched.map((it) => {
      const titleMatchesQuery =
        it._title_matches_query ||
        Boolean(it.title && it.title.toLowerCase().includes(qLower));
      const boost = titleMatchesQuery ? 1 : 0;
      const baseScore = typeof it.score === "number" ? it.score : 0;
      return {
        ...it,
        _title_matches_query: titleMatchesQuery,
        _rank_score: baseScore + boost,
      };
    });

    rescored.sort((a, b) => (b._rank_score ?? 0) - (a._rank_score ?? 0));
    const finalItems = rescored.map(({ _rank_score, ...rest }) => rest);
    const uniqueItems = dedupeByTitleId(finalItems).slice(0, topK);

    return res.json({
      ok: true,
      items: withRecommendationReason(uniqueItems, {
        query,
        strategy: "semantic",
      }),
    });
  } catch (err) {
    console.error("semantic proxy+enrich error:", err);
    return res.status(500).json({ ok: false, error: "proxy_failed" });
  }
});

router.get("/content", async (req, res) => {
  try {
    const seedText = (req.query.seed_text || req.query.seed || "").toString().trim();
    const topK = Number(req.query.topK || 5);

    if (!seedText) {
      return res.status(400).json({
        ok: false,
        error: "seed_text query parameter is required",
      });
    }

    const r = await fetch(`${RECS_URL}/recs/content`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ seed_text: seedText, topK }),
    });
    const base = await r.json();
    if (!r.ok) return res.status(r.status).json(base);

    const items = toArray(base);
    const seedNorm = seedText.toLowerCase().trim();
    const enriched = [];
    for (const it of items) {
      const candidate = await enrichCandidate(it);
      const titleNorm = String(candidate.title || "").toLowerCase().trim();
      if (titleNorm && seedNorm && titleNorm === seedNorm) continue;
      enriched.push({
        ...candidate,
        _strategy: "content",
        _seed_text: seedText,
      });
    }

    const uniqueItems = dedupeByTitleId(enriched).slice(0, topK);

    return res.json({
      ok: true,
      items: withRecommendationReason(uniqueItems, {
        strategy: "content",
        seedText,
      }),
    });
  } catch (err) {
    console.error("content proxy+enrich error:", err);
    return res.status(500).json({ ok: false, error: "proxy_failed" });
  }
});

router.get("/cf", async (req, res) => {
  try {
    const target = Number(req.query.topK || 10);
    let cfItems = [];

    try {
      cfItems = (await getCfRecs(target * 2)).map((it) => ({
        ...it,
        _strategy: "cf_global",
      }));
    } catch (e) {
      console.error("CF (DB) failed, will fallback to semantic:", e);
    }

    if (cfItems.length >= 5) {
      return res.json({
        ok: true,
        items: withRecommendationReason(cfItems.slice(0, target), {
          strategy: "cf_global",
        }),
      });
    }

    const seeds = await pickSeeds(5);
    const semanticItems = await getSemanticFallbackFromSeeds(seeds, target);
    const merged = dedupeByTitleId([...(cfItems || []), ...(semanticItems || [])]);

    return res.json({
      ok: true,
      items: withRecommendationReason(merged.slice(0, target), {
        strategy: "cf_global",
      }),
    });
  } catch (err) {
    console.error("cf (hybrid) route error:", err);
    return res.status(500).json({ ok: false, error: "cf_failed" });
  }
});

router.get("/cf_user", authRequired, async (req, res) => {
  try {
    const userId = req.user.id;
    const target = Number(req.query.topK || 20);

    const { rows: wlrows } = await pool.query(
      "SELECT title_id FROM wishlists WHERE user_id = $1 ORDER BY ts DESC LIMIT 3",
      [userId]
    );
    const wishlistIds = (wlrows || []).map((r) => r.title_id);
    const wishlistSet = new Set(wishlistIds);

    let cfItems = [];
    try {
      const q = await pool.query(
        `
        SELECT
          t.id AS title_id,
          t.name AS title,
          t.year,
          t.poster_url,
          p.cnt::float AS score
        FROM public.popular_titles p
        JOIN titles t ON t.id = p.title_id
        LEFT JOIN wishlists w
          ON w.user_id = $1
         AND w.title_id = t.id
        WHERE w.title_id IS NULL
        ORDER BY p.cnt DESC
        LIMIT $2
        `,
        [userId, target * 2]
      );
      cfItems = (q.rows || []).map((it) => ({ ...it, _strategy: "cf_user" }));
    } catch (e) {
      console.error("cf_user CF query failed:", e);
    }

    if (wishlistIds.length === 0 && cfItems.length >= 5) {
      return res.json({
        ok: true,
        items: withRecommendationReason(cfItems.slice(0, target), {
          strategy: "cf_user",
        }),
      });
    }

    const seedIds =
      wishlistIds.length > 0 ? wishlistIds : await pickSeedsForUser(userId);
    let seedTitle = "";
    if (seedIds.length > 0) {
      const q = await pool.query("SELECT name FROM titles WHERE id = $1 LIMIT 1", [
        seedIds[0],
      ]);
      seedTitle = (q.rows?.[0]?.name || "").toString();
    }

    const semanticItems = await getSemanticFallback(seedIds, target);
    const semanticFiltered = (semanticItems || [])
      .filter((it) => {
        const id = it.title_id || it.id;
        return id && !wishlistSet.has(id);
      })
      .map((it) => ({
        ...it,
        _strategy: "semantic_fallback_seed",
        _seed_text: seedTitle,
      }));

    const merged = dedupeByTitleId([...(cfItems || []), ...(semanticFiltered || [])]);

    if (merged.length < target) {
      const q = await pool.query(
        `
        SELECT
          id AS title_id,
          name AS title,
          year,
          poster_url,
          0.1::float AS score
        FROM titles
        ORDER BY popularity DESC NULLS LAST, id ASC
        LIMIT $1
        `,
        [target]
      );
      const fallback = (q.rows || []).map((it) => ({
        ...it,
        _strategy: "catalog_fallback",
      }));

      return res.json({
        ok: true,
        items: withRecommendationReason(fallback, { strategy: "catalog_fallback" }),
      });
    }

    return res.json({
      ok: true,
      items: withRecommendationReason(merged.slice(0, target), {
        strategy: "cf_user",
      }),
    });
  } catch (err) {
    console.error("cf_user route error:", err);
    return res.status(500).json({ ok: false, error: "cf_user_failed" });
  }
});

export default router;
