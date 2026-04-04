import { useEffect, useState } from "react";
import { useRouter } from "next/router";
import { setToken } from "../../../lib/session";

function humanizeError(code = "") {
  const key = String(code || "").trim();
  switch (key) {
    case "google_auth_not_configured":
      return "Google sign in is not configured yet.";
    case "google_account_not_verified":
      return "Your Google account email is not verified.";
    case "google_state_invalid":
      return "Google sign in expired. Please try again.";
    case "google_token_exchange_failed":
    case "google_login_failed":
      return "Google sign in failed. Please try again.";
    default:
      return key ? key.replaceAll("_", " ") : "Google sign in failed.";
  }
}

export default function GoogleAuthCallbackPage() {
  const router = useRouter();
  const [message, setMessage] = useState("Finishing Google sign in...");

  useEffect(() => {
    if (!router.isReady) return;

    const token = String(router.query.token || "").trim();
    const error = String(router.query.error || "").trim();
    const returnTo = String(router.query.returnTo || "/").trim() || "/";

    if (token) {
      setToken(token);
      window.location.replace(returnTo.startsWith("/") ? returnTo : "/");
      return;
    }

    if (error) {
      setMessage(humanizeError(error));
      return;
    }

    setMessage("Google sign in did not return a session token.");
  }, [router]);

  return (
    <section className="min-h-[60vh] flex items-center justify-center">
      <div className="max-w-md rounded-3xl border border-slate-200/70 bg-white/85 dark:bg-slate-900/70 dark:border-slate-700/70 shadow-xl p-8 text-center">
        <h1 className="text-2xl font-semibold mb-3">Google Sign In</h1>
        <p className="text-sm text-slate-600 dark:text-slate-300">{message}</p>
        {!String(router.query.token || "").trim() && (
          <a href="/login" className="inline-block mt-5 text-sm underline">
            Back to login
          </a>
        )}
      </div>
    </section>
  );
}
