/** @type {import('next').NextConfig} */
const BACKEND_ORIGIN = process.env.BACKEND_ORIGIN || "http://backend:8000";

module.exports = {
  output: "standalone",
  reactStrictMode: true,
  async rewrites() {
    return [
      { source: "/api/:path*", destination: `${BACKEND_ORIGIN}/api/:path*` },
      { source: "/health", destination: `${BACKEND_ORIGIN}/health` },
    ];
  },
  env: {
    ENABLE_AB_TEST: process.env.ENABLE_AB_TEST || "0",
  },
};

