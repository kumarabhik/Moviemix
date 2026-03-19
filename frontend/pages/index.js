import { useEffect, useMemo, useState } from "react";
import Link from "next/link";

import SearchBar from "../components/SearchBar";
import MovieCard from "../components/MovieCard";
import { getSemantic, getTitles, getTopPicks, getWishlist, toArray } from "../lib/api";
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
  const [topPicks, setTopPicks] = useState([]);
  const [activeSlide, setActiveSlide] = useState(0);
  const [rotationVersion, setRotationVersion] = useState(0);
  const [savedIds, setSavedIds] = useState(new Set());
  const [loading, setLoading] = useState(false);
  const [topLoading, setTopLoading] = useState(true);
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

  async function loadTopCarousel() {
    try {
      setTopLoading(true);
      const res = await getTopPicks(20);
      const picks = dedupeItems(toArray(res)).filter(
        (it) => String(it?.poster_url || "").trim().length > 0
      );
      setTopPicks(picks);
      setActiveSlide(0);
      setRotationVersion((v) => v + 1);
    } catch {
      setTopPicks([]);
    } finally {
      setTopLoading(false);
    }
  }

  useEffect(() => {
    loadSavedIds();
    loadTopCarousel();

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

  useEffect(() => {
    if (topPicks.length < 2) return undefined;
    const timer = setInterval(() => {
      setActiveSlide((prev) => (prev + 1) % topPicks.length);
    }, 4000);
    return () => clearInterval(timer);
  }, [topPicks, rotationVersion]);

  function resetRotationCounter() {
    setRotationVersion((v) => v + 1);
  }

  function goPrevSlide() {
    if (!topPicks.length) return;
    setActiveSlide((prev) => (prev - 1 + topPicks.length) % topPicks.length);
    resetRotationCounter();
  }

  function goNextSlide() {
    if (!topPicks.length) return;
    setActiveSlide((prev) => (prev + 1) % topPicks.length);
    resetRotationCounter();
  }

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

  const currentSlide = useMemo(() => {
    if (!topPicks.length) return null;
    return topPicks[activeSlide] || topPicks[0];
  }, [topPicks, activeSlide]);

  const slideId = currentSlide?.title_id ?? currentSlide?.id;
  const slideTitle = currentSlide?.title || currentSlide?.name || "Top pick";
  const slideYear = currentSlide?.year ? `(${currentSlide.year})` : "";
  const slidePoster = currentSlide?.poster_url || "/placeholder.jpg";
  const slideReason = currentSlide?.reason || "Trending for MovieMix users";

  return (
    <div className="space-y-5">
      <section className="rounded-2xl border border-sky-100/80 dark:border-slate-700 bg-white/60 dark:bg-slate-900/55 p-4 sm:p-6 backdrop-blur">
        <h1 className="text-2xl sm:text-3xl font-semibold tracking-tight">
          Discover your next movie in seconds
        </h1>
        <div className="mt-4">
          <SearchBar onSearch={doSearch} />
        </div>
      </section>

      <section className="rounded-2xl border border-sky-100/80 dark:border-slate-700 overflow-hidden relative">
        {topLoading && (
          <div className="h-[320px] sm:h-[420px] bg-white/30 dark:bg-slate-900/40 animate-pulse" />
        )}

        {!topLoading && !currentSlide && (
          <div className="h-[320px] sm:h-[420px] flex items-center justify-center bg-white/45 dark:bg-slate-900/50 text-sm text-slate-600 dark:text-slate-300">
            Featured carousel needs titles with posters.
          </div>
        )}

        {!topLoading && currentSlide && (
          <div className="relative h-[320px] sm:h-[420px]">
            <img
              src={slidePoster}
              alt={slideTitle}
              className="absolute inset-0 w-full h-full object-cover"
            />
            <div className="absolute inset-0 bg-gradient-to-t from-slate-950/85 via-slate-900/55 to-slate-900/15" />

            <button
              type="button"
              aria-label="Previous slide"
              onClick={goPrevSlide}
              className="absolute left-3 top-1/2 -translate-y-1/2 h-11 w-11 rounded-xl border border-sky-200/60 bg-sky-950/35 text-sky-100 text-2xl hover:bg-sky-900/55"
            >
              {"<"}
            </button>

            <button
              type="button"
              aria-label="Next slide"
              onClick={goNextSlide}
              className="absolute right-3 top-1/2 -translate-y-1/2 h-11 w-11 rounded-xl border border-sky-200/60 bg-sky-950/35 text-sky-100 text-2xl hover:bg-sky-900/55"
            >
              {">"}
            </button>

            <div className="absolute bottom-0 left-0 right-0 p-4 sm:p-6 text-white">
              <div className="text-xs uppercase tracking-wide text-sky-300">MovieMix featured</div>
              <h2 className="text-2xl sm:text-4xl font-semibold mt-1">
                {slideTitle} {slideYear}
              </h2>
              <p className="mt-2 text-sm sm:text-base text-slate-200">{slideReason}</p>
              <div className="mt-4 flex items-center gap-3">
                {slideId ? (
                  <Link
                    href={`/title/${slideId}`}
                    className="px-4 py-2 rounded-xl bg-sky-500 text-white font-medium hover:bg-sky-400"
                  >
                    Open title
                  </Link>
                ) : null}
              </div>
            </div>
          </div>
        )}
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
