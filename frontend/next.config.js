/** @type {import('next').NextConfig} */
const BACKEND_ORIGIN = process.env.BACKEND_ORIGIN || 'http://backend:8000';

module.exports = {
  output: 'standalone',            // 👈 REQUIRED so server.js gets generated
  async rewrites() {
    return [
      { source: '/api/:path*', destination: `${BACKEND_ORIGIN}/api/:path*` },
      { source: '/health', destination: `${BACKEND_ORIGIN}/health` },
    ];
  },
};
