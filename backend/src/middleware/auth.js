import jwt from "jsonwebtoken";
import { JWT_SECRET } from "../config.js";

export function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ")
    ? authHeader.slice(7)
    : null;

  if (!token) {
    return res.status(401).json({ ok: false, error: "missing_token" });
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = {
      id: payload.userId,
      email: payload.email,
      name: payload.name || "",
      avatarUrl: payload.avatarUrl || "",
      authProvider: payload.authProvider || "",
    };
    return next();
  } catch (err) {
    console.error("JWT verification failed:", err.message);
    return res.status(401).json({ ok: false, error: "invalid_token" });
  }
}

export default requireAuth;
