// frontend/pages/title/[id].js
import { useRouter } from "next/router";
import { useEffect, useState } from "react";
import MovieCard from "../../components/MovieCard";
import { getTitleById, getSimilarBySeedText, toArray } from "../../lib/api";

export default function TitlePage() {
  const router = useRouter();
  const { id } = router.query;

  const [item, setItem] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");

  const [similar, setSimilar] = useState([]);
  const [simErr, setSimErr] = useState("");

  // Load the main title by ID
  useEffect(() => {
    if (!id) return;
    (async () => {
      try {
        setErr("");
        setLoading(true);
        const res = await getTitleById(id);
        setItem(res.item);
      } catch (e) {
        console.error(e);
        setErr("Failed to load title");
      } finally {
        setLoading(false);
      }
    })();
  }, [id]);

  // Load similar titles when `item` is available
  useEffect(() => {
    if (!item) return;
    (async () => {
      try {
        setSimErr("");
        const seedText = item.title || item.name || "";
        if (!seedText) {
          setSimilar([]);
          return;
        }
        const res = await getSimilarBySeedText(seedText, 5);
        setSimilar(toArray(res));
      } catch (e) {
        console.error(e);
        setSimErr("Failed to load similar titles");
      }
    })();
  }, [item]);

  useEffect(() => {
  if (!item) return;
  const token = localStorage.getItem("moviemix_token") || "";
  fetch("/api/interactions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ event: "detail_open", title_id: item.id || item.title_id }),
  }).catch(() => {});
  }, [item]);


  if (!id) return null;

  return (
    <div className="max-w-4xl mx-auto p-4 space-y-4">
      <button
        onClick={() => router.back()}
        className="text-sm opacity-70 hover:opacity-100"
      >
        ← Back
      </button>

      {loading && <div>Loading…</div>}
      {err && <div className="text-red-600 text-sm">{err}</div>}

      {item && (
        <>
          <MovieCard item={item} />

          {/* More like this */}
          <div className="mt-6">
            <h2 className="text-xl font-semibold mb-2">More like this</h2>

            {simErr && (
              <div className="text-red-600 text-sm mb-2">{simErr}</div>
            )}

            {similar.length === 0 && !simErr && (
              <div className="text-sm opacity-70">No similar titles yet.</div>
            )}

            <div className="grid gap-3">
              {similar.map((s, i) => (
                <MovieCard
                  key={s.title_id ?? s.id ?? i}
                  item={s}
                />
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
