import "bootstrap/dist/css/bootstrap.min.css";
import "../styles/globals.css";

import { useEffect, useState } from "react";
import Link from "next/link";

import { getToken, isLoggedIn, logout } from "../lib/session";

function Header({ dark, setDark }) {
  const [logged, setLogged] = useState(false);

  useEffect(() => {
    const refresh = () => setLogged(isLoggedIn());
    refresh();
    window.addEventListener("storage", refresh);
    return () => window.removeEventListener("storage", refresh);
  }, []);

  return (
    <header className="mm-header p-4 flex items-center justify-between gap-4">
      <Link href="/" className="font-semibold tracking-wide text-lg">
        MovieMix
      </Link>

      <nav className="flex items-center gap-3 sm:gap-4">
        {logged ? (
          <>
            <Link href="/foryou" className="text-sm hover:underline">
              For You
            </Link>
            <Link href="/wishlist" className="text-sm hover:underline">
              Wishlist
            </Link>
            <Link href="/experiment" className="text-sm hover:underline">
              Experiments
            </Link>
            <button
              onClick={() => {
                logout();
                window.location.href = "/login";
              }}
              className="text-sm hover:underline"
            >
              Logout
            </button>
          </>
        ) : (
          <Link href="/login" className="text-sm hover:underline">
            Login
          </Link>
        )}

        <button
          className="px-3 py-1 rounded-lg border border-slate-300/70 dark:border-slate-700/70 text-sm"
          onClick={() => setDark((d) => !d)}
          type="button"
        >
          {dark ? "Light" : "Dark"}
        </button>
      </nav>
    </header>
  );
}

export default function MyApp({ Component, pageProps }) {
  const [dark, setDark] = useState(false);

  useEffect(() => {
    const stored = window.localStorage.getItem("moviemix_theme");
    if (stored === "dark") setDark(true);
  }, []);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    window.localStorage.setItem("moviemix_theme", dark ? "dark" : "light");
  }, [dark]);

  useEffect(() => {
    if (sessionStorage.getItem("mm_session_started") === "1") return;
    const token = getToken();
    if (!token) return;
    sessionStorage.setItem("mm_session_started", "1");

    fetch("/api/interactions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        event: "session_start",
        meta: { source: "web" },
      }),
    }).catch(() => {});
  }, []);

  return (
    <div className="min-h-screen text-slate-900 dark:text-slate-100">
      <div className="mm-bg" />
      <div className="relative z-10">
        <Header dark={dark} setDark={setDark} />
        <main className="max-w-5xl mx-auto p-4">
          <Component {...pageProps} />
        </main>
      </div>
    </div>
  );
}

