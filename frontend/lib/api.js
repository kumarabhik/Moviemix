// frontend/lib/api.js

import { getToken } from "./session";

function nocacheParams() {
  return `_ts=${Date.now()}`;
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

// ---- Recs / search ----
export async function getSimilarBySeedText(seedText, topK = 5) {
  const params = new URLSearchParams({
    seed_text: seedText,
    topK: String(topK),
  });
  const res = await fetch(`/api/recs/content?${params.toString()}`, {
    cache: "no-store",
  });
  if (!res.ok) throw new Error("similar fetch failed");
  return res.json();
}

export async function getSemantic(query, topK = 5) {
  const url = `/api/recs/semantic?query=${encodeURIComponent(
    query
  )}&topK=${topK}&${nocacheParams()}`;
  const r = await fetch(url, {
    cache: "no-store",
    headers: { "Cache-Control": "no-store" },
  });
  if (!r.ok) throw new Error(`semantic failed: ${r.status}`);
  return r.json();
}

export async function getTitles() {
  const url = `/api/titles?${nocacheParams()}`;
  const r = await fetch(url, {
    cache: "no-store",
    headers: { "Cache-Control": "no-store" },
  });
  if (!r.ok) throw new Error(`titles failed: ${r.status}`);
  return r.json();
}

// ---- Wishlist (requires auth) ----
export async function addToWishlist(titleId) {
  const res = await fetch(`/api/wishlist/${titleId}`, {
    method: "POST",
    headers: { ...authHeaders() },
  });
  if (!res.ok) {
    if (res.status === 401) throw new Error("unauthorized");
    throw new Error("wishlist add failed");
  }
  return res.json();
}

export async function removeFromWishlist(titleId) {
  const res = await fetch(`/api/wishlist/${titleId}`, {
    method: "DELETE",
    headers: { ...authHeaders() },
  });
  if (!res.ok) {
    if (res.status === 401) throw new Error("unauthorized");
    throw new Error("wishlist remove failed");
  }
  return res.json();
}

export async function getWishlist() {
  const token = getToken();
  const headers = token ? { Authorization: `Bearer ${token}` } : {};

  const res = await fetch(`/api/wishlist`, {
    method: "GET",
    headers,
    cache: "no-store",
  });

  if (!res.ok) throw new Error("wishlist fetch failed");
  return res.json();
}

// ---- Titles ----
export async function getTitleById(id) {
  const res = await fetch(`/api/title/${id}`, { cache: "no-store" });
  if (!res.ok) throw new Error("title fetch failed");
  return res.json();
}
