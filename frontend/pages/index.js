import { useEffect, useState } from 'react';
import SearchBar from '../components/SearchBar';
import MovieCard from '../components/MovieCard';
import { getSemantic, getTitles, toArray } from '../lib/api';
// import authRoutes from "./routes/auth.js";





export default function Home() {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');
  const [raw, setRaw] = useState(null);

  useEffect(() => {
    // load last query if present
    const last = localStorage.getItem('mm:lastQuery');
    if (last) {
      doSearch(last);
    } else {
      getTitles()
        .then(res => {
          setRaw(res);
          setItems(toArray(res));
        })
        .catch(() => {});
    }
  }, []);

  async function doSearch(q) {
    try {
      setErr('');
      setLoading(true);
      localStorage.setItem('mm:lastQuery', q);
      const res = await getSemantic(q, 5);
      setRaw(res);
      setItems(toArray(res));
    } catch {
      setErr('Search failed');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div>
      {/* 👇 this was missing */}
      <SearchBar onSearch={doSearch} />

      <div className="flex items-center gap-3 mb-2 mt-2">
        {loading && <div>Searching…</div>}

        {!loading && !err && items.length === 0 && (
          <div className="opacity-70">No results.</div>
        )}

        {!loading && err && (
          <div className="text-red-600">{err}</div>
        )}

        <button
          // className="ml-auto text-xs px-2 py-1 rounded border dark:border-gray-700"
          // onClick={() => setRaw(r => (r ? null : { ...raw }))}
        >
          {/* {raw ? 'Hide raw' : 'Show raw'} */}
        </button>
      </div>

      {/* {raw && (
        <pre className="text-xs p-2 rounded border dark:border-gray-800 overflow-auto max-h-40 mb-3">
          {JSON.stringify(raw, null, 2)}
        </pre>
      )} */}

      <div className="grid gap-3">
        {items.map((it, i) => (
          <MovieCard key={it.title_id ?? i} item={it} />
        ))}
      </div>
    </div>
  );
}
