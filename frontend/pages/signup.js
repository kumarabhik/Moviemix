import { useState } from "react";

export default function SignupPage() {
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
      if (!r.ok) throw new Error(j?.error || "signup_failed");
      localStorage.setItem("moviemix_token", j.token);
      window.location.href = "/";
    } catch (e) {
      setErr(String(e.message || e));
    }
  };

  return (
    <section className="h-100" style={{ minHeight: "100vh"}}>
      <div className="container h-100">
        <div className="row justify-content-sm-center align-items-center h-100">
          <div className="col-xxl-5 col-xl-6 col-lg-6 col-md-8 col-sm-10">
            {/* LOGO */}
            <div className="text-center mb-3" style={{ marginBottom: "-20px" }}>
              <div
                className="rounded-circle d-inline-flex align-items-center justify-content-center"
                style={{
                  width: "72px",
                  height: "72px",
                  backgroundColor: "#0ea5e9",
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
                <h1 className="fs-4 card-title fw-bold mb-4">Sign up</h1>

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
                    <input
                      id="email"
                      type="email"
                      className="form-control form-control-lg"
                      required
                      autoFocus
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                    />
                  </div>

                  <div className="mb-3">
                    <label className="mb-2 text-muted" htmlFor="password">
                      Password
                    </label>
                    <input
                      id="password"
                      type="password"
                      className="form-control form-control-lg"
                      required
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                    />
                  </div>

                  <div className="d-flex align-items-center">
                    <button type="submit" className="btn btn-primary ms-auto">
                      Create Account
                    </button>
                  </div>
                </form>
              </div>

              <div className="card-footer py-3 border-0">
                <div className="text-center">
                  Already have an account?{" "}
                  <a href="/login" className="text-dark text-decoration-none">
                    Login
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
