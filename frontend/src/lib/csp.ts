// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Content-Security-Policy for the Next.js app, built per request.
 *
 * Scripts are allowed by NONCE, not by `'unsafe-inline'`: `proxy.ts` mints a
 * fresh nonce for every document request, sends it in the CSP response header,
 * and forwards it to the renderer in the `x-nonce` request header, where
 * `_document` stamps it on every script Next emits (`<Head nonce>` /
 * `<NextScript nonce>`). `'strict-dynamic'` then lets those trusted scripts load
 * the rest of the chunk graph, so the build's hashed chunk names never have to be
 * listed. An injected `<script>` carries no nonce and does not run.
 *
 * A nonce only works on a response rendered for the request that minted it, so
 * every page is server-rendered (`App.getInitialProps` in `_app.tsx` opts the
 * whole app out of static optimization). A statically prerendered page would be
 * served with the build-time HTML — no nonce — and none of its scripts would run.
 *
 * The other directives are unchanged from the static policy this replaced.
 * `style-src` keeps `'unsafe-inline'`: React `style={…}` props and the
 * animation library write inline styles, and a style injection cannot run code.
 */
import type { IncomingMessage } from 'node:http';

/** Request header carrying the per-request nonce from the proxy to the renderer. */
export const NONCE_HEADER = 'x-nonce';

/** 128 random bits, base64 — the size the CSP spec recommends as a floor. */
export function generateNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

/**
 * The policy for one response. `dev` adds `'unsafe-eval'`, which React's
 * development build needs to rebuild server error stacks in the browser; the
 * production build never evaluates strings, so production never gets it.
 *
 * `'self'` stays in `script-src` beside the nonce as the fallback for browsers
 * that predate `'strict-dynamic'` (CSP3 browsers ignore host sources once
 * `'strict-dynamic'` is present).
 */
export function buildContentSecurityPolicy(nonce: string, { dev = false }: { dev?: boolean } = {}): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ''}`,
    // Explicit, because a worker otherwise falls back to `script-src`, where
    // `'strict-dynamic'` voids `'self'` — and `new Worker(url)` carries no nonce.
    // The proof-of-work solver (public/workers/) is the one worker.
    "worker-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    // `'self'` so same-origin /api calls go through nginx; a separately-hosted
    // API would be added here. Error reports use the same-origin
    // `/client-errors` relay, never the collector directly.
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
  ].join('; ');
}

/**
 * The nonce the proxy attached to this request, for server-side code that
 * renders an inline `<script>` (`_document`, `getServerSideProps`). Undefined
 * outside a request (build-time prerender) or when the proxy did not run.
 */
export function requestNonce(req: Pick<IncomingMessage, 'headers'> | undefined): string | undefined {
  const value = req?.headers?.[NONCE_HEADER];
  const nonce = Array.isArray(value) ? value[0] : value;
  // base64 alphabet only: the value is interpolated into an HTML attribute.
  return nonce && /^[A-Za-z0-9+/=]+$/.test(nonce) ? nonce : undefined;
}
