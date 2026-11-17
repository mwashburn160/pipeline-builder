// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Next.js proxy (the Next 16 name for middleware; `middleware.ts` is deprecated
 * and warns at build): mints the per-request CSP nonce. See `src/lib/csp.ts`.
 *
 * The nonce goes two ways — into the `Content-Security-Policy` response header
 * the browser enforces, and into the `x-nonce` REQUEST header the page renderer
 * reads (`_document.getInitialProps`) to stamp the same value on its scripts.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { buildContentSecurityPolicy, generateNonce, NONCE_HEADER } from '@/lib/csp';

export function proxy(request: NextRequest): NextResponse {
  const nonce = generateNonce();
  const csp = buildContentSecurityPolicy(nonce, { dev: process.env.NODE_ENV === 'development' });

  const requestHeaders = new Headers(request.headers);
  // Overwrite, never trust: a client-sent x-nonce must not reach the renderer.
  requestHeaders.set(NONCE_HEADER, nonce);
  requestHeaders.set('Content-Security-Policy', csp);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set('Content-Security-Policy', csp);
  return response;
}

export const config = {
  matcher: [
    {
      // Documents only. Static chunks, the image optimizer, API routes and the
      // root icon files carry no scripts of their own, and the CSP of a JS file
      // response is never consulted. Link prefetches are skipped too: their
      // response is data, and a nonce minted for it would never be used.
      source: '/((?!api|_next/static|_next/image|favicon.ico|icon|apple-icon|plugin-icons).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
};
