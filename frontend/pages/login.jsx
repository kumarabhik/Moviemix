import { useState } from "react";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState("");

  const submit = async (e) => {
    e.preventDefault();
    setErr("");
    try {
      const r = await fetch("/api/auth/login", {
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
    <section className="h-100" style={{ minHeight: "100vh" }}>
      <div className="container h-100">
        <div className="row justify-content-sm-center align-items-center h-100">
          <div className="col-xxl-5 col-xl-6 col-lg-6 col-md-8 col-sm-10">
            {/* LOGO (M instead of B, centered) */}
            <div className="text-center mb-3" style={{ marginBottom: "-20px" }}>
              <div
                className="rounded-circle d-inline-flex align-items-center justify-content-center"
                style={{
                  width: "72px",
                  height: "72px",
                  backgroundColor: "#6f42c1", // Bootstrap purple
                  color: "white",
                  fontSize: "2rem",
                  fontWeight: "700",
                  boxShadow: "0 0.5rem 1rem rgba(0,0,0,0.15)",
                }}
              >
                M
              </div>
            </div>

            <div className="card shadow-lg">
              <div className="card-body p-5 px-5 py-4">
                <h1 className="fs-4 card-title fw-bold mb-4">Login</h1>

                {err && (
                  <div className="alert alert-danger py-2 mb-3">
                    {err}
                  </div>
                )}

                <form
                  onSubmit={submit}
                  className="needs-validation"
                  noValidate
                  autoComplete="off"
                >
                  <div className="mb-3">
                    <label className="mb-2 text-muted" htmlFor="email">
                      E-Mail Address
                    </label>
                    {/* thicker input: form-control-lg */}
                    <input
                      id="email"
                      type="email"
                      className="form-control form-control-lg"
                      name="email"
                      required
                      autoFocus
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                    />
                    <div className="invalid-feedback">Email is invalid</div>
                  </div>

                  <div className="mb-3">
                    <div className="mb-2 w-100 d-flex justify-content-between">
                      <label className="text-muted" htmlFor="password">
                        Password
                      </label>
                      <a href="/forgot" className="text-decoration-none">
                        Forgot Password?
                      </a>
                    </div>
                    {/* thicker input: form-control-lg */}
                    <input
                      id="password"
                      type="password"
                      className="form-control form-control-lg"
                      name="password"
                      required
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                    />
                    <div className="invalid-feedback">
                      Password is required
                    </div>
                  </div>

                  <div className="d-flex align-items-center">
                    <div className="form-check">
                      <input
                        type="checkbox"
                        name="remember"
                        id="remember"
                        className="form-check-input"
                      />
                      <label
                        htmlFor="remember"
                        className="form-check-label"
                      >
                        Remember Me
                      </label>
                    </div>
                    <button type="submit" className="btn btn-primary ms-auto">
                      Login
                    </button>
                  </div>
                </form>
              </div>

              <div className="card-footer py-3 border-0">
                <div className="text-center">
                  Don&apos;t have an account?{" "}
                  <a href="/signup" className="text-dark text-decoration-none">
                    Create One
                  </a>
                </div>
              </div>
            </div>

            {/* <div className="text-center mt-5 text-muted">
              Copyright &copy; 2017-2024 &mdash; Your Company
            </div> */}
          </div>
        </div>
      </div>
    </section>
  );
}
