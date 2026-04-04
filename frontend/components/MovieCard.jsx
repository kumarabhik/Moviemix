import { useEffect, useState } from "react";
import Link from "next/link";

import {
  HeartIcon as HeartOutline,
  CheckCircleIcon,
  StarIcon,
} from "@heroicons/react/24/outline";
import {
  HeartIcon as HeartSolid,
  StarIcon as StarSolid,
} from "@heroicons/react/24/solid";

import { addToWishlist, apiUrl, removeFromWishlist } from "../lib/api";
import { getToken, isLoggedIn } from "../lib/session";

export default function MovieCard({
  item,
  initialSaved = false,
  initiallySaved,
  onAdded,
  onRemoved,
  abVariant = "A",
}) {
  if (!item) return null;

  const id = item.title_id ?? item.id;
  const name = item.title || item.name || item.original_title || "Untitled";
  const year =
    item.year ||
    item.release_year ||
    (item.release_date && String(item.release_date).slice(0, 4));
  const plot = item.plot || item.overview || item.summary || "";
  const poster = item.poster_url || item.poster || item.image || null;
  const score =
    typeof item.score === "number"
      ? item.score
      : typeof item.similarity === "number"
      ? item.similarity
      : null;

  const baseInitial =
    typeof initiallySaved === "boolean" ? initiallySaved : initialSaved;
  const derivedInitialSaved =
    baseInitial || !!item.in_wishlist || !!item.inWishlist || !!item.saved;

  const [saved, setSaved] = useState(derivedInitialSaved);
  const [loading, setLoading] = useState(false);
  const [bump, setBump] = useState(false);
  const [watched, setWatched] = useState(false);
  const [rating, setRating] = useState("");
  const [statusMsg, setStatusMsg] = useState("");

  // Keep local saved state in sync when parent/route data changes.
  useEffect(() => {
    setSaved(derivedInitialSaved);
  }, [id, derivedInitialSaved]);

  function logEvent(event, titleId, meta) {
    const token = getToken?.() || "";
    fetch(apiUrl("/api/interactions"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({
        event,
        title_id: titleId,
        meta: { ...(meta || {}), ab_variant: abVariant },
      }),
    }).catch(() => {});
  }

  const requireLogin = () => {
    if (isLoggedIn()) return true;
    window.location.href = "/login";
    return false;
  };

  const markWatched = async () => {
    if (!id || loading) return;
    if (!requireLogin()) return;

    try {
      setLoading(true);
      const next = !watched;
      setWatched(next);
      logEvent(next ? "watched" : "unwatch", id);
      setStatusMsg(next ? "Marked as watched" : "Removed watched status");
    } catch (e) {
      console.error("mark watched error:", e);
      setStatusMsg("Could not update watched status");
    } finally {
      setLoading(false);
    }
  };

  const toggleWishlist = async () => {
    if (!id || loading) return;
    if (!requireLogin()) return;

    try {
      setLoading(true);
      if (!saved) {
        await addToWishlist(id);
        setSaved(true);
        logEvent("wishlist_add", id);
        onAdded?.(id);
        // setStatusMsg("Added to wishlist");
      } else {
        await removeFromWishlist(id);
        setSaved(false);
        logEvent("wishlist_remove", id);
        onRemoved?.(id);
        // setStatusMsg("Removed from wishlist");
      }
    } catch (e) {
      console.error("wishlist toggle error:", e);
      setStatusMsg("Could not update wishlist");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!saved) return;
    setBump(true);
    const timer = setTimeout(() => setBump(false), 180);
    return () => clearTimeout(timer);
  }, [saved]);

  useEffect(() => {
    if (!id || !isLoggedIn()) return;
    const token = getToken?.() || "";
    fetch(apiUrl(`/api/interactions/me?ids=${encodeURIComponent(String(id))}`), {
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      cache: "no-store",
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        const row = data?.items?.[0];
        if (!row) return;
        if (row.watched === true) setWatched(true);
        if (row.watched === false) setWatched(false);
        if (row.rating != null) setRating(String(row.rating));
      })
      .catch(() => {});
  }, [id]);

  useEffect(() => {
    if (!id) return;
    logEvent("view", id, { surface: "movie_card" });
  }, [id]);

  return (
    <article className="mm-card group relative overflow-hidden rounded-2xl border border-white/20 p-3 sm:p-4 flex gap-3 sm:gap-4">
      {poster ? (
        <img
          src={poster}
          alt={name}
          onError={(e) => {
            e.target.src = "/placeholder.jpg";
          }}
          className="w-28 h-40 sm:w-36 sm:h-56 object-cover rounded-xl shadow-md flex-shrink-0"
        />
      ) : (
        <div className="w-28 h-40 sm:w-36 sm:h-56 rounded-xl bg-slate-200/70 dark:bg-slate-800/70 flex items-center justify-center text-xs opacity-70">
          No image
        </div>
      )}

      <div className="min-w-0 flex-1 pr-10">
        <h2 className="font-semibold text-lg leading-tight truncate">
          {id ? (
            <Link href={`/title/${id}`} className="hover:underline">
              {name}
            </Link>
          ) : (
            name
          )}{" "}
          {year && <span className="opacity-60 font-normal">({year})</span>}
        </h2>

        <div className="mt-2 flex flex-wrap gap-2 text-xs">
          {score != null && (
            <span className="rounded-full bg-sky-500/15 text-sky-700 dark:text-sky-300 px-2 py-1">
              Score {score.toFixed(2)}
            </span>
          )}
          {item.reason && (
            <span className="rounded-full bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 px-2 py-1">
              {item.reason}
            </span>
          )}
        </div>

        {plot && (
          <p className="text-sm mt-3 text-slate-700 dark:text-slate-300 line-clamp-4">
            {plot}
          </p>
        )}

        <div className="mt-3 flex flex-wrap gap-2 items-center">
          <button
            onClick={markWatched}
            disabled={loading}
            className={
              "px-3 py-1.5 rounded-lg text-sm border font-medium transition flex items-center gap-2 " +
              (watched
                ? "bg-emerald-600 text-white border-emerald-600"
                : "bg-white/70 dark:bg-slate-900/70 border-slate-300 dark:border-slate-700")
            }
            type="button"
          >
            <CheckCircleIcon className="h-5 w-5" />
            {watched ? "Watched" : "Mark watched"}
          </button>
          {statusMsg && (
            <span className="text-xs text-slate-600 dark:text-slate-400">{statusMsg}</span>
          )}
        </div>
      </div>

      {id && (
        <div className="absolute right-3 bottom-3 flex items-center gap-1">
          {[1, 2, 3, 4, 5].map((n) => {
            const Filled = Number(rating) >= n ? StarSolid : StarIcon;
            return (
              <button
                key={n}
                onClick={() => {
                  setRating(String(n));
                  logEvent("rate", id, { rating: n });
                }}
                className="p-0.5"
                title={`Rate ${n}`}
                disabled={loading}
                type="button"
              >
                <Filled className="h-5 w-5 text-amber-400 hover:scale-110 transition-transform" />
              </button>
            );
          })}
        </div>
      )}

      {id && (
        <button
          onClick={toggleWishlist}
          disabled={loading}
          className={
            "absolute right-3 top-3 p-1.5 rounded-full bg-white/70 dark:bg-slate-900/70 transition-transform duration-150 hover:scale-110 disabled:opacity-50 " +
            (bump ? "scale-125" : "")
          }
          aria-label={saved ? "Remove from wishlist" : "Add to wishlist"}
          type="button"
        >
          {saved ? (
            <HeartSolid className="h-7 w-7 text-rose-500 drop-shadow-sm" />
          ) : (
            <HeartOutline className="h-7 w-7 text-slate-400 hover:text-rose-500" />
          )}
        </button>
      )}
    </article>
  );
}
