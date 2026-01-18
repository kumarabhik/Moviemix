// frontend/lib/session.js

const KEY_PRIMARY = "moviemix_token";
const KEY_FALLBACK = "token";

export function getToken() {
  if (typeof window === "undefined") return "";
  return localStorage.getItem(KEY_PRIMARY) || localStorage.getItem(KEY_FALLBACK) || "";
}

export function setToken(token) {
  if (typeof window === "undefined") return;
  if (!token) return;
  localStorage.setItem(KEY_PRIMARY, String(token));
  // also write fallback for any older codepaths (safe)
  localStorage.setItem(KEY_FALLBACK, String(token));
}

export function isAbEnabled() {
  return String(process.env.NEXT_PUBLIC_ENABLE_AB_TEST || "0") === "1";

}


export function isLoggedIn() {
  return !!getToken();
}

export function logout() {
  if (typeof window === "undefined") return;
  localStorage.removeItem(KEY_PRIMARY);
  localStorage.removeItem(KEY_FALLBACK);
}

export function getUserIdFromToken(token = "") {
  try {
    const t = token || getToken();
    if (!t) return "";

    const parts = String(t).split(".");
    if (parts.length < 2) return "";

    // base64url -> base64
    let b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");

    // pad base64 BEFORE decoding
    while (b64.length % 4 !== 0) b64 += "=";

    const json = JSON.parse(atob(b64));

    return String(
      json?.userId ||
        json?.userid ||
        json?.user_id ||
        json?.uid ||
        json?.id ||
        json?.sub ||
        ""
    );
  } catch {
    return "";
  }
}


export function abVariantFromUserId(userId = "") {
  // stable hash -> A/B
  let h = 0;
  const s = String(userId || "");
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) >>> 0;
  }
  return h % 2 === 0 ? "A" : "B";
}
