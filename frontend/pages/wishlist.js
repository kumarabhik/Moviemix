// frontend/pages/wishlist.js
import { useEffect, useState } from "react";
import MovieCard from "../components/MovieCard";
import { getWishlist, toArray } from "../lib/api";
import { getToken } from "../lib/session"; // ✅ REQUIRED FIX
import { importFromTrakt as importTraktWishlist } from "../lib/api";


export default function WishlistPage() {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [importStatus, setImportStatus] = useState("");

  // ✅ loader refactor
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

  // ✅ import from Trakt + refresh (AUTH FIX APPLIED)
  async function importFromTrakt() {
    try {
      setImportStatus("Importing from Trakt...");
      setErr("");

      const r = await fetch("/api/integrations/trakt/import", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${getToken()}`, // ✅ FIX
        },
      });

      const data = await r.json().catch(() => ({}));

      if (!r.ok) {
        setImportStatus("");
        setErr(data?.error || "Trakt import failed");
        return;
      }

      const n = data?.totals?.insertedWishlist ?? 0;
      setImportStatus(`Imported ${n} items from Trakt`);
      await loadWishlist();
    } catch (e) {
      console.error(e);
      setImportStatus("");
      setErr("Trakt import failed");
    }
  }

  useEffect(() => {
    loadWishlist();
  }, []);

  return (
    <div className="max-w-4xl mx-auto p-4 space-y-3">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold mb-2">My Wishlist</h1>

        <button
          onClick={importFromTrakt}
          type="button"
          className="px-3 py-2 rounded-md bg-purple-600 text-white text-sm"
        >
          Import from Trakt
        </button>
      </div>

      {importStatus && <div className="text-sm opacity-80">{importStatus}</div>}

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
              setItems((prev) =>
                prev.filter((it) => (it.title_id ?? it.id) !== removedID)
              )
            }
          />
        ))}
      </div>
    </div>
  );
}
