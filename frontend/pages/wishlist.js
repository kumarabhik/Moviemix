import { useEffect, useState } from "react";

import MovieCard from "../components/MovieCard";
import { getWishlist, importFromTrakt, toArray } from "../lib/api";

export default function WishlistPage() {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [importStatus, setImportStatus] = useState("");

  async function loadWishlist() {
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
  }

  async function onImportFromTrakt() {
    try {
      setErr("");
      setImportStatus("Importing from Trakt...");
      const data = await importFromTrakt();
      const inserted = data?.totals?.insertedWishlist ?? 0;
      setImportStatus(`Imported ${inserted} items from Trakt`);
      await loadWishlist();
    } catch (e) {
      setImportStatus("");
      setErr(String(e.message || e));
    }
  }

  useEffect(() => {
    loadWishlist();
  }, []);

  return (
    <div className="max-w-4xl mx-auto p-4 space-y-3">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">My Wishlist</h1>
        <button
          onClick={onImportFromTrakt}
          type="button"
          className="px-3 py-2 rounded-lg bg-sky-600 hover:bg-sky-500 text-white text-sm"
        >
          Import from Trakt
        </button>
      </div>

      {importStatus && <div className="text-sm opacity-80">{importStatus}</div>}
      {loading && <div>Loading...</div>}
      {err && <div className="text-red-600 text-sm">{err}</div>}
      {!loading && !err && items.length === 0 && (
        <div className="opacity-70 text-sm">
          Your wishlist is empty. Search for a title and add it from the cards.
        </div>
      )}

      <div className="grid gap-3">
        {items.map((it, i) => (
          <MovieCard
            key={it.title_id ?? it.id ?? i}
            item={it}
            initialSaved
            onRemoved={(removedId) =>
              setItems((prev) =>
                prev.filter((row) => (row.title_id ?? row.id) !== removedId)
              )
            }
          />
        ))}
      </div>
    </div>
  );
}

