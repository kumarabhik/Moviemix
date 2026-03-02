import { useState } from "react";

export default function SearchBar({ onSearch }) {
  const [q, setQ] = useState("");

  const submit = (e) => {
    e.preventDefault();
    const next = q.trim();
    if (!next) return;
    onSearch(next);
  };

  return (
    <form onSubmit={submit} className="flex gap-2">
      <input
        className="flex-1 px-3 py-2.5 rounded-xl border border-slate-300/80 dark:border-slate-700 bg-white/80 dark:bg-slate-900/70"
        placeholder="Search movies or series (for example: Ice Age, Dune, time travel)"
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      <button
        className="px-4 py-2.5 rounded-xl bg-sky-600 hover:bg-sky-500 text-white font-medium disabled:opacity-50"
        disabled={!q.trim()}
        type="submit"
      >
        Search
      </button>
    </form>
  );
}

