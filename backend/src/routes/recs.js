import express from "express";
import fetch from "node-fetch";
import pool from "../db.js";
import authRequired from "../middleware/auth.js";
import { withRecommendationReason } from "../utils/reasoning.js";

const router = express.Router();
const RECS_URL = process.env.RECS_URL || "http://recommender:8001";
const OMDB_KEY = process.env.OMDB_API_KEY || process.env.OMDB_KEY || "";
const MAX_PERSONALIZATION_SEEDS = 3;

const XGB_FEATURE_COLUMNS = [
  "semantic_score",
  "log_popularity",
  "same_year",
  "genre_overlap_seed",
  "genre_overlap_user",
  "in_user_wishlist",
  "user_user_cf",
  "user_user_supporters",
  "source_semantic",
  "source_popular",
  "source_neighbor",
  "seen_by_user",
  "novelty_score",
];

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

function toFiniteNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeSearchText(value = "") {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function titleQueryMatchScore(query = "", title = "") {
  const q = normalizeSearchText(query);
  const t = normalizeSearchText(title);
  if (!q || !t) return 0;
  if (q === t) return 1;
  if (t.startsWith(q) || q.startsWith(t)) return 0.82;
  if (t.includes(q) || q.includes(t)) return 0.68;

  const qTokens = new Set(q.split(" "));
  const tTokens = new Set(t.split(" "));
  let overlap = 0;
  for (const token of qTokens) {
    if (tTokens.has(token)) overlap += 1;
  }
  if (!overlap) return 0;
  return overlap / new Set([...qTokens, ...tTokens]).size;
}

function canonicalTitleKey(value = "") {
  return normalizeSearchText(value)
    .replace(/\b(the|a|an)\b/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function normalizeGenres(genres) {
  if (!Array.isArray(genres)) return [];
  return genres
    .map((g) => String(g || "").trim().toLowerCase())
    .filter(Boolean);
}

function genreJaccard(a, b) {
  const left = new Set(normalizeGenres(a));
  const right = new Set(normalizeGenres(b));
  if (!left.size || !right.size) return 0;

  let overlap = 0;
  for (const g of left) {
    if (right.has(g)) overlap += 1;
  }
  const union = new Set([...left, ...right]).size || 1;
  return overlap / union;
}

function noveltyFromPopularity(popularityCount) {
  return 1 / Math.log2(toFiniteNumber(popularityCount, 0) + 2);
}

function logCfScore(value) {
  return Math.log1p(Math.max(toFiniteNumber(value, 0), 0));
}

function candidateSimilarity(a, b) {
  const genreSim = genreJaccard(a?.genres, b?.genres);
  const ay = toFiniteNumber(a?.year, 0);
  const by = toFiniteNumber(b?.year, 0);
  const yearSim =
    ay > 0 && by > 0 ? Math.max(0, 1 - Math.min(Math.abs(ay - by), 5) / 5) : 0;
  return genreSim * 0.8 + yearSim * 0.2;
}

function heuristicRankScore(item) {
  return (
    toFiniteNumber(item.semantic_score, 0) * 0.9 +
    toFiniteNumber(item.user_user_cf, 0) * 0.25 +
    toFiniteNumber(item.genre_overlap_seed, 0) * 0.2 +
    toFiniteNumber(item.genre_overlap_user, 0) * 0.2 +
    toFiniteNumber(item.log_popularity, 0) * 0.08 +
    toFiniteNumber(item.novelty_score, 0) * 0.05 +
    toFiniteNumber(item.source_neighbor, 0) * 0.04 +
    toFiniteNumber(item.source_semantic, 0) * 0.03 -
    toFiniteNumber(item.seen_by_user, 0) * 0.08
  );
}

function nearDuplicatePenalty(candidate, chosen) {
  const candidateTitle = String(candidate?.title || candidate?.name || "").trim();
  if (!candidateTitle || !chosen.length) return 0;

  let penalty = 0;
  for (const picked of chosen) {
    const pickedTitle = String(picked?.title || picked?.name || "").trim();
    if (!pickedTitle) continue;

    const directMatch = titleQueryMatchScore(candidateTitle, pickedTitle);
    const canonicalMatch = titleQueryMatchScore(
      canonicalTitleKey(candidateTitle),
      canonicalTitleKey(pickedTitle)
    );
    const titleMatch = Math.max(directMatch, canonicalMatch);
    const yearGap = Math.abs(
      toFiniteNumber(candidate?.year, 0) - toFiniteNumber(picked?.year, 0)
    );

    if (titleMatch >= 0.98 && yearGap <= 1) {
      penalty = Math.max(penalty, 0.35);
    } else if (titleMatch >= 0.94) {
      penalty = Math.max(penalty, 0.22);
    } else if (titleMatch >= 0.86 && candidateSimilarity(candidate, picked) >= 0.8) {
      penalty = Math.max(penalty, 0.12);
    }
  }

  return penalty;
}

function quantile(sortedValues, percentile) {
  if (!sortedValues.length) return 0;
  const bounded = Math.max(0, Math.min(1, percentile));
  const index = Math.min(
    sortedValues.length - 1,
    Math.floor((sortedValues.length - 1) * bounded)
  );
  return sortedValues[index];
}

function computeNoveltyBands(candidates) {
  const scores = (candidates || [])
    .map((item) => toFiniteNumber(item?.novelty_score, 0))
    .sort((a, b) => a - b);

  if (!scores.length) {
    return {
      headMax: 0,
      midMax: 0,
    };
  }

  return {
    headMax: quantile(scores, 0.33),
    midMax: quantile(scores, 0.66),
  };
}

function noveltyBucket(score, bands) {
  const novelty = toFiniteNumber(score, 0);
  if (novelty <= toFiniteNumber(bands?.headMax, 0)) return "head";
  if (novelty <= toFiniteNumber(bands?.midMax, 0)) return "mid";
  return "tail";
}

function desiredNoveltyMix(target) {
  const safeTarget = Math.max(1, Math.floor(target || 1));
  let head = Math.max(1, Math.round(safeTarget * 0.4));
  let mid = safeTarget > 1 ? Math.max(1, Math.round(safeTarget * 0.35)) : 0;

  if (head + mid > safeTarget) {
    mid = Math.max(0, safeTarget - head);
  }

  let tail = Math.max(0, safeTarget - head - mid);

  if (safeTarget >= 3 && tail === 0) {
    tail = 1;
    if (head >= mid && head > 1) head -= 1;
    else if (mid > 1) mid -= 1;
  }

  return { head, mid, tail };
}

function stripRankingInternals(item) {
  const {
    _rank_score,
    semantic_score,
    log_popularity,
    same_year,
    genre_overlap_seed,
    genre_overlap_user,
    in_user_wishlist,
    user_user_cf,
    user_user_supporters,
    source_semantic,
    source_popular,
    source_neighbor,
    seen_by_user,
    novelty_score,
    popularity_count,
    supporter_count,
    xgb_score,
    ...rest
  } = item || {};
  return rest;
}

function rankCandidatesHeuristically(candidates) {
  return [...(candidates || [])]
    .map((item) => ({ ...item, _rank_score: heuristicRankScore(item) }))
    .sort((a, b) => (b._rank_score ?? 0) - (a._rank_score ?? 0));
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

async function fetchTitleRowsByIds(titleIds) {
  const uniqueIds = Array.from(
    new Set(
      (titleIds || [])
        .map((id) => Number(id))
        .filter((id) => Number.isFinite(id) && id > 0)
    )
  );
  if (!uniqueIds.length) return new Map();

  const q = await pool.query(
    `
    SELECT
      t.id,
      t.name,
      t.year,
      t.imdb_id,
      t.trakt_id,
      t.trakt_slug,
      t.poster_url,
      t.plot,
      t.genres,
      t.popularity,
      COALESCE(pt.cnt, 0)::float AS popularity_count
    FROM titles t
    LEFT JOIN popular_titles pt ON pt.title_id = t.id
    WHERE t.id = ANY($1::int[])
    `,
    [uniqueIds]
  );

  return new Map(q.rows.map((row) => [Number(row.id), row]));
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

async function getPopularCandidatesDetailed(limit = 40) {
  const q = await pool.query(
    `
    SELECT
      t.id AS title_id,
      t.name AS title,
      t.year,
      t.imdb_id,
      t.trakt_id,
      t.trakt_slug,
      t.poster_url,
      t.plot,
      t.genres,
      COALESCE(pt.cnt, 0)::float AS popularity_count
    FROM titles t
    LEFT JOIN popular_titles pt ON pt.title_id = t.id
    ORDER BY COALESCE(pt.cnt, 0) DESC, t.popularity DESC NULLS LAST, t.id ASC
    LIMIT $1
    `,
    [limit]
  );

  return (q.rows || []).map((row) => ({
    ...row,
    score: toFiniteNumber(row.popularity_count, 0),
    source_popular: 1,
  }));
}

async function getUserPreferenceProfile(userId, limit = 40) {
  const q = await pool.query(
    `
    WITH user_titles AS (
      SELECT
        title_id,
        MAX(last_ts) AS last_ts,
        SUM(signal)::float AS signal,
        BOOL_OR(in_wishlist) AS in_wishlist,
        BOOL_OR(watched) AS watched,
        MAX(rating) AS rating
      FROM (
        SELECT
          i.title_id,
          i.ts AS last_ts,
          GREATEST(COALESCE(i.weight, 0), 0)
            + CASE WHEN i.watched THEN 3 ELSE 0 END
            + CASE WHEN COALESCE(i.rating, 0) >= 4 THEN i.rating ELSE 0 END AS signal,
          FALSE AS in_wishlist,
          COALESCE(i.watched, FALSE) AS watched,
          i.rating AS rating
        FROM interactions i
        WHERE i.user_id = $1
          AND (i.watched = TRUE OR i.rating >= 4 OR i.weight >= 1)

        UNION ALL

        SELECT
          w.title_id,
          w.ts AS last_ts,
          3.0 AS signal,
          TRUE AS in_wishlist,
          FALSE AS watched,
          NULL::double precision AS rating
        FROM wishlists w
        WHERE w.user_id = $1
      ) src
      GROUP BY title_id
    )
    SELECT
      ut.title_id,
      ut.last_ts,
      ut.signal,
      ut.in_wishlist,
      ut.watched,
      ut.rating,
      t.name,
      t.year,
      t.imdb_id,
      t.trakt_id,
      t.trakt_slug,
      t.poster_url,
      t.plot,
      t.genres,
      COALESCE(pt.cnt, 0)::float AS popularity_count
    FROM user_titles ut
    JOIN titles t ON t.id = ut.title_id
    LEFT JOIN popular_titles pt ON pt.title_id = ut.title_id
    ORDER BY ut.last_ts DESC NULLS LAST, ut.signal DESC
    LIMIT $2
    `,
    [userId, limit]
  );

  const rows = q.rows || [];
  const seedRows = rows.slice(0, MAX_PERSONALIZATION_SEEDS);
  const seenSet = new Set(rows.map((row) => Number(row.title_id)).filter(Number.isFinite));
  const wishlistSet = new Set(
    rows
      .filter((row) => row.in_wishlist)
      .map((row) => Number(row.title_id))
      .filter(Number.isFinite)
  );
  const userGenres = Array.from(
    new Set(rows.flatMap((row) => normalizeGenres(row.genres)))
  );
  const behaviorSignalCount = rows.filter(
    (row) =>
      Boolean(row.watched) ||
      toFiniteNumber(row.rating, 0) >= 4 ||
      (!row.in_wishlist && toFiniteNumber(row.signal, 0) >= 1)
  ).length;

  return {
    rows,
    seedRows,
    positiveTitleIds: rows
      .map((row) => Number(row.title_id))
      .filter((id) => Number.isFinite(id) && id > 0),
    seenSet,
    wishlistSet,
    userGenres,
    behaviorSignalCount,
    wishlistOnlyProfile: behaviorSignalCount === 0 && wishlistSet.size > 0,
  };
}

async function getSemanticCandidatesForSeedRows(seedRows, target = 20) {
  const seeds = (seedRows || []).slice(0, MAX_PERSONALIZATION_SEEDS);
  if (!seeds.length) return [];

  const collected = new Map();

  for (const seed of seeds) {
    const seedTitle = String(seed?.name || seed?.title || "").trim();
    const seedId = Number(seed?.title_id || seed?.id || 0);
    if (!seedTitle) continue;

    try {
      const r = await fetch(`${RECS_URL}/recs/semantic`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: seedTitle, topK: Math.max(target * 2, 30) }),
      });
      if (!r.ok) continue;

      const base = await r.json().catch(() => ({}));
      for (const it of toArray(base)) {
        const titleId = Number(it?.title_id ?? it?.id ?? 0);
        if (!Number.isFinite(titleId) || titleId <= 0 || titleId === seedId) continue;

        const existing = collected.get(titleId) || {
          title_id: titleId,
          semantic_score: 0,
          source_semantic: 0,
        };

        existing.semantic_score = Math.max(
          existing.semantic_score,
          toFiniteNumber(it?.score ?? it?.similarity, 0)
        );
        existing.source_semantic = 1;
        existing._seed_text = existing._seed_text || seedTitle;
        collected.set(titleId, existing);
      }
    } catch (err) {
      console.error("semantic seed retrieval failed:", seedTitle, err);
    }
  }

  const metaById = await fetchTitleRowsByIds([...collected.keys()]);
  return [...collected.values()]
    .map((it) => {
      const meta = metaById.get(it.title_id);
      if (!meta) return null;
      return {
        title_id: it.title_id,
        title: meta.name,
        year: meta.year,
        imdb_id: meta.imdb_id,
        trakt_id: meta.trakt_id,
        trakt_slug: meta.trakt_slug,
        poster_url: meta.poster_url,
        plot: meta.plot,
        genres: meta.genres,
        popularity_count: toFiniteNumber(meta.popularity_count, 0),
        semantic_score: toFiniteNumber(it.semantic_score, 0),
        score: toFiniteNumber(it.semantic_score, 0),
        source_semantic: 1,
        _seed_text: it._seed_text || "",
      };
    })
    .filter(Boolean);
}

async function getUserUserCfCandidates(userId, positiveTitleIds, limit = 40) {
  const uniqueIds = Array.from(
    new Set(
      (positiveTitleIds || [])
        .map((id) => Number(id))
        .filter((id) => Number.isFinite(id) && id > 0)
    )
  );
  if (!uniqueIds.length) return [];

  const q = await pool.query(
    `
    WITH my_titles AS (
      SELECT UNNEST($2::int[]) AS title_id
    ),
    positive_signals AS (
      SELECT
        user_id,
        title_id,
        SUM(signal)::float AS strength
      FROM (
        SELECT
          i.user_id,
          i.title_id,
          GREATEST(COALESCE(i.weight, 0), 0)
            + CASE WHEN i.watched THEN 3 ELSE 0 END
            + CASE WHEN COALESCE(i.rating, 0) >= 4 THEN i.rating ELSE 0 END AS signal
        FROM interactions i
        WHERE i.title_id IS NOT NULL
          AND (i.watched = TRUE OR i.rating >= 4 OR i.weight >= 1)

        UNION ALL

        SELECT
          w.user_id,
          w.title_id,
          3.0 AS signal
        FROM wishlists w
      ) src
      GROUP BY user_id, title_id
    ),
    neighbors AS (
      SELECT
        ps.user_id,
        COUNT(*)::int AS overlap_items,
        SUM(ps.strength)::float AS overlap_strength
      FROM positive_signals ps
      JOIN my_titles mt ON mt.title_id = ps.title_id
      WHERE ps.user_id <> $1
      GROUP BY ps.user_id
      HAVING COUNT(*) >= 1
      ORDER BY overlap_strength DESC, overlap_items DESC
      LIMIT 50
    ),
    neighbor_titles AS (
      SELECT
        ps.title_id,
        SUM(n.overlap_strength * ps.strength)::float AS cf_score,
        COUNT(DISTINCT ps.user_id)::int AS supporter_count
      FROM positive_signals ps
      JOIN neighbors n ON n.user_id = ps.user_id
      LEFT JOIN my_titles mt ON mt.title_id = ps.title_id
      WHERE mt.title_id IS NULL
      GROUP BY ps.title_id
      ORDER BY cf_score DESC, supporter_count DESC
      LIMIT $3
    )
    SELECT
      t.id AS title_id,
      t.name AS title,
      t.year,
      t.imdb_id,
      t.trakt_id,
      t.trakt_slug,
      t.poster_url,
      t.plot,
      t.genres,
      COALESCE(pt.cnt, 0)::float AS popularity_count,
      nt.cf_score,
      nt.supporter_count
    FROM neighbor_titles nt
    JOIN titles t ON t.id = nt.title_id
    LEFT JOIN popular_titles pt ON pt.title_id = nt.title_id
    ORDER BY nt.cf_score DESC, nt.supporter_count DESC
    LIMIT $3
    `,
    [userId, uniqueIds, limit]
  );

  return (q.rows || []).map((row) => ({
    ...row,
    user_user_cf: toFiniteNumber(row.cf_score, 0),
    user_user_supporters: Math.log1p(toFiniteNumber(row.supporter_count, 0)),
    score: toFiniteNumber(row.cf_score, 0),
    source_neighbor: 1,
  }));
}

function buildFeatureEnrichedCandidates(candidates, profile) {
  const byId = new Map();
  const seedRows = profile?.seedRows || [];
  const userGenres = profile?.userGenres || [];
  const wishlistSet = profile?.wishlistSet || new Set();
  const seenSet = profile?.seenSet || new Set();

  for (const raw of candidates || []) {
    const titleId = Number(raw?.title_id ?? raw?.id ?? 0);
    if (!Number.isFinite(titleId) || titleId <= 0) continue;

    const existing = byId.get(titleId) || {
      title_id: titleId,
      title: null,
      year: null,
      imdb_id: null,
      trakt_id: null,
      trakt_slug: null,
      poster_url: null,
      plot: null,
      genres: [],
      popularity_count: 0,
      semantic_score: 0,
      user_user_cf: 0,
      user_user_supporters: 0,
      source_semantic: 0,
      source_popular: 0,
      source_neighbor: 0,
    };

    existing.title = existing.title || raw.title || raw.name || null;
    existing.year = existing.year ?? raw.year ?? null;
    existing.imdb_id = existing.imdb_id || raw.imdb_id || null;
    existing.trakt_id = existing.trakt_id || raw.trakt_id || null;
    existing.trakt_slug = existing.trakt_slug || raw.trakt_slug || null;
    existing.poster_url = existing.poster_url || raw.poster_url || null;
    existing.plot = existing.plot || raw.plot || null;
    existing.genres = normalizeGenres(existing.genres).length
      ? existing.genres
      : raw.genres || [];
    existing.popularity_count = Math.max(
      toFiniteNumber(existing.popularity_count, 0),
      toFiniteNumber(raw.popularity_count, 0)
    );
    existing.semantic_score = Math.max(
      toFiniteNumber(existing.semantic_score, 0),
      toFiniteNumber(raw.semantic_score, 0),
      raw.source_semantic ? toFiniteNumber(raw.score, 0) : 0
    );
    existing.user_user_cf = Math.max(
      toFiniteNumber(existing.user_user_cf, 0),
      toFiniteNumber(raw.user_user_cf, 0),
      raw.source_neighbor ? toFiniteNumber(raw.score, 0) : 0
    );
    existing.user_user_supporters = Math.max(
      toFiniteNumber(existing.user_user_supporters, 0),
      toFiniteNumber(raw.user_user_supporters, 0)
    );
    existing.source_semantic =
      (existing.source_semantic || raw.source_semantic) ? 1 : 0;
    existing.source_popular =
      (existing.source_popular || raw.source_popular) ? 1 : 0;
    existing.source_neighbor =
      (existing.source_neighbor || raw.source_neighbor) ? 1 : 0;
    if (raw._seed_text && !existing._seed_text) existing._seed_text = raw._seed_text;

    byId.set(titleId, existing);
  }

  return [...byId.values()].map((item) => {
    const genre_overlap_seed = seedRows.length
      ? Math.max(
          ...seedRows.map((seed) => genreJaccard(item.genres, seed.genres || [])),
          0
        )
      : 0;
    const same_year = seedRows.some(
      (seed) =>
        Number.isFinite(toFiniteNumber(seed?.year, NaN)) &&
        toFiniteNumber(seed?.year, 0) === toFiniteNumber(item.year, 0)
    )
      ? 1
      : 0;

    const featured = {
      ...item,
      log_popularity: Math.log1p(toFiniteNumber(item.popularity_count, 0)),
      same_year,
      genre_overlap_seed,
      genre_overlap_user: genreJaccard(item.genres, userGenres),
      in_user_wishlist: wishlistSet.has(item.title_id) ? 1 : 0,
      user_user_cf: logCfScore(item.user_user_cf),
      seen_by_user: seenSet.has(item.title_id) ? 1 : 0,
      novelty_score: noveltyFromPopularity(item.popularity_count),
    };

    featured.score = heuristicRankScore(featured);
    return featured;
  });
}

async function rerankCandidatesWithXgb(candidates) {
  const rows = (candidates || []).map((item) => {
    const out = { ...item };
    for (const feature of XGB_FEATURE_COLUMNS) {
      out[feature] = toFiniteNumber(item?.[feature], 0);
    }
    return out;
  });

  if (!rows.length) return [];

  try {
    const r = await fetch(`${RECS_URL}/rerank/xgb`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ candidates: rows, topK: rows.length }),
    });
    if (!r.ok) {
      return rows
        .map((item) => ({ ...item, _rank_score: heuristicRankScore(item) }))
        .sort((a, b) => (b._rank_score ?? 0) - (a._rank_score ?? 0));
    }

    const data = await r.json().catch(() => ({}));
    const items = toArray(data);
    if (!items.length) {
      return rows
        .map((item) => ({ ...item, _rank_score: heuristicRankScore(item) }))
        .sort((a, b) => (b._rank_score ?? 0) - (a._rank_score ?? 0));
    }

    return items
      .map((item) => ({
        ...item,
        _rank_score: Number.isFinite(Number(item.xgb_score))
          ? Number(item.xgb_score)
          : heuristicRankScore(item),
      }))
      .sort((a, b) => (b._rank_score ?? 0) - (a._rank_score ?? 0));
  } catch (err) {
    console.error("xgb rerank failed, using heuristic ranking:", err);
    return rows
      .map((item) => ({ ...item, _rank_score: heuristicRankScore(item) }))
      .sort((a, b) => (b._rank_score ?? 0) - (a._rank_score ?? 0));
  }
}

