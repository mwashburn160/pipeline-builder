// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `/sitemap.xml` — the public plugin directory for crawlers: the directory
 * home, every category page and every listed plugin, as absolute URLs on the
 * deployment's own origin (`APP_SITE_URL`).
 *
 * Built from the same credential-free public API the pages use, so it can only
 * ever list public listings. 404s when the directory is turned off.
 */
import type { GetServerSideProps } from 'next';
import { resolveSiteUrl } from '@/lib/site-url';
import { PLUGIN_CATEGORIES } from '@/lib/plugin-categories';
import { getSitemapListings } from '@/lib/public-directory/api';
import { categoryPagePath, pluginPagePath } from '@/lib/public-directory/links';
import { PUBLIC_CACHE_CONTROL } from '@/lib/public-directory/server';
import { renderSitemap, type SitemapEntry } from '@/lib/public-directory/sitemap';

export const getServerSideProps: GetServerSideProps = async ({ res }) => {
  const siteUrl = resolveSiteUrl();
  const entries: SitemapEntry[] = [
    { loc: `${siteUrl}/plugins` },
    ...PLUGIN_CATEGORIES.map((c) => ({ loc: `${siteUrl}${categoryPagePath(c)}` })),
  ];

  const result = await getSitemapListings();
  if (!result.ok && result.notFound) return { notFound: true };
  if (!result.ok) {
    res.statusCode = 503;
    res.setHeader('Cache-Control', 'no-store');
    res.end();
    return { props: {} };
  }
  for (const item of result.data.entries) {
    entries.push({ loc: `${siteUrl}${pluginPagePath(item.publisher, item.name)}`, lastmod: item.updatedAt });
  }

  res.setHeader('Content-Type', 'application/xml; charset=utf-8');
  res.setHeader('Cache-Control', PUBLIC_CACHE_CONTROL);
  res.write(renderSitemap(entries));
  res.end();
  return { props: {} };
};

/** Never rendered: the response is written in `getServerSideProps`. */
export default function Sitemap() {
  return null;
}
