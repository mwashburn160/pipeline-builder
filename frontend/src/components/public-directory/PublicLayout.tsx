// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import Head from 'next/head';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { PublicHeader } from './PublicHeader';
import { PROJECT_REPO_URL } from '@/lib/public-directory/links';

interface SeoProps {
  title: string;
  description: string;
  /** Absolute canonical URL (built from the runtime site URL). */
  canonical: string;
  siteUrl: string;
  /** Pages that shouldn't be indexed (error states, deep result pages). */
  noindex?: boolean;
}

/** `<head>` for a directory page: title, description, canonical and OG/Twitter tags. */
export function DirectoryHead({ title, description, canonical, siteUrl, noindex }: SeoProps) {
  const fullTitle = `${title} · Pipeline Builder`;
  return (
    <Head>
      <title>{fullTitle}</title>
      <meta name="description" content={description} />
      <link rel="canonical" href={canonical} />
      {/* `follow`: the page is a view of an indexed one, and the plugin pages it
          links to must still be discovered through it. */}
      {noindex && <meta name="robots" content="noindex,follow" />}
      <meta property="og:title" content={fullTitle} />
      <meta property="og:description" content={description} />
      <meta property="og:type" content="website" />
      <meta property="og:url" content={canonical} />
      <meta property="og:image" content={`${siteUrl}/og-image.png`} />
      <meta name="twitter:card" content="summary_large_image" />
      <meta name="twitter:title" content={fullTitle} />
      <meta name="twitter:description" content={description} />
    </Head>
  );
}

/** Shell for every public directory page: skip link, header, main landmark, footer. */
export function PublicLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-canvas text-fg">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-2 focus:z-50 focus:rounded focus:bg-surface focus:px-3 focus:py-2"
      >
        Skip to content
      </a>
      <PublicHeader />
      <main id="main" className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
        {children}
      </main>
      <footer className="border-t border-default">
        <div className="mx-auto flex max-w-6xl flex-wrap gap-x-6 gap-y-2 px-4 py-6 text-xs text-fg-muted sm:px-6">
          <Link href="/plugins" className="hover:text-fg">Browse plugins</Link>
          <a href={`${PROJECT_REPO_URL}/tree/main/docs/plugins`} className="hover:text-fg" rel="noopener noreferrer">Plugin docs</a>
          <Link href="/" className="hover:text-fg">Pipeline Builder</Link>
        </div>
      </footer>
    </div>
  );
}