function diversifyRankedCandidates(candidates, target) {
  const pool = [...(candidates || [])];
  const chosen = [];
  const noveltyBands = computeNoveltyBands(pool);
  const noveltyMix = desiredNoveltyMix(target);
  const noveltyCounts = { head: 0, mid: 0, tail: 0 };
  const genreCounts = new Map();
  let wishlistCount = 0;

  while (pool.length && chosen.length < target) {
    let bestIndex = 0;
    let bestScore = -Infinity;
    const slot = chosen.length + 1;

    for (let i = 0; i < pool.length; i += 1) {
      const candidate = pool[i];
      const baseScore = toFiniteNumber(
        candidate?._rank_score ?? candidate?.xgb_score ?? candidate?.score,
        0
      );
      const bucket = noveltyBucket(candidate?.novelty_score, noveltyBands);
      const desiredBucketCount = toFiniteNumber(noveltyMix?.[bucket], 0);
      const expectedByNow = desiredBucketCount
        ? Math.max(1, Math.round((desiredBucketCount * slot) / Math.max(target, 1)))
        : 0;
      const noveltyMixAdjustment =
        desiredBucketCount === 0
          ? -0.03
          : noveltyCounts[bucket] < expectedByNow
          ? 0.07
          : noveltyCounts[bucket] > expectedByNow
            ? -0.05
            : 0.01;
      const maxSimilarity = chosen.length
        ? Math.max(...chosen.map((picked) => candidateSimilarity(candidate, picked)), 0)
        : 0;
      const avgSimilarity = chosen.length
        ? chosen.reduce((sum, picked) => sum + candidateSimilarity(candidate, picked), 0) /
          chosen.length
        : 0;
      const diversityPenalty = maxSimilarity * 0.16 + avgSimilarity * 0.06;
      const duplicatePenalty = nearDuplicatePenalty(candidate, chosen);
      const candidateGenres = normalizeGenres(candidate?.genres);
      const genreSaturation =
        chosen.length && candidateGenres.length
          ? candidateGenres.reduce(
              (sum, genre) => sum + toFiniteNumber(genreCounts.get(genre), 0) / chosen.length,
              0
            ) / candidateGenres.length
          : 0;
      const genrePenalty = Math.max(0, genreSaturation - 0.45) * 0.12;
      const progressiveWishlistCap = Math.max(1, Math.ceil(slot * 0.3));
      const wishlistPenalty =
        toFiniteNumber(candidate?.in_user_wishlist, 0) > 0 && wishlistCount >= progressiveWishlistCap
          ? (wishlistCount + 1 - progressiveWishlistCap) * 0.14
          : 0;
      const profileAffinityBoost =
        toFiniteNumber(candidate?.semantic_score, 0) * 0.18 +
        toFiniteNumber(candidate?.genre_overlap_seed, 0) * 0.2 +
        toFiniteNumber(candidate?.genre_overlap_user, 0) * 0.24 +
        toFiniteNumber(candidate?.source_semantic, 0) * 0.05 +
        toFiniteNumber(candidate?.source_neighbor, 0) * 0.04;
      const lowAffinityPenalty =
        profileAffinityBoost < 0.08 && toFiniteNumber(candidate?.user_user_cf, 0) <= 0.02
          ? 0.16
          : 0;
      const popularityPenalty =
        profileAffinityBoost < 0.12 ? toFiniteNumber(candidate?.log_popularity, 0) * 0.03 : 0;
      const adjusted =
        baseScore +
        profileAffinityBoost +
        noveltyMixAdjustment +
        toFiniteNumber(candidate?.novelty_score, 0) * 0.03 -
        lowAffinityPenalty -
        popularityPenalty -
        diversityPenalty -
        duplicatePenalty -
        genrePenalty -
        wishlistPenalty;

      if (adjusted > bestScore) {
        bestScore = adjusted;
        bestIndex = i;
      }
    }

    const [next] = pool.splice(bestIndex, 1);
    const nextBucket = noveltyBucket(next?.novelty_score, noveltyBands);
    noveltyCounts[nextBucket] += 1;
    if (toFiniteNumber(next?.in_user_wishlist, 0) > 0) {
      wishlistCount += 1;
    }
    for (const genre of normalizeGenres(next?.genres)) {
      genreCounts.set(genre, toFiniteNumber(genreCounts.get(genre), 0) + 1);
    }
    chosen.push({ ...next, _rank_score: bestScore, score: bestScore });
  }

  return chosen;
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

    const rescored = enriched.map((it) => {
      const matchScore = Math.max(
        it._title_matches_query ? 1 : 0,
        titleQueryMatchScore(query, it.title)
      );
      const titleMatchesQuery = matchScore >= 0.5;
      const baseScore = typeof it.score === "number" ? it.score : 0;
      const popularityBoost = Math.log1p(toFiniteNumber(it.popularity_count, 0)) * 0.02;
      return {
        ...it,
        _title_matches_query: titleMatchesQuery,
        _rank_score: baseScore + matchScore * 1.2 + popularityBoost,
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
    const profile = await getUserPreferenceProfile(userId, 50);

    let seedRows = profile.seedRows;
    if (!seedRows.length) {
      const fallbackSeedIds = await pickSeedsForUser(userId);
      const seedMeta = await fetchTitleRowsByIds(fallbackSeedIds);
      seedRows = fallbackSeedIds
        .map((id) => seedMeta.get(Number(id)))
        .filter(Boolean)
        .map((row) => ({ ...row, title_id: row.id, name: row.name }));
    }

    const candidateLimit = Math.max(target * 4, 40);
    const [popularCandidates, semanticCandidates, userUserCandidates] = await Promise.all([
      getPopularCandidatesDetailed(candidateLimit),
      getSemanticCandidatesForSeedRows(seedRows, candidateLimit),
      getUserUserCfCandidates(userId, profile.positiveTitleIds, candidateLimit),
    ]);

    let enriched = buildFeatureEnrichedCandidates(
      [...popularCandidates, ...semanticCandidates, ...userUserCandidates],
      {
        ...profile,
        seedRows,
      }
    );

    if (!enriched.length) {
      const fallback = (await getPopularCandidatesDetailed(target)).map((item) => ({
        ...item,
        _strategy: "catalog_fallback",
      }));
      return res.json({
        ok: true,
        items: withRecommendationReason(
          fallback.map((item) => stripRankingInternals(item)),
          { strategy: "catalog_fallback" }
        ),
      });
    }

    if (profile.wishlistOnlyProfile) {
      enriched = rankCandidatesHeuristically(enriched);
    } else {
      enriched = await rerankCandidatesWithXgb(enriched);
    }
    const selected = diversifyRankedCandidates(enriched, target).map((item) => ({
      ...stripRankingInternals(item),
      _strategy: "cf_user",
    }));

    return res.json({
      ok: true,
      items: withRecommendationReason(dedupeByTitleId(selected).slice(0, target), {
        strategy: "cf_user",
      }),
    });
  } catch (err) {
    console.error("cf_user route error:", err);
    return res.status(500).json({ ok: false, error: "cf_user_failed" });
  }
});

export default router;
