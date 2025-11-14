// frontend/components/MovieCard.jsx
import { useState, useEffect } from "react";
import Link from "next/link";
import { HeartIcon as HeartOutline } from "@heroicons/react/24/outline";
import { HeartIcon as HeartSolid } from "@heroicons/react/24/solid";
import { addToWishlist, removeFromWishlist } from "../lib/api";
import { isLoggedIn } from "../lib/session";

export default function MovieCard({
  item,
  initialSaved = false,
  initiallySaved,
  onRemoved,
}) {
  if (!item) return null;

  const id = item.title_id ?? item.id;
  const name =
    item.title || item.name || item.original_title || "Untitled";

  const year =
    item.year ||
    item.release_year ||
    (item.release_date && String(item.release_date).slice(0, 4));

  const plot = item.plot || item.overview || item.summary || "";

  const poster =
    item.poster_url || item.poster || item.image || null;

  const score =
    typeof item.score === "number"
      ? item.score
      : typeof item.similarity === "number"
      ? item.similarity
      : null;

  // Prefer `initiallySaved` if explicitly passed, else `initialSaved`
  const baseInitial =
    typeof initiallySaved === "boolean" ? initiallySaved : initialSaved;

  // derive initial "saved" state from props + item flags
  const derivedInitialSaved =
    baseInitial ||
    !!item.in_wishlist ||
    !!item.inWishlist ||
    !!item.saved;

  const [saved, setSaved] = useState(derivedInitialSaved);
  const [loading, setLoading] = useState(false);
  const [bump, setBump] = useState(false);

  // optional: fire-and-forget interaction logging
  function logEvent(event, title_id, meta) {
    try {
      const token =
        (typeof window !== "undefined" &&
          localStorage.getItem("moviemix_token")) ||
        "";

      fetch("/api/interactions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ event, title_id, meta }),
      }).catch(() => {});
    } catch {
      // ignore logging errors
    }
  }

  // bump animation when saved flips to true
  useEffect(() => {
    if (!saved) return;
    setBump(true);
    const t = setTimeout(() => setBump(false), 180);
    return () => clearTimeout(t);
  }, [saved]);

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
      </div>

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
