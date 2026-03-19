import "bootstrap/dist/css/bootstrap.min.css";
import "../styles/globals.css";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";

import { getEmailFromToken, getToken, isLoggedIn, logout } from "../lib/session";

function toDisplayName(email = "") {
  const raw = String(email || "").split("@")[0].trim();
  if (!raw) return "Profile";
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

function Header({ dark, setDark }) {
  const [logged, setLogged] = useState(false);
  const [email, setEmail] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const profileButtonRef = useRef(null);
  const [menuPos, setMenuPos] = useState({ top: 0, left: 0 });

  useEffect(() => {
    const refresh = () => {
      const loggedIn = isLoggedIn();
      setLogged(loggedIn);
      setEmail(loggedIn ? getEmailFromToken() : "");
    };
    refresh();
    window.addEventListener("storage", refresh);
    return () => window.removeEventListener("storage", refresh);
  }, []);

  useEffect(() => {
    if (!menuOpen) return undefined;

    const updateMenuPosition = () => {
      if (!profileButtonRef.current) return;
      const rect = profileButtonRef.current.getBoundingClientRect();
      const width = 224;
      const maxLeft = Math.max(8, window.innerWidth - width - 8);
      setMenuPos({
        top: rect.bottom + 8,
        left: Math.min(Math.max(8, rect.left), maxLeft),
      });
    };

    updateMenuPosition();

    const close = () => setMenuOpen(false);
    const reflow = () => updateMenuPosition();

    window.addEventListener("click", close);
    window.addEventListener("resize", reflow);
    window.addEventListener("scroll", reflow, true);

    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("resize", reflow);
      window.removeEventListener("scroll", reflow, true);
    };
  }, [menuOpen]);

  const profileName = toDisplayName(email);
  const profileInitial = profileName.charAt(0).toUpperCase();

  return (
    <header className="mm-header relative z-40 p-4 flex items-center justify-between gap-4">
      <Link href="/" className="font-semibold tracking-wide text-lg">
        MovieMix
      </Link>

      <nav className="flex items-center gap-3 sm:gap-4">
        {logged ? (
          <>
            <div className="relative" onClick={(e) => e.stopPropagation()}>
              <button
                ref={profileButtonRef}
                type="button"
                onClick={() => setMenuOpen((v) => !v)}
                className="px-2.5 py-1.5 rounded-xl border border-sky-200/70 dark:border-sky-800/70 bg-sky-50/70 dark:bg-sky-900/30 text-sm flex items-center gap-2"
              >
                <span className="h-6 w-6 rounded-full bg-sky-600 text-white text-xs font-semibold flex items-center justify-center">
                  {profileInitial}
                </span>
                <span>{profileName}</span>
              </button>
              {menuOpen && (
                <div
                  className="fixed w-56 rounded-xl border border-sky-100 dark:border-slate-700 bg-white/95 dark:bg-slate-900/95 shadow-xl p-2 z-[9999]"
                  style={{ top: menuPos.top, left: menuPos.left }}
                >
                  <Link
                    href="/profile"
                    className="block rounded-lg px-3 py-2 text-sm hover:bg-slate-100 dark:hover:bg-slate-800"
                    onClick={() => setMenuOpen(false)}
                  >
                    Your profile
                  </Link>
                  <Link
                    href="/foryou"
                    className="block rounded-lg px-3 py-2 text-sm hover:bg-slate-100 dark:hover:bg-slate-800"
                    onClick={() => setMenuOpen(false)}
                  >
                    For You
                  </Link>
                  <Link
                    href="/wishlist"
                    className="block rounded-lg px-3 py-2 text-sm hover:bg-slate-100 dark:hover:bg-slate-800"
                    onClick={() => setMenuOpen(false)}
                  >
                    Your Watchlist
                  </Link>
                  <Link
                    href="/profile#ratings"
                    className="block rounded-lg px-3 py-2 text-sm hover:bg-slate-100 dark:hover:bg-slate-800"
                    onClick={() => setMenuOpen(false)}
                  >
                    Your ratings
                  </Link>
                  <Link
                    href="/wishlist"
                    className="block rounded-lg px-3 py-2 text-sm hover:bg-slate-100 dark:hover:bg-slate-800"
                    onClick={() => setMenuOpen(false)}
                  >
                    Your lists
                  </Link>
                  <Link
                    href="/profile#history"
                    className="block rounded-lg px-3 py-2 text-sm hover:bg-slate-100 dark:hover:bg-slate-800"
                    onClick={() => setMenuOpen(false)}
                  >
                    Your watch history
                  </Link>
                  <button
                    onClick={() => {
                      logout();
                      window.location.href = "/login";
                    }}
                    className="w-full text-left rounded-lg px-3 py-2 text-sm text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-900/20"
                    type="button"
                  >
                    Sign out
                  </button>
                </div>
              )}
            </div>
            <Link href="/wishlist" className="text-sm hover:underline">
              Wishlist
            </Link>
            <Link href="/experiment" className="text-sm hover:underline">
              Experiments
            </Link>
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
