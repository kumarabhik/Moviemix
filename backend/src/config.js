import "dotenv/config";

export function requiredEnv(name) {
  const value = process.env[name];
  if (value && String(value).trim().length > 0) {
    return value;
  }
  throw new Error(`Missing required environment variable: ${name}`);
}

export const DATABASE_URL = requiredEnv("DATABASE_URL");
export const JWT_SECRET = requiredEnv("JWT_SECRET");

