import { useEffect, useState } from "react";
import Link from "next/link";

import MovieCard from "../components/MovieCard";
import { getWishlist, toArray } from "../lib/api";
import {
  abVariantFromUserId,
  getToken,
  getUserIdFromToken,
  isAbEnabled,
  isLoggedIn,
} from "../lib/session";

export default function ForYou() {
  const [items, setItems] = useState([]);
  const [buffer, setBuffer] = useState([]);
  const [savedIds, setSavedIds] = useState(new Set());
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(true);
  const [ab, setAb] = useState("A");

  const handleWishlisted = (titleId) => {
    setItems((prev) => prev.filter((x) => x.title_id !== titleId));
    setSavedIds((prev) => {
      const next = new Set(prev);
      next.add(titleId);
      return next;
    });
    setBuffer((prevBuf) => {
      if (!prevBuf?.length) return prevBuf;
      const [next, ...rest] = prevBuf;
      setItems((prevItems) => {
        const ids = new Set(prevItems.map((x) => x.title_id));
        if (ids.has(next.title_id)) return prevItems;
        return [...prevItems, next];
      });
      return rest;
    });
  };

  useEffect(() => {
    (async () => {
      try {
        setErr("");
        setLoading(true);

        let wishlistIdSet = new Set();
        if (isLoggedIn()) {
          try {
            const w = await getWishlist();
            wishlistIdSet = new Set(
              toArray(w)
                .map((it) => it.title_id ?? it.id)
                .filter((v) => v != null)
            );
            setSavedIds(wishlistIdSet);
          } catch {
            setSavedIds(new Set());
          }
        }

        const token = getToken();
        const enabled = isAbEnabled();
        const uid = token ? getUserIdFromToken(token) : "";
        const splitKey = uid || token || "anon";
        const variant = enabled ? abVariantFromUserId(splitKey) : "A";
        setAb(variant);

        const endpoint =
          !enabled || variant === "A" ? "/api/recs/cf_user" : "/api/recs/cf";

        let json = { items: [] };
        if (endpoint === "/api/recs/cf_user" && token) {
          const resp = await fetch(endpoint, {
            cache: "no-store",
            headers: { Authorization: `Bearer ${token}` },
          });
          json = await resp.json().catch(() => ({}));
          if (!resp.ok) throw new Error(json?.error || "cf_user_failed");
        } else {
          const resp = await fetch("/api/recs/cf", { cache: "no-store" });
          json = await resp.json().catch(() => ({}));
          if (!resp.ok) throw new Error(json?.error || "cf_failed");
        }

        const all = Array.isArray(json.items) ? json.items : [];
        const filtered = all.filter((x) => !wishlistIdSet.has(x.title_id));
        setItems(filtered.slice(0, 20));
        setBuffer(filtered.slice(20, 60));
      } catch (e) {
        setErr(String(e.message || e));
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  return (
    <div className="space-y-4">
      <header className="rounded-2xl border border-white/20 bg-white/50 dark:bg-slate-900/50 p-4 backdrop-blur">
        <div className="flex items-center justify-between gap-3">
          <h1 className="text-xl sm:text-2xl font-semibold">For You</h1>
          <span className="text-xs rounded-full px-2 py-1 bg-amber-500/20 text-amber-700 dark:text-amber-300">
            Experiment Variant {ab}
          </span>
        </div>
        <p className="text-sm mt-2 text-slate-600 dark:text-slate-300">
          Personal feed optimized by collaborative signals and semantic fallback.
          <Link href="/experiment" className="ml-2 underline">
            View experiment metrics
          </Link>
        </p>
      </header>

      {loading && (
        <div className="grid gap-3">
          {[1, 2, 3].map((i) => (
            <div
              key={i}
              className="rounded-2xl border border-white/20 bg-white/40 dark:bg-slate-900/40 p-4 h-48 animate-pulse"
            />
          ))}
        </div>
      )}
      {err && <div className="text-red-600 text-sm">{err}</div>}
      {!loading && !err && items.length === 0 && (
        <div className="text-sm text-slate-500">
          No recommendations yet. Add a few titles to your wishlist to improve
          personalization.
        </div>
      )}

      <div className="space-y-3">
        {items.map((it, i) => (
          <MovieCard
            key={`${it.title_id}-${i}`}
            item={{
              id: it.title_id,
              title: it.title,
              year: it.year,
              plot: it.plot,
              poster_url: it.poster_url,
              score: it.score,
              reason: it.reason,
              reason_code: it.reason_code,
            }}
            abVariant={ab}
            initialSaved={savedIds.has(it.title_id)}
            onAdded={() => handleWishlisted(it.title_id)}
          />
        ))}
      </div>
    </div>
  );
}

