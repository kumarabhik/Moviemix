import { useState } from 'react';

export default function SearchBar({ onSearch }) {
  const [q, setQ] = useState('');

  const submit = e => {
    e.preventDefault();
    if (!q.trim()) return;
    onSearch(q.trim());
  };

  return (
    <form onSubmit={submit} className="flex gap-2 mb-4">
      <input
        className="flex-1 px-3 py-2 rounded border dark:border-gray-700 bg-transparent"
        placeholder="Search a movie (e.g., Ice Age)"
        value={q}
        onChange={e => setQ(e.target.value)}
      />
      <button className="px-4 py-2 rounded bg-blue-600 text-white">Search</button>
    </form>
  );
}
