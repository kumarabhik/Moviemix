/** @type {import('next').NextConfig} */
const BACKEND_ORIGIN = String(
  process.env.BACKEND_ORIGIN || process.env.NEXT_PUBLIC_API_BASE || ""
).replace(/\/+$/, "");

module.exports = {
  output: "standalone",
  reactStrictMode: true,
  async rewrites() {
    if (!BACKEND_ORIGIN) {
      return [];
    }

    return [
      { source: "/api/:path*", destination: `${BACKEND_ORIGIN}/api/:path*` },
      { source: "/health", destination: `${BACKEND_ORIGIN}/health` },
    ];
  },
  env: {
    ENABLE_AB_TEST: process.env.ENABLE_AB_TEST || "0",
  },
};
