// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The app's two typefaces, self-hosted by `next/font`.
 *
 * They used to arrive through `@import url('https://fonts.googleapis.com/…')`
 * at the top of globals.css, which meant two things — neither of them good.
 * First, a render-blocking request to a third party before any text could be
 * styled. Second, and worse, the app's own CSP (`style-src 'self'`,
 * `font-src 'self' data:`) BLOCKED both the stylesheet and the font files, so
 * that request bought nothing at all: every page has silently been rendering in
 * the fallback stack.
 *
 * `next/font` downloads the faces at build time and serves them from
 * `/_next/static/media`, which `'self'` allows — so the typography works for the
 * first time, with no third-party request and no layout shift (the generated
 * `@font-face` carries size-adjust metrics for the fallbacks below).
 */

import { Fraunces, IBM_Plex_Sans } from 'next/font/google';

/** Body/UI face. Weights match what the design system actually uses. */
export const sans = IBM_Plex_Sans({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  display: 'swap',
  variable: '--pb-font-sans',
  fallback: ['ui-sans-serif', 'system-ui', '-apple-system', 'sans-serif'],
});

/** Display face, used for headings only. */
export const serif = Fraunces({
  subsets: ['latin'],
  weight: ['400', '600', '700'],
  display: 'swap',
  variable: '--pb-font-serif',
  fallback: ['ui-serif', 'Georgia', 'serif'],
});

/** Applied to <html> in `_document`, so globals.css can read the variables. */
export const fontClassNames = `${sans.variable} ${serif.variable}`;
