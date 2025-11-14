// frontend/pages/foryou.js
import { useEffect, useState } from "react";
import MovieCard from "../components/MovieCard";
import { getWishlist, toArray } from "../lib/api";
import { isLoggedIn } from "../lib/session";

export default function ForYou() {
  const [items, setItems] = useState([]);
  const [savedIds, setSavedIds] = useState(new Set());
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        setErr("");
        setLoading(true);

        // 1) If logged in, load wishlist and build a Set of saved ids
        if (isLoggedIn()) {
          try {
            const w = await getWishlist();
            const wItems = toArray(w);
            const ids = new Set(wItems.map((it) => it.id || it.title_id));
            setSavedIds(ids);
          } catch (e) {
            console.warn("wishlist load failed on ForYou:", e);
          }
        } else {
          setSavedIds(new Set());
        }

        let res;
        let json;
        let usedPersonalized = false;

        // 2) Try personalized recs if we have a token
        let token = null;
        if (typeof window !== "undefined") {
          token = window.localStorage.getItem("moviemix_token");
        }

        if (token) {
          res = await fetch("/api/recs/cf_user", {
            cache: "no-store",
            headers: { Authorization: `Bearer ${token}` },
          });
          json = await res.json();

          if (res.ok && Array.isArray(json.items) && json.items.length > 0) {
            setItems(json.items);
            usedPersonalized = true;
          }
        }

        // 3) Fallback: global popular CF if personalized failed or was empty
        if (!usedPersonalized) {
          res = await fetch("/api/recs/cf", { cache: "no-store" });
          json = await res.json();
          if (!res.ok) {
            throw new Error(json?.error || "cf_failed");
          }
          setItems(json.items || []);
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
              plot: it.plot, // if your API returns it
              poster_url: it.poster_url,
              score: it.score,
            }}
            initialSaved={savedIds.has(it.title_id)}
          />
        ))}
      </div>
    </div>
  );
}
