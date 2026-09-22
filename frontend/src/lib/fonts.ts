// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The app's two typefaces, self-hosted by `next/font`.
 *
 * Not a Google Fonts `@import`: that is a render-blocking third-party request,
 * and the app's own CSP (`style-src 'self'`, `font-src 'self' data:`) blocks
 * both the stylesheet and the font files anyway.
 *
 * `next/font` downloads the faces at build time and serves them from
 * `/_next/static/media`, which `'self'` allows — no third-party request and no
 * layout shift (the generated
 * `@font-face` carries size-adjust metrics for the fallbacks below).
 */

import { Fraunces, IBM_Plex_Sans } from 'next/font/google';

/** Body/UI face. Weights match what the design system actually uses.
 *  Exported because `next/font` loader results are module-level bindings the
 *  build-time transform resolves by name — not a dead export to trim. */
export const sans = IBM_Plex_Sans({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  display: 'swap',
  variable: '--pb-font-sans',
  fallback: ['ui-sans-serif', 'system-ui', '-apple-system', 'sans-serif'],
});

/** Display face, used for headings only. Exported for the same reason as
 *  `sans`. */
export const serif = Fraunces({
  subsets: ['latin'],
  weight: ['400', '600', '700'],
  display: 'swap',
  variable: '--pb-font-serif',
  fallback: ['ui-serif', 'Georgia', 'serif'],
});

/** Applied to <html> in `_document`, so globals.css can read the variables. */
export const fontClassNames = `${sans.variable} ${serif.variable}`;
