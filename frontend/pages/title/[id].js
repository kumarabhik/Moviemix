import { useRouter } from "next/router";
import { useEffect, useState } from "react";

import MovieCard from "../../components/MovieCard";
import {
  getSimilarBySeedText,
  getTitleById,
  getWatchLinks,
  getWishlist,
  toArray,
} from "../../lib/api";
import { getToken, isLoggedIn } from "../../lib/session";

function normalizeId(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : String(v);
}

function dedupeItems(items) {
  const seen = new Set();
  const out = [];
  for (const it of items || []) {
    const imdb = String(it?.imdb_id || "").trim().toLowerCase();
    const trakt = String(it?.trakt_id || "").trim().toLowerCase();
    const title = String(it?.title || it?.name || "")
      .trim()
      .toLowerCase();
    const year = String(it?.year || "").trim();
    const id = String(it?.title_id ?? it?.id ?? "").trim();
    const keys = [];
    if (imdb) keys.push(`imdb:${imdb}`);
    if (trakt) keys.push(`trakt:${trakt}`);
    if (title && year) keys.push(`title_year:${title}:${year}`);
    if (title) keys.push(`title:${title}`);
    if (id) keys.push(`id:${id}`);
    if (keys.length === 0) continue;
    if (keys.some((k) => seen.has(k))) continue;
    keys.forEach((k) => seen.add(k));
    out.push(it);
  }
  return out;
}

export default function TitlePage() {
  const router = useRouter();
  const { id } = router.query;

  const [item, setItem] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [similar, setSimilar] = useState([]);
  const [simErr, setSimErr] = useState("");
  const [watchLinks, setWatchLinks] = useState(null);
  const [savedIds, setSavedIds] = useState(new Set());

  async function loadSavedIds() {
    if (!isLoggedIn()) {
      setSavedIds(new Set());
      return;
    }
    try {
      const w = await getWishlist();
      const ids = new Set(
        toArray(w)
          .map((it) => normalizeId(it.title_id ?? it.id))
          .filter((v) => v !== null)
      );
      setSavedIds(ids);
    } catch {
      setSavedIds(new Set());
    }
  }

  useEffect(() => {
    if (!router.isReady || !id) return;
    (async () => {
      try {
        setErr("");
        setLoading(true);
        const t = await getTitleById(id);
        setItem(t.item);
        await loadSavedIds();
        const w = await getWatchLinks(id);
        if (w?.ok) setWatchLinks(w.links);
      } catch (e) {
        console.error(e);
        setErr("Failed to load title");
      } finally {
        setLoading(false);
      }
    })();
  }, [router.isReady, id]);

  useEffect(() => {
    const onFocus = () => loadSavedIds();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  useEffect(() => {
    if (!item) return;
    (async () => {
      try {
        setSimErr("");
        const seedText = item.title || item.name || "";
        if (!seedText) return setSimilar([]);
        const res = await getSimilarBySeedText(seedText, 8);
        setSimilar(dedupeItems(toArray(res)));
      } catch (e) {
        console.error(e);
        setSimErr("Failed to load similar titles");
      }
    })();
  }, [item]);

  useEffect(() => {
    if (!item) return;
    const token = getToken();
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
        type="button"
      >
        Back
      </button>

      {loading && <div>Loading...</div>}
      {err && <div className="text-red-600 text-sm">{err}</div>}

      {item && (
        <>
          <MovieCard
            item={item}
            initialSaved={savedIds.has(normalizeId(item.title_id ?? item.id))}
            onAdded={(idVal) =>
              setSavedIds((prev) => {
                const next = new Set(prev);
                const idNorm = normalizeId(idVal);
                if (idNorm !== null) next.add(idNorm);
                return next;
              })
            }
            onRemoved={(idVal) =>
              setSavedIds((prev) => {
                const next = new Set(prev);
                const idNorm = normalizeId(idVal);
                if (idNorm !== null) next.delete(idNorm);
                return next;
              })
            }
          />

          {watchLinks && (
            <div className="mt-4 p-3 rounded-xl border border-white/20 bg-white/40 dark:bg-slate-900/40">
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
                <a
                  href={watchLinks.google}
                  target="_blank"
                  rel="noreferrer"
                  className="px-3 py-2 rounded bg-slate-500/10 hover:bg-slate-500/20 text-sm font-medium"
                >
                  Search Google
                </a>
              </div>
            </div>
          )}

          <div className="mt-6">
            <h2 className="text-xl font-semibold mb-2">More like this</h2>
            {simErr && <div className="text-red-600 text-sm mb-2">{simErr}</div>}
            {similar.length === 0 && !simErr && (
              <div className="text-sm opacity-70">No similar titles yet.</div>
            )}
            <div className="grid gap-3">
              {similar.map((s, i) => (
                <MovieCard
                  key={s.title_id ?? s.id ?? i}
                  item={s}
                  initialSaved={savedIds.has(normalizeId(s.title_id ?? s.id))}
                  onAdded={(idVal) =>
                    setSavedIds((prev) => {
                      const next = new Set(prev);
                      const idNorm = normalizeId(idVal);
                      if (idNorm !== null) next.add(idNorm);
                      return next;
                    })
                  }
                  onRemoved={(idVal) =>
                    setSavedIds((prev) => {
                      const next = new Set(prev);
                      const idNorm = normalizeId(idVal);
                      if (idNorm !== null) next.delete(idNorm);
                      return next;
                    })
                  }
                />
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
