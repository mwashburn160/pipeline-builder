/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  reactStrictMode: true,

  // Do NOT ship browser source maps to clients (the default, made explicit):
  // they'd expose original source. If client-side error monitoring needs
  // symbolication, upload maps to the collector out-of-band rather than serving
  // them publicly. Server-side maps stay for prod stack traces (never served).
  productionBrowserSourceMaps: false,

  // Bundle optimization
  experimental: {
    optimizePackageImports: ['lucide-react', 'framer-motion'],
  },

  // Image optimization
  images: {
    formats: ['image/avif', 'image/webp'],
    minimumCacheTTL: 60,
  },

  async redirects() {
    // Old addresses of pages that moved. Each is ungated at its old address —
    // the destination page enforces its own read gate — so the forward happens
    // here, before any page code loads, instead of in a client-side shim page.
    // (/dashboard/settings/service-accounts is NOT here: it keeps a page so a
    // viewer without `service_accounts:manage` is told why rather than bounced.)
    // Destinations mirror `src/lib/security-links.ts`; `test/next-redirects.test.ts`
    // pins them together. Rules are first-match, so the `has` rules precede the
    // catch-all for the same source. A destination's own query wins over the
    // incoming one, so `?tab=tokens` becomes `?tab=keys` rather than surviving.
    return [
      // The "Groups" page was renamed to "Roles" (UI-facing only — the API still
      // speaks /groups).
      { source: '/dashboard/groups', destination: '/dashboard/roles', permanent: true },
      // The old "API Tokens" page is now three tabs of Security, per old tab.
      {
        source: '/dashboard/tokens',
        has: [{ type: 'query', key: 'tab', value: 'sessions' }],
        destination: '/dashboard/security?tab=sessions',
        permanent: true,
      },
      {
        source: '/dashboard/tokens',
        has: [{ type: 'query', key: 'tab', value: 'access' }],
        destination: '/dashboard/security?tab=sessions#current-token',
        permanent: true,
      },
      { source: '/dashboard/tokens', destination: '/dashboard/security?tab=keys', permanent: true },
      // The sysadmin cross-tenant destinations viewer became the "All
      // organizations" mode of the one destinations page. `?all=1` opens that
      // mode for sysadmins and is ignored for everyone else, so one static rule
      // serves both audiences.
      {
        source: '/dashboard/admin/alert-destinations',
        destination: '/dashboard/observability/alert-destinations?all=1',
        permanent: true,
      },
    ];
  },

  async rewrites() {
    // Client error reports post to a same-origin relay (pages/api/client-errors)
    // that forwards to the runtime ERROR_REPORT_URL collector. Exposed OUTSIDE
    // `/api/*` because nginx routes that namespace to the backend services.
    return [
      { source: '/client-errors', destination: '/api/client-errors' },
    ];
  },

  async headers() {
    // CSP for the Next.js app. `unsafe-inline` on scripts is required by
    // Next.js for its inline runtime bootstrap; `unsafe-eval` would NOT be
    // safe to add. `connect-src` includes `'self'` so same-origin /api
    // calls go through nginx; if you front the API on a separate hostname,
    // add it here explicitly. Error reports need no entry: they go through the
    // same-origin `/client-errors` relay, never straight to the collector.
    const csp = [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self' data:",
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "object-src 'none'",
    ].join('; ');

    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          // `publickey-credentials-*` are declared explicitly (their default is
          // already `self`) so a later tightening of this header cannot silently
          // disable passkey registration and sign-in.
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), publickey-credentials-get=(self), publickey-credentials-create=(self)' },
          { key: 'Content-Security-Policy', value: csp },
          // HSTS — 2 years, include subdomains, preload-list eligible.
          // Nginx terminates TLS so this header survives the proxy hop and
          // pins the browser to HTTPS for future visits.
          { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' },
        ],
      },
      {
        // Cache static assets aggressively
        source: '/_next/static/(.*)',
        headers: [
          { key: 'Cache-Control', value: 'public, max-age=31536000, immutable' },
        ],
      },
    ];
  },
};

const withBundleAnalyzer = process.env.ANALYZE === 'true'
  ? require('@next/bundle-analyzer')({ enabled: true })
  : (config) => config;

module.exports = withBundleAnalyzer(nextConfig);
