// frontend/pages/title/[id].js
import { useRouter } from "next/router";
import { useEffect, useState } from "react";
import MovieCard from "../../components/MovieCard";
import {
  getTitleById,
  getSimilarBySeedText,
  getWatchLinks,
  toArray,
} from "../../lib/api";

export default function TitlePage() {
  const router = useRouter();
  const { id } = router.query;

  const [item, setItem] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");

  const [similar, setSimilar] = useState([]);
  const [simErr, setSimErr] = useState("");

  const [watchLinks, setWatchLinks] = useState(null);

// Load title + watch links
  useEffect(() => {
    if (!router.isReady) return;
    if (!id) return;

    (async () => {
      try {
        setErr("");
        setLoading(true);

        const t = await getTitleById(id);
        setItem(t.item);

        // ✅ always try; backend is the gate
        try {
          const w = await getWatchLinks(id);
          if (w?.ok) setWatchLinks(w.links);
        } catch (_) {}
      } catch (e) {
        console.error(e);
        setErr("Failed to load title");
      } finally {
        setLoading(false);
      }
    })();
  }, [router.isReady, id]);


  // Load similar titles
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

  // Interaction tracking
  useEffect(() => {
    if (!item) return;
    const token = localStorage.getItem("moviemix_token") || "";
    fetch("/api/interactions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({
        event: "detail_open",
        title_id: item.id || item.title_id,
      }),
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

          {/* ✅ FINAL — Clickable Watch Links */}
          {watchLinks && (
            <div className="mt-4 p-3 rounded-lg border border-white/10 bg-white/5">
              <div className="font-semibold mb-2">Where to watch</div>

              <div className="flex flex-wrap gap-3">
                <a
                  href={watchLinks.netflix}
                  target="_blank"
                  rel="noreferrer"
                  className="px-3 py-2 rounded bg-red-500/10 text-red-600 hover:bg-red-500/20 text-sm font-medium"
                >
                  Netflix
                </a>

                <a
                  href={watchLinks.prime}
                  target="_blank"
                  rel="noreferrer"
                  className="px-3 py-2 rounded bg-blue-500/10 text-blue-600 hover:bg-blue-500/20 text-sm font-medium"
                >
                  Prime Video
                </a>
                {/* <a
                  href={watchLinks.disney}
                  target="_blank"
                  rel="noreferrer"
                  className="px-3 py-2 rounded bg-indigo-500/10 text-indigo-600 hover:bg-indigo-500/20 text-sm font-medium"
                >
                  Disney+
                </a> */}

                <a
                  href={watchLinks.google}
                  target="_blank"
                  rel="noreferrer"
                  className="px-3 py-2 rounded bg-gray-500/10 hover:bg-gray-500/20 text-sm font-medium"
                >
                  Search Google
                </a>
              </div>
            </div>
          )}

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
                <MovieCard key={s.title_id ?? s.id ?? i} item={s} />
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
