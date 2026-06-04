import { useEffect, useMemo, useRef, useState } from "react";
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
          className="rounded-2xl border border-white/20 bg-white/40 dark:bg-slate-900/40 p-4 h-48 mm-shimmer"
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
  const [hasSearched, setHasSearched] = useState(false);
  const heroSectionRef = useRef(null);

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
      setHasSearched(true);
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

  // Auto-rotation
  useEffect(() => {
    if (topPicks.length < 2) return undefined;
    const timer = setInterval(() => {
      setActiveSlide((prev) => (prev + 1) % topPicks.length);
    }, 4000);
    return () => clearInterval(timer);
  }, [topPicks, rotationVersion]);


  // Scroll-reveal for cards via IntersectionObserver
  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add("is-visible");
            observer.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.06, rootMargin: "0px 0px -20px 0px" }
    );
    document.querySelectorAll(".mm-reveal").forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, [items]);

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
      setHasSearched(true);
      localStorage.setItem("mm:lastQuery", query);
      const res = await getSemantic(query, 12);
      setItems(dedupeItems(toArray(res)));
    } catch {
      setErr("Search failed");
    } finally {
      setLoading(false);
    }
  }

  function clearSearch() {
    setHasSearched(false);
    setHeadline("Trending now");
    localStorage.removeItem("mm:lastQuery");
    setItems([]);
    getTitles()
      .then((res) => setItems(dedupeItems(toArray(res))))
      .catch(() => setErr("Could not load starter titles"));
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
      {/* Search hero */}
      <section className="rounded-2xl border border-sky-100/80 dark:border-slate-700 bg-white/60 dark:bg-slate-900/55 p-4 sm:p-6 backdrop-blur relative z-20">
        <h1 className="text-2xl sm:text-3xl font-semibold tracking-tight">
          Discover your next movie in seconds
        </h1>
        <div className="mt-4">
          <SearchBar onSearch={doSearch} />
        </div>
      </section>

      {/* Featured carousel — only shown on homepage (before any search) */}
      {!hasSearched && (
        <section
          ref={heroSectionRef}
          className="rounded-2xl border border-sky-100/80 dark:border-slate-700 overflow-hidden relative w-full"
        >
          {topLoading && (
            <div className="h-[420px] sm:h-[500px] mm-shimmer bg-white/30 dark:bg-slate-900/40" />
          )}

          {!topLoading && !currentSlide && (
            <div className="h-[420px] sm:h-[500px] flex items-center justify-center bg-white/45 dark:bg-slate-900/50 text-sm text-slate-600 dark:text-slate-300">
              Featured carousel needs titles with posters.
            </div>
          )}

          {!topLoading && currentSlide && (
            <div className="relative h-[420px] sm:h-[500px]">

              {/* Slide fade wrapper — pointer-events-none so buttons underneath are always clickable */}
              <div key={activeSlide} className="absolute inset-0 mm-slide-fade pointer-events-none">
                {/* Blurred background fills full width */}
                <img
                  src={slidePoster}
                  alt=""
                  aria-hidden="true"
                  className="absolute inset-0 w-full h-full object-cover"
                  style={{ filter: "blur(28px) brightness(0.28) saturate(1.4)", transform: "scale(1.08)" }}
                />
                {/* Portrait poster centred — full height, auto width, white space on sides */}
                <img
                  src={slidePoster}
                  alt={slideTitle}
                  className="absolute inset-y-0 left-1/2 -translate-x-1/2 h-full w-auto object-contain"
                  style={{ filter: "drop-shadow(0 8px 32px rgba(0,0,0,0.7))" }}
                />
              </div>

              {/* Gradient for text legibility */}
              <div className="absolute inset-0 bg-gradient-to-t from-slate-950/90 via-slate-950/10 to-transparent pointer-events-none" />

              {/* Prev / Next arrows — z-10 ensures they're above the slide layer */}
              <button
                type="button"
                aria-label="Previous slide"
                onClick={goPrevSlide}
                className="absolute left-3 top-1/2 -translate-y-1/2 z-10 h-11 w-11 rounded-xl border border-white/20 bg-black/40 text-white text-2xl hover:bg-black/60 backdrop-blur-sm transition-colors flex items-center justify-center"
              >
                ‹
              </button>
              <button
                type="button"
                aria-label="Next slide"
                onClick={goNextSlide}
                className="absolute right-3 top-1/2 -translate-y-1/2 z-10 h-11 w-11 rounded-xl border border-white/20 bg-black/40 text-white text-2xl hover:bg-black/60 backdrop-blur-sm transition-colors flex items-center justify-center"
              >
                ›
              </button>

              {/* Text content */}
              <div
                key={`text-${activeSlide}`}
                className="absolute bottom-8 left-0 right-0 px-4 sm:px-6 text-white mm-slide-text text-center z-10"
              >
                <div className="text-xs uppercase tracking-widest text-sky-300 font-semibold">
                  MovieMix featured
                </div>
                <h2 className="text-xl sm:text-2xl font-bold mt-1 leading-tight">
                  {slideTitle}{" "}
                  <span className="opacity-55 font-normal text-lg">{slideYear}</span>
                </h2>
                <p className="mt-1 text-sm text-slate-200 line-clamp-2 max-w-sm mx-auto">
                  {slideReason}
                </p>
                <div className="mt-3">
                  {slideId ? (
                    <Link
                      href={`/title/${slideId}`}
                      className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-sky-500 hover:bg-sky-400 active:bg-sky-600 text-white font-semibold text-sm transition-colors shadow-lg shadow-sky-500/25"
                    >
                      Open title →
                    </Link>
                  ) : null}
                </div>
              </div>

              {/* Dot indicators */}
              <div className="absolute bottom-3 left-0 right-0 flex justify-center gap-1.5 z-10">
                {topPicks.map((_, i) => (
                  <button
                    key={i}
                    type="button"
                    aria-label={`Go to slide ${i + 1}`}
                    onClick={() => { setActiveSlide(i); resetRotationCounter(); }}
                    className={
                      "rounded-full transition-all duration-300 " +
                      (i === activeSlide
                        ? "w-5 h-1.5 bg-white"
                        : "w-1.5 h-1.5 bg-white/35 hover:bg-white/65")
                    }
                  />
                ))}
              </div>
            </div>
          )}
        </section>
      )}

      {/* Results grid */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-lg sm:text-xl font-semibold">{headline}</h2>
          <div className="flex items-center gap-3">
            {hasSearched && (
              <button
                onClick={clearSearch}
                type="button"
                className="text-xs text-sky-600 hover:text-sky-400 dark:text-sky-400 dark:hover:text-sky-300 transition-colors"
              >
                ← Browse all
              </button>
            )}
            {!loading && !err && (
              <span className="text-xs text-slate-500">{items.length} items</span>
            )}
          </div>
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
              <div
                key={it.title_id ?? it.id ?? i}
                className="mm-reveal"
                style={{ animationDelay: `${Math.min(i * 55, 440)}ms` }}
              >
                <MovieCard
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
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
