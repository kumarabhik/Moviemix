import { useEffect, useState } from "react";
import Link from "next/link";

import { getMyProfile } from "../lib/api";
import { isLoggedIn } from "../lib/session";

function formatDate(v) {
  if (!v) return "-";
  try {
    return new Date(v).toLocaleString();
  } catch {
    return String(v);
  }
}

function StatCard({ label, value }) {
  return (
    <article className="rounded-xl border border-white/20 bg-white/50 dark:bg-slate-900/50 p-4">
      <div className="text-xs uppercase tracking-wide text-slate-500">{label}</div>
      <div className="mt-2 text-2xl font-semibold">{value}</div>
    </article>
  );
}

export default function ProfilePage() {
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [data, setData] = useState(null);

  useEffect(() => {
    if (!isLoggedIn()) {
      window.location.href = "/login";
      return;
    }

    (async () => {
      try {
        setErr("");
        setLoading(true);
        const out = await getMyProfile();
        setData(out);
      } catch (e) {
        setErr(String(e.message || e));
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const stats = data?.stats || {};
  const profile = data?.profile || {};
  const ratings = (data?.ratings || []).filter(
    (r) => Number(r.rating) >= 1 && Number(r.rating) <= 5
  );
  const reviews = (data?.reviews || []).filter(
    (r) => Number(r.rating) >= 1 && Number(r.rating) <= 5
  );
  const history = data?.recent_activity || [];

  return (
    <div className="space-y-5">
      <section className="rounded-2xl border border-white/20 bg-white/50 dark:bg-slate-900/50 p-4 sm:p-6 backdrop-blur">
        <h1 className="text-2xl sm:text-3xl font-semibold">Your profile</h1>
        <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">
          {profile.email || "MovieMix user"} · joined {formatDate(profile.created_at)}
        </p>
      </section>

      {loading && <div className="text-sm">Loading profile...</div>}
      {err && <div className="text-red-600 text-sm">{err}</div>}

      {!loading && !err && (
        <>
          <section className="grid grid-cols-2 md:grid-cols-5 gap-3">
            <StatCard label="Wishlist" value={stats.wishlist_count || 0} />
            <StatCard label="Watched" value={stats.watched_count || 0} />
            <StatCard label="Ratings" value={stats.ratings_count || 0} />
            <StatCard label="Reviews" value={stats.reviews_count || 0} />
            <StatCard label="Avg review (/5)" value={stats.avg_review_rating || 0} />
          </section>

          <section id="ratings" className="space-y-3">
            <h2 className="text-xl font-semibold">Your ratings</h2>
            {ratings.length === 0 && (
              <div className="text-sm text-slate-500">No ratings yet.</div>
            )}
            <div className="grid gap-3">
              {ratings.map((row, idx) => (
                <article
                  key={`${row.title_id}-${idx}`}
                  className="rounded-xl border border-white/20 bg-white/40 dark:bg-slate-900/40 p-3"
                >
                  <div className="flex items-center justify-between gap-3">
                    <Link href={`/title/${row.title_id}`} className="font-medium hover:underline">
                      {row.title} {row.year ? `(${row.year})` : ""}
                    </Link>
                    <span className="text-sm rounded-full px-2 py-1 bg-amber-500/15 text-amber-700 dark:text-amber-300">
                      {row.rating}/5
                    </span>
                  </div>
                  <div className="text-xs mt-2 text-slate-500">Updated {formatDate(row.ts)}</div>
                </article>
              ))}
            </div>
          </section>

          <section className="space-y-3">
            <h2 className="text-xl font-semibold">Your reviews</h2>
            {reviews.length === 0 && (
              <div className="text-sm text-slate-500">No reviews yet.</div>
            )}
            <div className="grid gap-3">
              {reviews.map((row) => (
                <article
                  key={row.id}
                  className="rounded-xl border border-white/20 bg-white/40 dark:bg-slate-900/40 p-3"
                >
                  <div className="flex items-center justify-between gap-3">
                    <Link href={`/title/${row.title_id}`} className="font-medium hover:underline">
                      {row.title} {row.year ? `(${row.year})` : ""}
                    </Link>
                    <span className="text-sm rounded-full px-2 py-1 bg-sky-500/15 text-sky-700 dark:text-sky-300">
                      {row.rating}/5
                    </span>
                  </div>
                  <p className="mt-2 text-sm text-slate-700 dark:text-slate-300">{row.review_text}</p>
                  <div className="text-xs mt-2 text-slate-500">Updated {formatDate(row.updated_at)}</div>
                </article>
              ))}
            </div>
          </section>

          <section id="history" className="space-y-3">
            <h2 className="text-xl font-semibold">Your watch history</h2>
            {history.length === 0 && (
              <div className="text-sm text-slate-500">No activity yet.</div>
            )}
            <div className="grid gap-2">
              {history.map((row) => (
                <article
                  key={row.id}
                  className="rounded-lg border border-white/20 bg-white/40 dark:bg-slate-900/40 p-3 text-sm flex items-center justify-between gap-2"
                >
                  <div className="truncate">
                    <span className="font-medium">{row.event}</span>
                    {row.title ? <span className="opacity-80"> · {row.title}</span> : null}
                  </div>
                  <div className="text-xs opacity-70 shrink-0">{formatDate(row.created_at)}</div>
                </article>
              ))}
            </div>
          </section>
        </>
      )}
    </div>
  );
}
