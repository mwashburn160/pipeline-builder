/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  reactStrictMode: true,
  env: {
    PLATFORM_URL: process.env.PLATFORM_URL || 'https://localhost:8443',
  },
};

module.exports = nextConfig;
