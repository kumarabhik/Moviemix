// frontend/pages/wishlist.js
import { useEffect, useState } from "react";
import MovieCard from "../components/MovieCard";
import { getWishlist, toArray } from "../lib/api";

export default function WishlistPage() {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");

  useEffect(() => {
    (async () => {
      try {
        setErr("");
        setLoading(true);
        const res = await getWishlist();
        setItems(toArray(res));
      } catch (e) {
        console.error(e);
        setErr("Failed to load wishlist");
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  return (
    <div className="max-w-4xl mx-auto p-4 space-y-3">
      <h1 className="text-2xl font-semibold mb-2">My Wishlist</h1>

      {loading && <div>Loading…</div>}
      {err && <div className="text-red-600 text-sm">{err}</div>}
      {!loading && !err && items.length === 0 && (
        <div className="opacity-70 text-sm">
          Your wishlist is empty. Search for a movie and click “Wishlist” to add it.
        </div>
      )}

      <div className="grid gap-3">
        {items.map((it, i) => (
          <MovieCard
            key={it.title_id ?? it.id ?? i}
            item={it}
            initialSaved={true}
            onRemoved={(removedID) =>
              setItems((prev) => prev.filter((it) => (it.title_id ?? it.id) !== removedID))
            }
          />
        ))}
      </div>
    </div>
  );
}
