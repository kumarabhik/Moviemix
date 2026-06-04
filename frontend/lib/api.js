// frontend/lib/api.js

import { getToken } from "./session";

function nocacheParams() {
  return `_ts=${Date.now()}`;
}

function trimTrailingSlash(value = "") {
  return String(value || "").replace(/\/+$/, "");
}

export function apiUrl(path = "") {
  const normalizedPath = String(path || "").startsWith("/") ? String(path) : `/${path}`;
  const base = trimTrailingSlash(process.env.NEXT_PUBLIC_API_BASE || "");
  return base ? `${base}${normalizedPath}` : normalizedPath;
}

export function toArray(res) {
  if (!res) return [];
  if (Array.isArray(res)) return res;
  if (Array.isArray(res.items)) return res.items;
  if (Array.isArray(res.results)) return res.results;
  return [];
}

// ---- Auth helper ----
function authHeaders() {
  const token = getToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function parseJson(res) {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.error || `${res.status}`;
    throw new Error(msg);
  }
  return data;
}

export async function importFromTrakt() {
  const r = await fetch(apiUrl("/api/integrations/trakt/import"), {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    cache: "no-store",
  });
  return parseJson(r);
}


// ---- Recs / search ----
export async function getSimilarBySeedText(seedText, topK = 5) {
  const params = new URLSearchParams({
    seed_text: seedText,
    topK: String(topK),
  });
  const res = await fetch(apiUrl(`/api/recs/content?${params.toString()}`), {
    cache: "no-store",
  });
  if (!res.ok) throw new Error("similar fetch failed");
  return res.json();
}

export async function getSuggestions(query, limit = 8) {
  if (!query || query.trim().length < 2) return { ok: true, items: [] };
  const url = apiUrl(
    `/api/titles/suggest?q=${encodeURIComponent(query.trim())}&limit=${limit}&${nocacheParams()}`
  );
  const r = await fetch(url, { cache: "no-store" });
  return parseJson(r);
}

export async function getSemantic(query, topK = 5) {
  const url = apiUrl(`/api/recs/semantic?query=${encodeURIComponent(
    query
  )}&topK=${topK}&${nocacheParams()}`);
  const r = await fetch(url, {
    cache: "no-store",
    headers: { "Cache-Control": "no-store" },
  });
  return parseJson(r);
}

export async function getTitles() {
  const url = apiUrl(`/api/titles?${nocacheParams()}`);
  const r = await fetch(url, {
    cache: "no-store",
    headers: { "Cache-Control": "no-store" },
  });
  return parseJson(r);
}

export async function getTopPicks(topK = 12) {
  const url = apiUrl(`/api/recs/cf?topK=${topK}&${nocacheParams()}`);
  const r = await fetch(url, {
    cache: "no-store",
    headers: { "Cache-Control": "no-store" },
  });
  return parseJson(r);
}

// ---- Wishlist (requires auth) ----
export async function addToWishlist(titleId) {
  const res = await fetch(apiUrl(`/api/wishlist/${titleId}`), {
    method: "POST",
    headers: { ...authHeaders() },
  });
  return parseJson(res);
}

export async function removeFromWishlist(titleId) {
  const res = await fetch(apiUrl(`/api/wishlist/${titleId}`), {
    method: "DELETE",
    headers: { ...authHeaders() },
  });
  return parseJson(res);
}

export async function getWishlist() {
  const res = await fetch(apiUrl("/api/wishlist"), {
    method: "GET",
    headers: { ...authHeaders() },
    cache: "no-store",
  });
  return parseJson(res);
}

// ---- Titles ----
export async function getTitleById(id) {
  const res = await fetch(apiUrl(`/api/title/${id}`), { cache: "no-store" });
  return parseJson(res);
}

export async function getWatchLinks(id) {
  const url = apiUrl(`/api/title/${id}/watch-links?_ts=${Date.now()}`);

  try {
    const r = await fetch(url, { cache: "no-store" });
    if (!r.ok) return null;
    return parseJson(r);
  } catch (e) {
    return null;
  }
}

export async function getAbSummary(days = 14, scope = "all") {
  const params = new URLSearchParams({
    days: String(days),
    scope,
  });
  const res = await fetch(apiUrl(`/api/events/ab_summary?${params.toString()}`), {
    method: "GET",
    headers: { ...authHeaders() },
    cache: "no-store",
  });
  return parseJson(res);
}

export async function getReviewsByTitle(titleId) {
  const r = await fetch(apiUrl(`/api/reviews/title/${titleId}?${nocacheParams()}`), {
    cache: "no-store",
  });
  return parseJson(r);
}

export async function upsertReview(titleId, payload) {
  const r = await fetch(apiUrl(`/api/reviews/title/${titleId}`), {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(payload || {}),
  });
  return parseJson(r);
}

export async function getMyReviews() {
  const r = await fetch(apiUrl("/api/reviews/me"), {
    method: "GET",
    headers: { ...authHeaders() },
    cache: "no-store",
  });
  return parseJson(r);
}

export async function getMyProfile() {
  const r = await fetch(apiUrl("/api/profile/me"), {
    method: "GET",
    headers: { ...authHeaders() },
    cache: "no-store",
  });
  return parseJson(r);
}

