// backend/src/middleware/auth.js
import jwt from "jsonwebtoken";

const JWT_SECRET = process.env.JWT_SECRET || "dev_secret_change_me";

// Named export (optional)
export function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization || "";

  const token = authHeader.startsWith("Bearer ")
    ? authHeader.slice(7)
    : null;

  if (!token) {
    return res.status(401).json({ ok: false, error: "missing_token" });
  }

  try {
    // Verify JWT and extract payload
    const payload = jwt.verify(token, JWT_SECRET);

    // Attach user details for later use
    req.user = {
      id: payload.userId,
      email: payload.email,
    };

    return next();
  } catch (err) {
    console.error("JWT verification failed:", err.message);
    return res.status(401).json({ ok: false, error: "invalid_token" });
  }
}

// Default export — what all routes expect
export default requireAuth;
