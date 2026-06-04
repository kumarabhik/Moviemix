import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { getSuggestions, toArray } from "../lib/api";

export default function SearchBar({ onSearch }) {
  const [q, setQ] = useState("");
  const [suggestions, setSuggestions] = useState([]);
  const [showDrop, setShowDrop] = useState(false);
  const [fetching, setFetching] = useState(false);
  const [cursor, setCursor] = useState(-1);
  const [dropPos, setDropPos] = useState({ top: 0, left: 0, width: 0 });
  const containerRef = useRef(null);
  const dropdownRef = useRef(null);
  const timerRef = useRef(null);
  const [mounted, setMounted] = useState(false);

  // Only run createPortal client-side (Next.js SSR safety)
  useEffect(() => setMounted(true), []);

  // Recalculate position using viewport coords (works with position: fixed)
  const updateDropPos = useCallback(() => {
    if (!containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    setDropPos({ top: rect.bottom + 6, left: rect.left, width: rect.width });
  }, []);

  useEffect(() => {
    if (showDrop) updateDropPos();
  }, [showDrop, updateDropPos]);

  useEffect(() => {
    if (!showDrop) return;
    window.addEventListener("scroll", updateDropPos, { passive: true });
    window.addEventListener("resize", updateDropPos);
    return () => {
      window.removeEventListener("scroll", updateDropPos);
      window.removeEventListener("resize", updateDropPos);
    };
  }, [showDrop, updateDropPos]);

  const fetchSugg = useCallback(async (val) => {
    if (val.trim().length < 2) { setSuggestions([]); setShowDrop(false); return; }
    setFetching(true);
    try {
      const res = await getSuggestions(val, 8);
      const items = toArray(res).slice(0, 8);
      setSuggestions(items);
      if (items.length > 0) setShowDrop(true);
    } catch {
      setSuggestions([]);
    } finally {
      setFetching(false);
    }
  }, []);

  useEffect(() => {
    clearTimeout(timerRef.current);
    if (!q.trim()) { setSuggestions([]); setShowDrop(false); return; }
    timerRef.current = setTimeout(() => fetchSugg(q), 280);
    return () => clearTimeout(timerRef.current);
  }, [q, fetchSugg]);

  // Close on outside click — must also exclude the portal dropdown itself
  useEffect(() => {
    const fn = (e) => {
      const inContainer = containerRef.current?.contains(e.target);
      const inDropdown = dropdownRef.current?.contains(e.target);
      if (!inContainer && !inDropdown) setShowDrop(false);
    };
    document.addEventListener("mousedown", fn);
    return () => document.removeEventListener("mousedown", fn);
  }, []);

  const submit = (e) => {
    e.preventDefault();
    const val = q.trim();
    if (!val) return;
    setShowDrop(false);
    onSearch(val);
  };

  const pick = (title) => {
    setQ(title);
    setShowDrop(false);
    setCursor(-1);
    onSearch(title);
  };

  const onKeyDown = (e) => {
    if (!showDrop || !suggestions.length) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setCursor((c) => Math.min(c + 1, suggestions.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setCursor((c) => Math.max(c - 1, -1));
    } else if (e.key === "Enter" && cursor >= 0) {
      e.preventDefault();
      pick(suggestions[cursor].title || suggestions[cursor].name || "");
    } else if (e.key === "Escape") {
      setShowDrop(false);
    }
  };

  // Rendered into document.body — escapes every stacking context (backdrop-blur, etc.)
  const dropdown =
    mounted && showDrop && suggestions.length > 0
      ? createPortal(
          <ul
            ref={dropdownRef}
            style={{ top: dropPos.top, left: dropPos.left, width: dropPos.width }}
            className="fixed z-[99999] rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 shadow-2xl overflow-hidden divide-y divide-slate-100 dark:divide-slate-800/60"
          >
            {suggestions.map((s, i) => {
              const title = s.title || s.name || "";
              const year = s.year ? String(s.year) : "";
              const poster = s.poster_url || null;
              const isActive = cursor === i;
              return (
                <li key={s.id ?? i}>
                  <button
                    type="button"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => pick(title)}
                    onMouseEnter={() => setCursor(i)}
                    className={
                      "w-full flex items-center gap-3 px-3 py-2.5 text-left transition-colors " +
                      (isActive
                        ? "bg-sky-50 dark:bg-sky-900/40"
                        : "hover:bg-slate-50 dark:hover:bg-slate-800/60")
                    }
                  >
                    <div className="flex-shrink-0 w-9 h-[52px] rounded-lg overflow-hidden bg-slate-100 dark:bg-slate-800">
                      {poster && (
                        <img
                          src={poster}
                          alt={title}
                          className="w-full h-full object-cover"
                          loading="lazy"
                        />
                      )}
                    </div>
                    <div className="min-w-0">
                      <p className="font-medium text-sm leading-tight truncate">{title}</p>
                      {year && (
                        <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">{year}</p>
                      )}
                    </div>
                    <span className="ml-auto flex-shrink-0 text-xs text-slate-400 dark:text-slate-600 pr-1">↵</span>
                  </button>
                </li>
              );
            })}
          </ul>,
          document.body
        )
      : null;

  return (
    <div ref={containerRef} className="relative">
      <form onSubmit={submit} className="flex gap-2">
        <div className="relative flex-1">
          <input
            className="w-full px-4 py-3 rounded-xl border border-slate-300/80 dark:border-slate-700 bg-white/80 dark:bg-slate-900/70 text-sm focus:outline-none focus:ring-2 focus:ring-sky-400/60 transition-shadow"
            placeholder="Search movies or series — e.g. Inception, sci-fi thriller…"
            value={q}
            onChange={(e) => { setQ(e.target.value); setCursor(-1); }}
            onKeyDown={onKeyDown}
            onFocus={() => suggestions.length > 0 && setShowDrop(true)}
            autoComplete="off"
            spellCheck={false}
          />
          {fetching && (
            <span className="absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none">
              <span className="block h-4 w-4 rounded-full border-2 border-sky-400 border-t-transparent animate-spin" />
            </span>
          )}
        </div>
        <button
          className="px-5 py-3 rounded-xl bg-sky-600 hover:bg-sky-500 active:bg-sky-700 text-white font-semibold text-sm disabled:opacity-40 transition-colors"
          disabled={!q.trim()}
          type="submit"
        >
          Search
        </button>
      </form>
      {dropdown}
    </div>
  );
}
