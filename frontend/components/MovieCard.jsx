// frontend/components/MovieCard.jsx
import { useState, useEffect } from "react";
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

import { addToWishlist, removeFromWishlist } from "../lib/api";
import { isLoggedIn, getToken } from "../lib/session";

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

  // Interaction signals
  const [watched, setWatched] = useState(false);
  const [rating, setRating] = useState("");

  function logEvent(event, title_id, meta) {
    try {
      const token = getToken?.() || "";

      fetch("/api/interactions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          event,
          title_id,
          meta: { ...(meta || {}), ab_variant: abVariant },
        }),
      }).catch(() => {});
    } catch {
      // ignore logging errors
    }
  }

  // Toggle watched on/off + persist
  const markWatched = async () => {
    if (!id || loading) return;

    if (!isLoggedIn()) {
      window.location.href = "/login";
      return;
    }

    try {
      setLoading(true);
      const next = !watched;
      setWatched(next);
      logEvent(next ? "watched" : "unwatch", id);
    } catch (e) {
      console.error("mark watched error:", e);
      alert("Failed to update watched.");
    } finally {
      setLoading(false);
    }
  };

  // bump animation when saved flips to true
  useEffect(() => {
    if (!saved) return;
    setBump(true);
    const t = setTimeout(() => setBump(false), 180);
    return () => clearTimeout(t);
  }, [saved]);

  // Load persisted watched/rating on mount (and when id changes)
  useEffect(() => {
    if (!id) return;
    if (!isLoggedIn()) return;

    const token = getToken?.() || "";
    fetch(`/api/interactions/me?ids=${encodeURIComponent(String(id))}`, {
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
    if(!id) return;
    logEvent("view", id, { test:true});
  }, [id]);

  const toggleWishlist = async () => {
    if (!id || loading) return;

    if (!isLoggedIn()) {
      window.location.href = "/login";
      return;
    }

    try {
      setLoading(true);
      if (!saved) {
        await addToWishlist(id);
        setSaved(true);
        logEvent("wishlist_add", id);
        if (onAdded) onAdded(id);
      } else {
        await removeFromWishlist(id);
        setSaved(false);
        logEvent("wishlist_remove", id);
        if (onRemoved) onRemoved(id);
      }
    } catch (e) {
      console.error("wishlist toggle error:", e);
      alert("Failed to update wishlist.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="rounded-lg border dark:border-gray-800 p-3 flex gap-3 relative">
      {/* Poster */}
      {poster ? (
        <img
          src={poster}
          alt={name}
          onError={(e) => {
            e.target.src = "/placeholder.jpg";
          }}
          className="w-32 h-48 sm:w-36 sm:h-56 object-cover rounded-md shadow-sm flex-shrink-0"
        />
      ) : (
        <div className="w-32 h-48 sm:w-36 sm:h-56 bg-gray-200 dark:bg-gray-800 rounded-md flex items-center justify-center text-gray-500 text-xs">
          No image
        </div>
      )}

      {/* Text */}
      <div className="min-w-0 flex-1 pr-12">
        <h2 className="font-semibold text-lg truncate">
          {id ? (
            <Link href={`/title/${id}`} className="hover:underline">
              {name}
            </Link>
          ) : (
            name
          )}{" "}
          {year && (
            <span className="font-normal text-gray-500 opacity-80">
              ({year})
            </span>
          )}
        </h2>

        {score != null && (
          <div className="text-xs text-gray-500 mt-1">
            Score: {score.toFixed(2)}
          </div>
        )}

        {plot && (
          <p className="text-sm mt-2 text-gray-700 dark:text-gray-300 line-clamp-4">
            {plot}
          </p>
        )}

        {/* Actions (signals) */}
        {id && (
          <div className="mt-3 flex flex-wrap gap-2 items-center">
            <button
              onClick={markWatched}
              disabled={loading}
              className={
                "px-3 py-1 rounded-md text-sm border font-medium transition flex items-center gap-2 " +
                (watched
                  ? "bg-green-600 text-white border-green-600"
                  : "bg-white text-black dark:bg-gray-900 dark:text-black border-gray-300 dark:border-gray-700")
              }
              type="button"
            >
              <CheckCircleIcon
                className={"h-5 w-5 " + (watched ? "text-white" : "text-black")}
              />
              {watched ? "Watched" : "Mark Watched"}
            </button>
          </div>
        )}
      </div>

      {/* Stars bottom-right */}
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
                <Filled className="h-5 w-5 text-yellow-400 hover:scale-110 transition-transform" />
              </button>
            );
          })}
        </div>
      )}

      {/* Heart button */}
      {id && (
        <button
          onClick={toggleWishlist}
          disabled={loading}
          className={
            "absolute right-3 top-3 p-1 rounded-full transition-transform duration-150 hover:scale-110 disabled:opacity-50 " +
            (bump ? " scale-125" : "")
          }
          aria-label={saved ? "Remove from wishlist" : "Add to wishlist"}
          type="button"
        >
          {saved ? (
            <HeartSolid className="h-7 w-7 text-red-500 drop-shadow-sm" />
          ) : (
            <HeartOutline className="h-7 w-7 text-gray-400 hover:text-red-500" />
          )}
        </button>
      )}
    </div>
  );
}
