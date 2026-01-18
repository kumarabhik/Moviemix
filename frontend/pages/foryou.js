// frontend/pages/foryou.js
import { useEffect, useState } from "react";
import MovieCard from "../components/MovieCard";
import { getWishlist, toArray } from "../lib/api";
// import { isLoggedIn } from "../lib/session";
import {
  isLoggedIn,
  getToken,
  getUserIdFromToken,
  abVariantFromUserId,
  isAbEnabled,
} from "../lib/session";

export default function ForYou() {
  const [items, setItems] = useState([]);
  const [buffer, setBuffer] = useState([]);
  const [savedIds, setSavedIds] = useState(new Set());
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(true);
  const [ab, setAb] = useState("A");
  const [uidDbg, setUidDbg] = useState("");

  // Remove from visible list + pull next from buffer
  const handleWishlisted = (titleId) => {
    // 1) remove from visible list
    setItems((prev) => prev.filter((x) => x.title_id !== titleId));

    // 2) mark as saved in UI set
    setSavedIds((prev) => {
      const next = new Set(prev);
      next.add(titleId);
      return next;
    });

    // 3) refill from buffer
    setBuffer((prevBuf) => {
      if (!prevBuf || prevBuf.length === 0) return prevBuf;

      const [next, ...rest] = prevBuf;

      setItems((prevItems) => {
        const ids = new Set(prevItems.map((x) => x.title_id));
        if (ids.has(next.title_id)) return prevItems; // safety
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

        // IMPORTANT: keep a local Set for filtering (React state updates are async)
        let wishlistIdSet = new Set();

        // 1) If logged in, load wishlist and build a Set of saved ids
        if (isLoggedIn()) {
          try {
            const w = await getWishlist();
            const wItems = toArray(w);

            wishlistIdSet = new Set(
              wItems
                .map((it) => it.title_id ?? it.id)
                .filter((v) => v != null)
            );

            setSavedIds(wishlistIdSet);
          } catch (e) {
            console.warn("wishlist load failed on ForYou:", e);
            wishlistIdSet = new Set();
            setSavedIds(new Set());
          }
        } else {
          wishlistIdSet = new Set();
          setSavedIds(new Set());
        }

        let res;
        let json;
        let usedPersonalized = false;

        // 2) Try personalized recs if we have a token
        let token = null;
        if (typeof window !== "undefined") {
          token =
            window.localStorage.getItem("moviemix_token") ||
            window.localStorage.getItem("token");
        }

        // ---- A/B decision (SAFE: flag-controlled) ----
        const enabled = isAbEnabled();

        // Try decode userId from JWT; if it fails, fallback to token string (still stable per user)
        const uid = token ? getUserIdFromToken(token) : "";
        const splitKey = uid || token || "";

        setUidDbg(uid || "");

        const variant = enabled ? abVariantFromUserId(splitKey) : "A";
        setAb(variant);

        console.log(
          "AB enabled:",
          enabled,
          "uid:",
          uid,
          "splitKeyLen:",
          splitKey.length,
          "variant:",
          variant
        );

        // Choose endpoint
        const endpoint =
          !enabled
            ? "/api/recs/cf_user"
            : variant === "A"
            ? "/api/recs/cf_user"
            : "/api/recs/cf";

        // Call personalized endpoint only if needed
        if (token && endpoint === "/api/recs/cf_user") {
          res = await fetch(endpoint, {
            cache: "no-store",
            headers: { Authorization: `Bearer ${token}` },
          });
          json = await res.json();

          if (res.ok && Array.isArray(json.items) && json.items.length > 0) {
            const all = json.items || [];
            const filtered = all.filter((x) => !wishlistIdSet.has(x.title_id));

            // Show 20, keep buffer of next 40
            const display = filtered.slice(0, 20);
            const buff = filtered.slice(20, 60);

            setItems(display);
            setBuffer(buff);
            usedPersonalized = true;
          }
        }

        // 3) Fallback OR B-variant path: global popular CF
        if (!usedPersonalized) {
          res = await fetch("/api/recs/cf", { cache: "no-store" });
          json = await res.json();
          if (!res.ok) {
            throw new Error(json?.error || "cf_failed");
          }

          const all = json.items || [];
          const filtered = all.filter((x) => !wishlistIdSet.has(x.title_id));

          const display = filtered.slice(0, 20);
          const buff = filtered.slice(20, 60);

          setItems(display);
          setBuffer(buff);
        }
      } catch (e) {
        console.error(e);
        setErr(String(e.message || e));
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  return (
    <div className="space-y-3">
      <h1 className="text-xl font-semibold">For You</h1>
      <p className="text-xs text-gray-500">AB Variant: {ab}</p>
      <p className="text-xs text-gray-400">
        uid: {uidDbg ? uidDbg : "(missing)"}
      </p>

      {loading && <div>Loading…</div>}
      {err && <div className="text-red-600 text-sm">{err}</div>}

      {!loading && !err && items.length === 0 && (
        <div className="text-sm text-gray-500">
          No recommendations yet. Try adding some titles to your wishlist.
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
