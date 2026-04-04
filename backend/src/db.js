import pkg from 'pg';
import { DATABASE_URL } from "./config.js";

const { Pool } = pkg;

function wantsSsl(url = "") {
  const mode = String(process.env.DATABASE_SSLMODE || process.env.PGSSLMODE || "").toLowerCase();
  if (["1", "true", "require", "prefer", "verify-ca", "verify-full"].includes(mode)) {
    return true;
  }

  if (["1", "true", "yes"].includes(String(process.env.DATABASE_REQUIRE_SSL || "").toLowerCase())) {
    return true;
  }

  return /[?&]sslmode=require(?:&|$)/i.test(String(url || ""));
}

const ssl = wantsSsl(DATABASE_URL)
  ? {
      rejectUnauthorized:
        ["1", "true", "yes"].includes(
          String(process.env.DATABASE_REJECT_UNAUTHORIZED || "").toLowerCase()
        ),
    }
  : undefined;

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl,
});

export default pool;
