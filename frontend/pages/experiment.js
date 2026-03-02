import { useEffect, useMemo, useState } from "react";

import { getAbSummary } from "../lib/api";
import { isLoggedIn } from "../lib/session";

function percent(x) {
  return `${(Number(x || 0) * 100).toFixed(2)}%`;
}

export default function ExperimentPage() {
  const [days, setDays] = useState(14);
  const [scope, setScope] = useState("all");
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [summary, setSummary] = useState(null);

  async function load() {
    try {
      setErr("");
      setLoading(true);
      const data = await getAbSummary(days, scope);
      setSummary(data);
    } catch (e) {
      setErr(String(e.message || e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!isLoggedIn()) {
      setErr("Login required to view experiment metrics");
      setLoading(false);
      return;
    }
    load();
  }, [days, scope]);

  const maxCtr = useMemo(() => {
    const vals = summary?.variants?.map((v) => Number(v.ctr || 0)) || [0];
    return Math.max(...vals, 0.01);
  }, [summary]);

  return (
    <div className="space-y-4">
      <header className="rounded-2xl border border-white/20 bg-white/50 dark:bg-slate-900/50 p-4 backdrop-blur">
        <h1 className="text-xl sm:text-2xl font-semibold">A/B Dashboard</h1>
        <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">
          Tracks recommendation experiment performance using interaction events.
        </p>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <label className="text-xs">Window</label>
          <select
            className="px-2 py-1 rounded border border-slate-300 dark:border-slate-700 bg-transparent text-sm"
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
          >
            {[7, 14, 30, 60].map((d) => (
              <option key={d} value={d}>
                Last {d} days
              </option>
            ))}
          </select>

          <label className="text-xs ml-2">Scope</label>
          <select
            className="px-2 py-1 rounded border border-slate-300 dark:border-slate-700 bg-transparent text-sm"
            value={scope}
            onChange={(e) => setScope(e.target.value)}
          >
            <option value="all">All users</option>
            <option value="me">My account</option>
          </select>
        </div>
      </header>

      {loading && <div className="text-sm">Loading experiment metrics...</div>}
      {err && <div className="text-red-600 text-sm">{err}</div>}

      {!loading && !err && summary && (
        <section className="space-y-3">
          {summary.winner && (
            <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-3 text-sm">
              Current winner: <strong>Variant {summary.winner.variant}</strong> with{" "}
              <strong>{percent(summary.winner.ctr)}</strong> CTR
            </div>
          )}

          <div className="grid gap-3">
            {(summary.variants || []).map((v) => (
              <article
                key={v.variant}
                className="rounded-xl border border-white/20 bg-white/40 dark:bg-slate-900/40 p-4"
              >
                <div className="flex items-center justify-between gap-2">
                  <h2 className="font-semibold">Variant {v.variant}</h2>
                  <span className="text-xs text-slate-500">
                    impressions: {v.impressions}
                  </span>
                </div>

                <div className="mt-3 h-2 w-full rounded bg-slate-200 dark:bg-slate-800 overflow-hidden">
                  <div
                    className="h-full bg-sky-500"
                    style={{ width: `${Math.min((v.ctr / maxCtr) * 100, 100)}%` }}
                  />
                </div>

                <div className="mt-3 grid grid-cols-2 sm:grid-cols-4 gap-2 text-sm">
                  <div>
                    <div className="text-xs text-slate-500">CTR</div>
                    <div>{percent(v.ctr)}</div>
                  </div>
                  <div>
                    <div className="text-xs text-slate-500">Wishlist rate</div>
                    <div>{percent(v.wishlist_rate)}</div>
                  </div>
                  <div>
                    <div className="text-xs text-slate-500">Watch rate</div>
                    <div>{percent(v.watch_rate)}</div>
                  </div>
                  <div>
                    <div className="text-xs text-slate-500">Rating rate</div>
                    <div>{percent(v.rating_rate)}</div>
                  </div>
                </div>
              </article>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

