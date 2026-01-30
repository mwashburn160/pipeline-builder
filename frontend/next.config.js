/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  reactStrictMode: true,
  env: {
    PLATFORM_BASE_URL: process.env.PLATFORM_BASE_URL || 'https://localhost:8443',
  },
};

module.exports = nextConfig;
