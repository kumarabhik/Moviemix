import { useState } from "react";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState("");

  const submit = async (e) => {
    e.preventDefault();
    setErr("");
    try {
      const r = await fetch("/api/auth/signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error || "login_failed");
      localStorage.setItem("moviemix_token", j.token);
      window.location.href = "/"; // back to home
    } catch (e) {
      setErr(String(e.message || e));
    }
  };

  return (
    <div className="max-w-sm mx-auto p-6">
      <h1 className="text-xl font-semibold mb-4">Log in</h1>
      {err && <div className="text-red-600 text-sm mb-2">{err}</div>}
      <form onSubmit={submit} className="space-y-3">
        <input className="w-full border p-2 rounded" placeholder="email"
               value={email} onChange={(e)=>setEmail(e.target.value)} />
        <input className="w-full border p-2 rounded" placeholder="password" type="password"
               value={password} onChange={(e)=>setPassword(e.target.value)} />
        <button className="px-4 py-2 rounded bg-blue-600 text-white">Log in</button>
      </form>
      <div className="mt-3 text-sm">
        No account? <a className="text-blue-600" href="/signup">Sign up</a>
      </div>
    </div>
  );
}
