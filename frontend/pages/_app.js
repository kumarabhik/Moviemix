// frontend/pages/_app.js
import "../styles/globals.css";
import { useEffect, useState } from "react";
import { isLoggedIn, logout } from "../lib/session";
import Link from "next/link";

function Header({ dark, setDark }) {
  const [logged, setLogged] = useState(false);

  useEffect(() => {
    setLogged(isLoggedIn());
  }, []);

  return (
    <header className="p-4 flex items-center justify-between border-b border-gray-200 dark:border-gray-800">
      <Link href="/" className="font-semibold">
        MovieMix
      </Link>

      <div className="flex items-center gap-3">
        {logged ? (
          <>
            <Link href="/foryou" className="text-sm text-blue-600">
              For You
            </Link>
            <Link href="/wishlist" className="text-sm text-blue-600">
              Wishlist
            </Link>
            <button
              onClick={() => {
                logout();
                window.location.reload();
              }}
              className="text-sm text-blue-600"
            >
              Logout
            </button>
          </>
        ) : (
          <Link href="/login" className="text-sm text-blue-600">
            Login
          </Link>
        )}

        <button
          className="px-3 py-1 rounded border dark:border-gray-700"
          onClick={() => setDark((d) => !d)}
        >
          {dark ? "Light" : "Dark"}
        </button>
      </div>
    </header>
  );
}

export default function App({ Component, pageProps }) {
  const [dark, setDark] = useState(false);

  // On first mount, read saved theme
  useEffect(() => {
    if (typeof window === "undefined") return;
    const stored = window.localStorage.getItem("moviemix_theme");
    if (stored === "dark") {
      setDark(true);
    }
  }, []);

  // Whenever dark changes, update <html> and save to localStorage
  useEffect(() => {
    if (typeof document !== "undefined") {
      document.documentElement.classList.toggle("dark", dark);
    }
    if (typeof window !== "undefined") {
      window.localStorage.setItem("moviemix_theme", dark ? "dark" : "light");
    }
  }, [dark]);

  return (
    <div className="min-h-screen bg-white text-gray-900 dark:bg-gray-900 dark:text-gray-100">
      <Header dark={dark} setDark={setDark} />
      <main className="max-w-4xl mx-auto p-4">
        <Component {...pageProps} />
      </main>
    </div>
  );
}