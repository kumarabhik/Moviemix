export function getToken() { return localStorage.getItem("moviemix_token") || ""; }
export function isLoggedIn() { return !!getToken(); }
export function logout() { localStorage.removeItem("moviemix_token"); }
