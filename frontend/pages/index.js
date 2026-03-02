import { useEffect, useState } from "react";
import SearchBar from "../components/SearchBar";
import MovieCard from "../components/MovieCard";
import { getSemantic, getTitles, getWishlist, toArray } from "../lib/api";
import { isLoggedIn } from "../lib/session";

function dedupeItems(items) {
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

function normalizeId(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : String(v);
}

function LoadingCards() {
  return (
    <div className="grid gap-3">
      {[1, 2, 3].map((i) => (
        <div
          key={i}
          className="rounded-2xl border border-white/20 bg-white/40 dark:bg-slate-900/40 p-4 h-48 animate-pulse"
        />
      ))}
    </div>
  );
}

export default function Home() {
  const [items, setItems] = useState([]);
  const [savedIds, setSavedIds] = useState(new Set());
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [headline, setHeadline] = useState("Trending now");

  async function loadSavedIds() {
    if (!isLoggedIn()) {
      setSavedIds(new Set());
      return;
    }
    try {
      const w = await getWishlist();
      const ids = new Set(
        toArray(w)
          .map((it) => normalizeId(it.title_id ?? it.id))
          .filter((v) => v !== null)
      );
      setSavedIds(ids);
    } catch {
      setSavedIds(new Set());
    }
  }

  useEffect(() => {
    loadSavedIds();

    const last = localStorage.getItem("mm:lastQuery");
    if (last) {
      setHeadline(`Results for "${last}"`);
      doSearch(last);
      return;
    }

    getTitles()
      .then((res) => {
        setItems(dedupeItems(toArray(res)));
      })
      .catch(() => setErr("Could not load starter titles"));
  }, []);

  useEffect(() => {
    const onFocus = () => loadSavedIds();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  async function doSearch(query) {
    try {
      setErr("");
      setLoading(true);
      setHeadline(`Results for "${query}"`);
      localStorage.setItem("mm:lastQuery", query);
      const res = await getSemantic(query, 12);
      setItems(dedupeItems(toArray(res)));
    } catch {
      setErr("Search failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-4">
      <section className="rounded-2xl border border-white/20 bg-white/50 dark:bg-slate-900/50 p-4 sm:p-6 backdrop-blur">
        <h1 className="text-2xl sm:text-3xl font-semibold tracking-tight">
          Discover your next movie in seconds
        </h1>
        <div className="mt-4">
          <SearchBar onSearch={doSearch} />
        </div>
      </section>

      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-lg sm:text-xl font-semibold">{headline}</h2>
          {!loading && !err && (
            <span className="text-xs text-slate-500">{items.length} items</span>
          )}
        </div>

        {loading && <LoadingCards />}
        {!loading && err && <div className="text-red-600 text-sm">{err}</div>}
        {!loading && !err && items.length === 0 && (
          <div className="rounded-xl border border-dashed border-slate-300 dark:border-slate-700 p-4 text-sm text-slate-500">
            No results yet. Try searching for a genre, actor, or franchise name.
          </div>
        )}

        {!loading && !err && items.length > 0 && (
          <div className="grid gap-3">
            {items.map((it, i) => (
              <MovieCard
                key={it.title_id ?? it.id ?? i}
                item={it}
                initialSaved={savedIds.has(normalizeId(it.title_id ?? it.id))}
                onAdded={(id) =>
                  setSavedIds((prev) => {
                    const next = new Set(prev);
                    const norm = normalizeId(id);
                    if (norm !== null) next.add(norm);
                    return next;
                  })
                }
                onRemoved={(id) =>
                  setSavedIds((prev) => {
                    const next = new Set(prev);
                    const norm = normalizeId(id);
                    if (norm !== null) next.delete(norm);
                    return next;
                  })
                }
              />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
